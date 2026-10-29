"""Italian/Croatian official SYNOP gauges and Slovenian ARSO rain histories.

Only complete measured intervals are combined. A wet daily bulletin that omits
dry stations is not used to manufacture zero-rain reports at omitted stations.
"""
import concurrent.futures as futures
import datetime as dt
import json
from pathlib import Path
import re
import urllib.parse
import xml.etree.ElementTree as ET

import update_rainfall as core
import rainfall_europe as europe

BOUNDS={'IT':(35.3,47.2,6.3,19),'HR':(42.2,46.7,13.1,19.5),'SI':(45.4,46.95,13.3,16.7)}
ARSO='https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/'
SOURCES={'IT':('Official Italian SYNOP rain gauges / Servizio Meteorologico dell’Aeronautica Militare via DWD',europe.POI),
         'HR':('DHMZ / official Croatian SYNOP rain gauges via DWD',europe.POI),
         'SI':('Vir: Agencija Republike Slovenije za okolje (ARSO) / automatic rain gauges',ARSO+'observationAms_si_latest.xml')}
PERIODS={
    **{c:'Official SYNOP measured precipitation in mm, with native UTC observation times. Reported 1-, 3-, 6-, 12- and 24-hour intervals are retained. Only complete, non-overlapping intervals form 24/48-hour totals. Some stations report only every three or six hours; actual ending times are shown. Missing hourly values are never inferred from longer totals. Coverage is the reporting SYNOP subset, not every national rain gauge.' for c in ('IT','HR')},
    'SI':'Vir: Agencija Republike Slovenije za okolje (ARSO). Automatic, provisional gauge precipitation in mm. Official one-hour accumulations are used at completed UTC clock hours; otherwise all six measured ten-minute intervals are required. Native 24-hour reports are retained at their actual ending times. Only complete adjacent intervals form 24/48-hour totals; missing, suspect and future readings stay unavailable. History is fetched centrally, not per visitor.'}

def location(country,lat,lon):
    try:lat,lon=float(lat),float(lon)
    except (ValueError,TypeError):return False
    s,n,w,e=BOUNDS[country]
    return s<=lat<=n and w<=lon<=e

def metadata(country):
    path=Path(__file__).with_name('croatia_synop_stations.json' if country=='HR' else 'europe_synop_stations.json')
    data=json.loads(path.read_text())['stations']
    return {k:{**v,'country':country} for k,v in data.items() if (country=='HR' or v.get('country')==country) and location(country,v.get('lat'),v.get('lon'))}

def load_synop(country,now,previous):
    catalogue=metadata(country)
    def collect(pair):
        code,meta=pair
        try:return europe.parse_synop(core.download(europe.POI+code+'-BEOB.csv',False),code,meta)
        except Exception as error:print(country,'rain gauge',code,'unavailable:',str(error)[:100],flush=True)
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        return europe.trimmed([s for s in pool.map(collect,catalogue.items()) if s],now)

def arso_root(raw):
    if len(raw)>12*1024*1024:raise ValueError('ARSO rain response too large')
    root=ET.fromstring(raw)
    if root.get('id')!='MeteoSI_WebMet_observationAms_xml':raise ValueError('Unexpected ARSO rain product')
    return root

def arso_metadata(raw):
    out={}
    for x in arso_root(raw).findall('metData'):
        code=x.findtext('domain_meteosiId') or ''
        lat,lon=x.findtext('domain_lat'),x.findtext('domain_lon')
        if (not re.fullmatch(r'[A-Z0-9_-]{1,80}',code) or not location('SI',lat,lon)
                or not (x.findtext('domain_meteosiType') or '').startswith('SI_RNSTATION')):continue
        if x.findtext('rr_var_unit')!='mm':continue
        out[code]=dict(name=x.findtext('domain_longTitle') or code,lat=float(lat),lon=float(lon))
    if not out or len(out)>250:raise ValueError('ARSO rain gauge catalogue missing/oversized')
    return out

def arso_time(text):
    return int(dt.datetime.strptime(text,'%d.%m.%Y %H:%M UTC').replace(tzinfo=dt.timezone.utc).timestamp())

def arso_field(x,value,state,unit):
    if x.findtext(state)!='0':return None
    if x.findtext(unit)!='mm':raise ValueError('ARSO precipitation units changed')
    return core.amount(x.findtext(value))

def parse_slovenia(raw,code,meta,now):
    root=arso_root(raw);samples={};hourly={};periods={};end=int(now.timestamp())
    records=root.findall('metData')
    if len(records)>500:raise ValueError('ARSO rain history exceeds expected two-day window')
    for x in records:
        if x.findtext('domain_meteosiId')!=code:raise ValueError('ARSO rain station identity changed')
        if not location('SI',x.findtext('domain_lat'),x.findtext('domain_lon')):continue
        # Metadata and history must describe the same physical gauge.
        if abs(float(x.findtext('domain_lat'))-meta['lat'])>.005 or abs(float(x.findtext('domain_lon'))-meta['lon'])>.005:raise ValueError('ARSO rain station moved')
        try:t=arso_time(x.findtext('valid_UTC'));start=arso_time(x.findtext('validStart'));stop=arso_time(x.findtext('validEnd'))
        except (ValueError,TypeError):continue
        if stop!=t or not end-72*3600<=t<=end:continue
        if t%3600==0:
            v=arso_field(x,'tp_1h_acc','tp_1h_acc_state','tp_1h_acc_var_unit')
            if v is not None:hourly[t]=v
            v=arso_field(x,'tp_24h_acc','tp_24h_acc_state','tp_24h_acc_var_unit')
            if v is not None:periods[t]={'end':t,'hours':24,'value':v}
        if stop-start==600:
            v=arso_field(x,'rr_val','rr_state','rr_var_unit')
            if v is not None:samples[t]=v
    for t,v,_ in europe.complete_hours(samples.items(),600):hourly.setdefault(t,v)
    s=core.station('SI',code,meta['name'],meta['lat'],meta['lon'],[(t,v,False) for t,v in hourly.items()])
    s['periods']=[periods[t] for t in sorted(periods)]
    return s

def load_slovenia(now,previous):
    raw=core.download(ARSO+'observationAms_si_latest.xml',False);catalogue=arso_metadata(raw)
    latest={x.findtext('domain_meteosiId'):x for x in arso_root(raw).findall('metData')}
    prior={s['code']:s for s in previous if s['country']=='SI'};end=int(now.timestamp())//3600*3600
    def collect(pair):
        code,meta=pair
        # Reuse a complete clock hour between fifteen-minute collection cycles.
        # On a new hour or incomplete history, fetch the rolling two-day file.
        old=prior.get(code);out=[]
        try:
            wrap=ET.Element('data',id='MeteoSI_WebMet_observationAms_xml');wrap.append(latest[code])
            current=parse_slovenia(ET.tostring(wrap),code,meta,now);out.append(current)
            have_hour=end in current['times'] or (old is not None and end in old['times'])
            if not have_hour or old is None:
                name='observationAms_'+code.rstrip('_')+'_history.xml'
                out.append(parse_slovenia(core.download(ARSO+'recent/'+urllib.parse.quote(name),False),code,meta,now))
        except Exception as error:print('SI rain gauge',code,'unavailable:',str(error)[:100],flush=True)
        return out
    with futures.ThreadPoolExecutor(max_workers=5) as pool:
        return europe.trimmed([s for rows in pool.map(collect,catalogue.items()) for s in rows],now)

def install(target):
    target.SOURCES.update(SOURCES)
    target.LOADERS.update({c:(lambda now,previous,c=c:load_synop(c,now,previous)) for c in ('IT','HR')})
    target.LOADERS['SI']=load_slovenia
