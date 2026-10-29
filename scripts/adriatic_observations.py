"""Official Croatian DHMZ/SYNOP and Slovenian ARSO station measurements.

No forecasts, daily maxima or Beaufort conversions are used as current gusts.
ARSO's interval mean and interval maximum retain the native ten-minute end time.
"""
import concurrent.futures as futures
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import urllib.parse
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

BOUNDS={'HR':(42.2,46.7,13.1,19.5),'SI':(45.4,46.95,13.3,16.7)}
URLS={'HR':'https://vrijeme.hr/hrvatska_n.xml',
      'SI':'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_si_latest.xml'}
SOURCES={'HR':'DHMZ / Croatian Meteorological and Hydrological Service; official SYNOP and airport reports via DWD / NOAA AWC',
         'SI':'Agencija Republike Slovenije za okolje (ARSO) / automatic station measurements (provisional)'}
PERIODS={'HR':'DHMZ published hourly temperature and wind. SYNOP: ten-minute mean wind and maximum gust in the preceding hour when reported. Airport METAR/SPECI gusts are explicitly reported gusts, not hourly maxima. Missing gusts remain unavailable.',
         'SI':'ARSO ten-minute mean wind (ffavg_val), maximum wind gust over the same ten-minute interval (ffmax_val), mean direction and instantaneous air temperature (t). Native UTC interval-end times; automatic, provisional measurements.'}

def number(raw,low,high):
    if raw is None or isinstance(raw,bool):return None
    try:v=float(str(raw).strip().replace(',','.'))
    except (TypeError,ValueError):return None
    return v if math.isfinite(v) and low<=v<=high else None

def within(country,lat,lon):
    s,n,w,e=BOUNDS[country]
    return number(lat,s,n) is not None and number(lon,w,e) is not None

def utc(raw):
    return int(dt.datetime.strptime(raw,'%d.%m.%Y %H:%M UTC').replace(tzinfo=dt.timezone.utc).timestamp())

def current(stations,now):
    end=int(now.timestamp());out=[]
    for s in stations:
        rows=[r for r in s['rows'] if end-86400<=r[0]<=end+60 and any(v is not None for v in r[1:4])]
        if rows and max(r[0] for r in rows)>=end-2*3600:out.append({**s,'rows':sorted(rows)})
    if not out:raise ValueError('No recent official Adriatic observations')
    return out

def parse_slovenia(raw,now):
    root=ET.fromstring(raw)
    if root.get('id')!='MeteoSI_WebMet_observationAms_xml':raise ValueError('Unexpected ARSO observation product')
    out=[]
    for x in root.findall('metData'):
        code=x.findtext('domain_meteosiId');lat=number(x.findtext('domain_lat'),*BOUNDS['SI'][:2]);lon=number(x.findtext('domain_lon'),*BOUNDS['SI'][2:])
        if not code or lat is None or lon is None or not (x.findtext('domain_meteosiType') or '').startswith('SI_RNSTATION'):continue
        try:
            end=utc(x.findtext('valid_UTC'));start=utc(x.findtext('validStart'));stop=utc(x.findtext('validEnd'))
        except (ValueError,TypeError):continue
        if stop!=end or stop-start!=600:continue
        def field(tag,state,unit,expected,low,high):
            # Only explicitly normal values are accepted; missing/suspect states
            # cannot turn into apparent calm winds or zero temperature.
            if x.findtext(state)!='0':return None
            if x.findtext(unit)!=expected:raise ValueError('ARSO '+tag+' units changed')
            return number(x.findtext(tag),low,high)
        row=[end,field('t','t_state','t_var_unit','°C',-90,55),
             field('ffavg_val','ffavg_state','ffavg_var_unit','m/s',0,100),
             field('ffmax_val','ffmax_state','ffmax_var_unit','m/s',0,100),
             field('ddavg_val','ddavg_state','ddavg_var_unit','°',0,360)]
        out.append(dict(code=code,name=x.findtext('domain_longTitle') or code,lat=lat,lon=lon,rows=[row],
                        sourceName=SOURCES['SI'],sourceUrl=URLS['SI'],gustLabel='Gust max · 10 min',period=PERIODS['SI']))
    return current(out,now)

def parse_croatia(raw,now):
    root=ET.fromstring(raw)
    if root.tag!='Hrvatska':raise ValueError('Unexpected DHMZ product')
    date=root.findtext('DatumTermin/Datum');hour=root.findtext('DatumTermin/Termin')
    local=dt.datetime.strptime(date+' '+hour,'%d.%m.%Y %H')
    zone=ZoneInfo('Europe/Zagreb')
    # A local hour repeated at autumn DST is ambiguous: rely on UTC SYNOP
    # instead of assigning a guessed observation time.
    if local.replace(tzinfo=zone,fold=0).utcoffset()!=local.replace(tzinfo=zone,fold=1).utcoffset():raise ValueError('Ambiguous DHMZ local observation hour')
    stamp=int(local.replace(tzinfo=zone).timestamp());out=[]
    compass={name:i*22.5 for i,name in enumerate(('N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'))}
    for x in root.findall('Grad'):
        name=(x.findtext('GradIme') or '').strip();lat=number(x.findtext('Lat'),*BOUNDS['HR'][:2]);lon=number(x.findtext('Lon'),*BOUNDS['HR'][2:])
        if not name or lat is None or lon is None:continue
        v=x.find('Podatci')
        if v is None:continue
        code='DHMZ-'+hashlib.sha256((name+'|'+str(lat)+'|'+str(lon)).encode()).hexdigest()[:16]
        out.append(dict(code=code,name=name,lat=lat,lon=lon,rows=[[stamp,number(v.findtext('Temp'),-90,55),number(v.findtext('VjetarBrzina'),0,100),None,compass.get((v.findtext('VjetarSmjer') or '').strip())]],
            sourceName='DHMZ / Croatian Meteorological and Hydrological Service',sourceUrl=URLS['HR'],gustLabel='Gust not supplied',
            period='Published hourly DHMZ wind in m/s and air temperature in °C. Local Croatian observation hour converted to UTC. This feed supplies no gusts; missing gusts stay unavailable.'))
    return current(out,now)

def croatian_synop(now,download):
    from europe_synop import parse,POI,TEMP,SPEED,GUST,DIRECTION
    metadata=json.loads(Path(__file__).with_name('croatia_synop_stations.json').read_text())['stations']
    def one(pair):
        code,m=pair
        try:
            rows=parse(download(POI+code+'-BEOB.csv'),code,(TEMP,SPEED,GUST,DIRECTION))
            return current([dict(code='SYNOP-'+code,name=m['name'],lat=m['lat'],lon=m['lon'],
                rows=[[t,v[TEMP],None if v[SPEED] is None else v[SPEED]/3.6,None if v[GUST] is None else v[GUST]/3.6,v[DIRECTION]] for t,v in rows],
                sourceName='DHMZ / official Croatian SYNOP observations distributed by DWD',sourceUrl=POI+code+'-BEOB.csv',
                gustLabel='Gust max · 1 hour',period='Ten-minute mean wind at 10 m and maximum gust over the preceding hour, km/h converted to m/s. Native UTC report times; missing hourly gusts are never replaced by six-hour or daily maxima.')],now)[0]
        except Exception as e:print('HR SYNOP',code,'unavailable:',str(e)[:120],flush=True)
    with futures.ThreadPoolExecutor(max_workers=4) as pool:out=[s for s in pool.map(one,metadata.items()) if s]
    return out,metadata

def croatian_metars(payload,metadata,now):
    if not isinstance(payload,list) or len(payload)>=400:raise ValueError('Invalid Croatian METAR response')
    by_icao={m['icao']:m for m in metadata.values() if m.get('icao')};grouped={}
    for r in payload:
        m=by_icao.get(r.get('icaoId'))
        if not m or r.get('metarType') not in ('METAR','SPECI'):continue
        t=number(r.get('obsTime'),int(now.timestamp())-7200,int(now.timestamp())+60)
        if t is None:continue
        speed=number(r.get('wspd'),0,194);gust=number(r.get('wgst'),0,194)
        code='METAR-'+r['icaoId'];s=grouped.setdefault(code,dict(code=code,name=m['name'],lat=m['lat'],lon=m['lon'],rows=[],
            sourceName='Official Croatian airport METAR/SPECI via NOAA Aviation Weather Center',sourceUrl='https://aviationweather.gov/data/metar/',gustLabel='Reported METAR gust',
            period='Official airport mean wind and explicitly reported METAR/SPECI gusts; knots converted to m/s. Gusts are not hourly maxima. Unreported gusts remain unavailable.'))
        s['rows'].append([int(t),number(r.get('temp'),-90,55),None if speed is None else speed*1852/3600,None if gust is None else gust*1852/3600,number(r.get('wdir'),0,360)])
    return list(grouped.values())

def load(country,now,download):
    if country=='SI':return parse_slovenia(download(URLS['SI']),now)
    if country!='HR':raise ValueError('Unknown country')
    synop,metadata=croatian_synop(now,download);direct=[];airports=[]
    try:direct=parse_croatia(download(URLS['HR']),now)
    except Exception as e:print('DHMZ XML unavailable:',str(e)[:120],flush=True)
    try:
        codes=','.join(m['icao'] for m in metadata.values() if m.get('icao'))
        airports=croatian_metars(json.loads(download('https://aviationweather.gov/api/data/metar?'+urllib.parse.urlencode(dict(ids=codes,format='json',hours=2)))),metadata,now)
    except Exception as e:print('HR airport observations unavailable:',str(e)[:120],flush=True)
    # One reporting network per physical site. Prefer airport reports when
    # available, preserving their explicitly reported gusts and fresh times.
    out=[]
    for s in airports+synop+direct:
        if not any((s['lat']-p['lat'])**2+((s['lon']-p['lon'])*math.cos(math.radians(s['lat'])))**2 < (.025)**2 for p in out):out.append(s)
    return current(out,now)

def load_temperature(country,now,download):
    import update_official_temperature as core
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES);out=[]
    for s in load(country,now,download):
        item=core.make_station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[1]) for r in s['rows']])
        if item:item['source']=s['sourceName'];out.append(item)
    if not out:raise ValueError('No official '+country+' temperatures')
    return out

def load_wind(country,now,download):
    import update_official_wind as core
    out=[]
    for s in load(country,now,download):
        item=core.station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[2],r[3],r[4]) for r in s['rows']])
        if item['rows']:
            item.update({k:s[k] for k in ('sourceName','sourceUrl','gustLabel','period')});out.append(item)
    if not out:raise ValueError('No official '+country+' wind measurements')
    return out
