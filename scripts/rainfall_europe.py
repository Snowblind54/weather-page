"""Official European gauge rainfall; native intervals never stand in for missing hours.

SYNOP reports are national observations distributed by DWD, not forecasts.
All internal times are UTC interval ends and all amounts are millimetres.
"""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib
import re
import urllib.parse

import update_rainfall as core
from update_central_temperature import chmi_table, chmi_metadata
from update_western_temperature import knmi_metadata

POI = 'https://opendata.dwd.de/weather/weather_reports/poi/'
IRELAND = 'https://opendata2.met.ie/edr/collections/observations-swob-nrt-60min/'
KNMI = 'https://www.daggegevens.knmi.nl/klimatologie/uurgegevens?'
RMI = 'https://opendata.meteo.be/service/aws/ows?'
CHMI = 'https://opendata.chmi.cz/meteorology/climate/'
SOURCE_INFO = {
    'GB': ('Met Office SYNOP observations distributed by DWD', POI),
    'PL': ('IMGW-PIB SYNOP observations distributed by DWD', POI),
    'DE': ('Deutscher Wetterdienst / official SYNOP gauges', POI),
    'SK': ('SHMÚ SYNOP observations distributed by DWD', POI),
    'LU': ('MeteoLux / Luxembourg-Findel SYNOP observations distributed by DWD', POI),
    'IE': ('Met Éireann / official hourly rain gauges', IRELAND),
    'NL': ('KNMI / hourly precipitation and official SYNOP gauges', KNMI),
    'BE': ('Royal Meteorological Institute / RMI-KMI gauges', 'https://opendata.meteo.be/documentation/?dataset=aws'),
    'CZ': ('Czech Hydrometeorological Institute / ČHMÚ', CHMI+'now/'),
}
POI_COLUMNS = {1:'precipitation_amount_last_hour', 3:'precipitation_amount_last_3_hours',
               6:'precipitation_amount_last_6_hours', 12:'precipitation_last_12_hours',
               24:'precipitation_amount_last_24_hours'}


def stamp(value):
    try:
        return core.unix(value)
    except (ValueError, TypeError, OverflowError):
        return None


def trimmed(stations, now):
    end = int(now.timestamp())
    for s in stations:
        rows = [(t,v) for t,v in zip(s['times'],s['amounts']) if end-72*3600 <= t <= end]
        s['times'],s['amounts'] = [t for t,v in rows],[v for t,v in rows]
        s['traces'] = [t for t in s.get('traces',[]) if t in s['times']]
        if 'periods' in s:
            s['periods'] = [p for p in s['periods'] if end-72*3600 <= p['end'] <= end]
    return [s for s in stations if s['times'] or s.get('periods')]


def parse_synop(raw, code, meta):
    rows = list(csv.reader(io.StringIO(raw.decode('latin1') if isinstance(raw, bytes) else raw), delimiter=';'))
    if len(rows)<3 or not set(POI_COLUMNS.values()) <= set(rows[0]):
        raise ValueError('DWD SYNOP precipitation columns changed')
    indices = {hours:rows[0].index(name) for hours,name in POI_COLUMNS.items()}
    if rows[1][0] != code or any(rows[1][i] != 'mm' for i in indices.values()):
        raise ValueError('DWD SYNOP station or precipitation units changed')
    hourly,periods = [],[]
    for row in rows[3:]:
        if len(row)<=max(indices.values()):continue
        try:
            end=int(dt.datetime.strptime(row[0]+' '+row[1],'%d.%m.%y %H:%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except ValueError:continue
        if end%3600:continue
        for hours,i in indices.items():
            value=core.amount(row[i].replace(',','.'))
            if value is None:continue
            if hours==1:hourly.append((end,value,False))
            else:periods.append({'end':end,'hours':hours,'value':value})
    s=core.station(meta['country'],code,meta['name'],meta['lat'],meta['lon'],hourly)
    s['periods']=periods
    return s


def load_synop(country,now,previous):
    metadata=json.loads(pathlib.Path(__file__).with_name('rainfall_synop_stations.json').read_text())['stations']
    targets=[(code,s) for code,s in metadata.items() if s['country']==country]
    def collect(pair):
        code,meta=pair
        try:return parse_synop(core.download(POI+code+'-BEOB.csv',False),code,meta)
        except Exception as error:
            print(country,'rain gauge',code,'unavailable:',str(error)[:120],flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        return trimmed([s for s in pool.map(collect,targets) if s],now)


def parse_ireland(features,metadata):
    groups={}
    for feature in features:
        p=feature.get('properties') or {}
        code=str(p.get('station_id',''))
        if code not in metadata or p.get('parameter_name')!='precipitation_amount':continue
        end=stamp(p.get('observed_at'))
        if end is None or end%3600:continue
        # Event-driven tips are another parameter and are deliberately excluded.
        groups.setdefault(code,[]).append((end,p.get('value_num'),False))
    out=[]
    for code,rows in groups.items():
        f=metadata[code];coords=f['geometry']['coordinates'];p=f['properties']
        out.append(core.station('IE',code,p.get('station_name') or code,coords[1],coords[0],rows))
    return out


def load_ireland(now,previous):
    definitions=core.download(IRELAND.rstrip('/')+'?f=json').get('parameter_names',{})
    if definitions.get('precipitation_amount',{}).get('unit',{}).get('symbol')!='mm':
        raise ValueError('Irish hourly precipitation units changed')
    locations=core.download(IRELAND+'locations?f=json')
    metadata={str(f['properties']['station_id']):f for f in locations.get('features',[]) if f.get('geometry',{}).get('type')=='Point'}
    params={'datetime':(now-dt.timedelta(hours=72)).isoformat()+'/'+now.isoformat(),
            'parameter-name':'precipitation_amount','f':'geojson','limit':10000}
    observations=[]
    for page in range(3):
        p=core.download(IRELAND+'items?'+urllib.parse.urlencode(params|{'offset':page*10000}))
        rows=p.get('features') or [];observations.extend(rows)
        if len(rows)<10000:return trimmed(parse_ireland(observations,metadata),now)
    raise ValueError('Irish precipitation response exceeded bounded window')


def parse_netherlands(raw):
    text=raw.decode('utf-8-sig') if isinstance(raw,bytes) else raw
    metadata={s['code']:s for s in knmi_metadata(text).values()}
    lines=text.splitlines()
    if not any(re.search(r'RH\s*[:=].*0\.1 mm',line) for line in lines):
        raise ValueError('KNMI hourly precipitation units missing')
    header=next((line.lstrip('# ').strip() for line in lines if re.match(r'^#\s*STN,\s*YYYYMMDD,\s*HH,',line)),None)
    if not header or header.replace(' ','').split(',')!=['STN','YYYYMMDD','HH','RH']:
        raise ValueError('KNMI hourly precipitation columns changed')
    grouped={}
    for row in csv.reader(line for line in lines if line and not line.startswith('#')):
        if len(row)!=4:continue
        code,date,hour,value=[v.strip() for v in row]
        if code not in metadata or not re.fullmatch(r'\d{8}',date):continue
        try:
            hour=int(hour)
            if not 1<=hour<=24:continue
            end=int((dt.datetime.strptime(date,'%Y%m%d').replace(tzinfo=dt.timezone.utc)+dt.timedelta(hours=hour)).timestamp())
        except ValueError:continue
        trace=value=='-1'
        n=0 if trace else core.amount(value)
        if n is not None:grouped.setdefault(code,[]).append((end,n/10,trace))
    return [core.station('NL',code,metadata[code]['name'],metadata[code]['lat'],metadata[code]['lon'],rows) for code,rows in grouped.items()]


def load_netherlands(now,previous):
    # The validated hourly archive can lag by several days. Supplement it with
    # current KNMI SYNOP reports, using the same national station IDs.
    hourly,current=[],[]
    params={'stns':'ALL','vars':'RH','start':(now-dt.timedelta(days=3)).strftime('%Y%m%d')+'01','end':now.strftime('%Y%m%d')+'24'}
    try:hourly=trimmed(parse_netherlands(core.download(KNMI+urllib.parse.urlencode(params),False)),now)
    except Exception as error:print('NL hourly archive unavailable:',str(error)[:120],flush=True)
    try:current=load_synop('NL',now,previous)
    except Exception as error:print('NL current SYNOP unavailable:',str(error)[:120],flush=True)
    metadata={s['code']:s for s in hourly}
    for s in current:
        # WMO 06260 is KNMI 260 (De Bilt), not a second colocated gauge.
        s['code']=str(int(s['code'])-6000)
        if s['code'] in metadata:
            s.update({k:metadata[s['code']][k] for k in ('name','lat','lon')})
    if not hourly and not current:raise ValueError('No Dutch hourly or SYNOP rainfall observations')
    return current+hourly


def complete_hours(samples,step):
    """Aggregate only an exact, complete clock hour; never fill lost intervals."""
    grouped={}
    for end,value in samples:
        end=stamp(end);value=core.amount(value)
        if end is None or end%step or value is None:continue
        hour=((end-1)//3600+1)*3600
        grouped.setdefault(hour,{})[end]=value
    out=[]
    for hour,rows in grouped.items():
        expected=[hour-i*step for i in range(3600//step)]
        if all(t in rows for t in expected):out.append((hour,round(sum(rows[t] for t in expected),4),False))
    return out


def rmi_features(kind,**params):
    query={'service':'WFS','version':'2.0.0','request':'GetFeature','typeNames':'aws:'+kind,
           'outputFormat':'application/json','srsName':'EPSG:4326','count':10000,**params}
    p=core.download(RMI+urllib.parse.urlencode(query))
    rows=p.get('features')
    if not isinstance(rows,list) or len(rows)>=10000:raise ValueError('RMI rainfall response truncated')
    return rows


def parse_belgium(features,metadata):
    stations={str(f['properties']['code']):f for f in metadata if not f['properties'].get('date_end')}
    groups={}
    for f in features:
        p=f.get('properties') or {};code=str(p.get('code',''))
        if code not in stations:continue
        groups.setdefault(code,[]).append((p.get('timestamp'),p.get('precip_quantity')))
    out=[]
    for code,rows in groups.items():
        f=stations[code];coords=f['geometry']['coordinates']
        out.append(core.station('BE',code,f['properties'].get('name') or code,coords[1],coords[0],complete_hours(rows,600)))
    return out


def load_belgium(now,previous):
    start,end=[(now-dt.timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ') for h in (72,0)]
    return trimmed(parse_belgium(rmi_features('aws_10min',CQL_FILTER=f"timestamp > '{start}' AND timestamp <= '{end}'"),rmi_features('aws_station')),now)


def parse_czechia(payload,code,meta):
    rows=[]
    for r in chmi_table(payload):
        if r.get('STATION')!=code or r.get('ELEMENT')!='SRA1H' or isinstance(r.get('QUALITY'),bool) or r.get('QUALITY') not in (0,5):continue
        end=stamp(r.get('DT'))
        if end is not None:rows.append((end,r.get('VAL'),False))
    return core.station('CZ',code,meta['name'],meta['lat'],meta['lon'],rows)


def load_czechia(now,previous):
    today=now.strftime('%Y%m%d')
    meta=chmi_metadata(core.download(CHMI+'now/metadata/meta1-'+today+'.json'))
    elements=chmi_table(core.download(CHMI+'now/metadata/meta2-'+today+'.json'))
    measured={r['WSI'] for r in elements if r.get('OBS_TYPE')=='1H' and r.get('EG_EL_ABBREVIATION')=='SRA1H' and r.get('UN_DESCRIPTION')=='mm'}
    current=core.download(CHMI+'now/data/',False).decode('utf8')
    prior={s['code']:s for s in previous if s['country']=='CZ'}
    needs_codes={code for code in measured if code in meta and (code not in prior or not prior[code]['times'] or prior[code]['times'][0]>int(now.timestamp())-48*3600)}
    needs_history=bool(needs_codes)
    recent=core.download(CHMI+'recent/data/1hour/',False).decode('utf8') if needs_history else ''
    days={(now-dt.timedelta(days=i)).strftime('%Y%m%d') for i in range(4 if needs_history else 2)}
    targets={}
    for directory,listing in [('recent/data/1hour/',recent),('now/data/',current)]:
        for name,code,day in re.findall(r'href="(1h-([\w-]+)-(\d{8})\.json)"',listing):
            if code in meta and code in measured and day in days and (directory.startswith('now/') or code in needs_codes):
                targets[(code,day)]=(directory+name,code)
    if not targets or len(targets)>2000:raise ValueError('Czech hourly precipitation archive missing or oversized')
    def collect(target):
        path,code=target
        try:return parse_czechia(core.download(CHMI+path),code,meta[code])
        except Exception as error:
            print('CZ rain gauge',code,'unavailable:',str(error)[:120],flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        return trimmed([s for s in pool.map(collect,targets.values()) if s],now)


def complete_total(hourly,periods,end,hours):
    """Tile the exact window with non-overlapping measured intervals."""
    start=end-hours*3600
    edges={}
    for t,value in hourly.items():edges.setdefault(t,{})[1]=value
    for p in periods:edges.setdefault(p['end'],{})[p['hours']]=p['value']
    memo={start:0.0}
    def total(t):
        if t in memo:return memo[t]
        memo[t]=None
        for h,value in sorted(edges.get(t,{}).items(),reverse=True):
            prev=t-h*3600
            if prev<start:continue
            before=total(prev)
            if before is not None:
                memo[t]=round(before+value,4);break
        return memo[t]
    return total(end)


def derived_totals(station):
    periods=station.get('periods',[])
    hourly=dict(zip(station['times'],station['amounts']))
    ends=sorted(set(hourly)|{p['end'] for p in periods})
    return [{'end':end,'hours':hours,'value':value} for end in ends for hours in (24,48)
            if (value:=complete_total(hourly,periods,end,hours)) is not None and core.amount(value) is not None]


PERIODS={
    **{c:'National SYNOP precipitation: reported 1-, 3-, 6-, 12- and 24-hour intervals, with UTC observation times. Only complete, non-overlapping intervals form longer totals; missing intervals stay unavailable. Reporting frequency varies by station.' for c in ('GB','PL','DE','SK')},
    'LU':'Luxembourg-Findel SYNOP gauge. Currently reports 6- and 12-hour precipitation; 24 and 48 hours require complete adjacent intervals. No hourly total is inferred from these longer reports.',
    'IE':'Met Éireann total hourly rainfall in mm, excluding event-driven tips. Complete measured hours are required for longer totals.',
    'NL':'KNMI RH hourly archive in 0.1 mm, converted to mm, supplemented with current KNMI SYNOP precipitation distributed by DWD. Identical station IDs are merged. Hour 24 ends at midnight UTC; traces below 0.05 mm are flagged. Native longer intervals are retained without inventing hourly totals.',
    'BE':'RMI/KMI precipitation in mm for each ten-minute interval. All six samples are required for a completed clock hour; near-real-time observations are provisional.',
    'CZ':'ČHMÚ SRA1H hourly precipitation in mm with UTC observation times. Quality 0 and provisional 5 accepted; suspect, estimated and missing observations excluded.'
}

def install(target=None):
    target = target or core
    target.SOURCES.update(SOURCE_INFO)
    target.LOADERS.update({c:(lambda now,previous,c=c:load_synop(c,now,previous)) for c in ('GB','PL','DE','SK','LU')})
    target.LOADERS.update({'IE':load_ireland,'NL':load_netherlands,'BE':load_belgium,'CZ':load_czechia})
