"""Official Italian SYNOP/METAR and Hungarian ten-minute station observations.

Collect once per scheduled update, retain native UTC times and missing channels.
HungaroMet's latest file contains current rows plus corrections to earlier rows;
the shared publisher merges those into the existing 24-hour station history.
"""
import csv
import datetime as dt
import io
import json
import math
from pathlib import Path
import re
import urllib.parse
import zipfile

HU_BASE='https://odp.met.hu/weather/weather_reports/synoptic/hungary/10_minutes/'
HU_URL=HU_BASE+'csv/HABP_10M_SYNOP_LATEST.csv.zip'
METAR='https://aviationweather.gov/api/data/metar'
BOUNDS={'IT':(35.3,47.2,6.3,19),'HU':(45.7,48.7,16,23)}
SOURCES={'IT':'Official Italian SYNOP and airport METAR/SPECI observations via DWD and NOAA AWC',
         'HU':'HungaroMet / official ten-minute automatic station observations (provisional)'}
URLS={'IT':'https://opendata.dwd.de/weather/weather_reports/poi/','HU':HU_BASE}
PERIODS={'IT':'Official SYNOP: ten-minute mean wind at 10 m and maximum gust in the preceding hour. Airport METAR/SPECI: reported mean wind and gusts, with knots converted to m/s. The popup identifies the reporting network; missing gusts remain unavailable.',
         'HU':'HungaroMet: ten-minute mean wind (fs) and maximum two-second gust over ten minutes (fx), in m/s; instantaneous air temperature (t), in °C. Native UTC measurement times; operational data are provisional.'}

def number(raw,low,high):
    if isinstance(raw,bool) or raw is None:return None
    try:value=float(raw)
    except (ValueError,TypeError):return None
    return value if math.isfinite(value) and low<=value<=high else None

def location(country,lat,lon):
    s,n,w,e=BOUNDS[country]
    return number(lat,s,n) is not None and number(lon,w,e) is not None

def finalize(stations,now):
    end=int(now.timestamp());out=[]
    for s in stations.values():
        rows=[r for _,r in sorted(s['rows'].items()) if end-86400<=r[0]<=end+60 and any(v is not None for v in r[1:4])]
        if rows and rows[-1][0]>=end-2*3600:out.append({**s,'rows':rows})
    if not out:raise ValueError('No current official station observations')
    return out

def parse_hungary(raw,now):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        files=[f for f in archive.infolist() if re.fullmatch(r'HABP_10M_SYNOP_\d{14}\.csv',f.filename)]
        if len(files)!=1 or files[0].file_size>8*1024*1024:raise ValueError('Unexpected HungaroMet archive')
        text=archive.read(files[0]).decode('utf-8-sig')
    reader=csv.DictReader(io.StringIO(text),delimiter=';')
    reader.fieldnames=[k.strip() for k in reader.fieldnames or []]
    required={'Time','StationNumber','StationName','Latitude','Longitude','t','fs','fx','fsd'}
    if not required<=set(reader.fieldnames):raise ValueError('HungaroMet ten-minute columns changed')
    grouped={};end=int(now.timestamp())
    for r in reader:
        code=r['StationNumber'].strip()
        if not re.fullmatch(r'\d{5}',code):continue
        lat,lon=number(r['Latitude'],*BOUNDS['HU'][:2]),number(r['Longitude'],*BOUNDS['HU'][2:])
        if lat is None or lon is None:continue
        try:t=int(dt.datetime.strptime(r['Time'].strip(),'%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except (ValueError,TypeError):continue
        if not end-86400<=t<=end+60:continue
        row=[t,number(r['t'],-90,55),number(r['fs'],0,100),number(r['fx'],0,100),number(r['fsd'],0,360)]
        s=grouped.setdefault(code,dict(code=code,name=r['StationName'].strip(),lat=lat,lon=lon,rows={},
            identity=code,sourceName=SOURCES['HU'],gustLabel='Max 2-sec gust · 10 min',period=PERIODS['HU']))
        s['rows'][t]=row
    return finalize(grouped,now)

def parse_italian_metars(reports,metadata,now):
    if not isinstance(reports,list) or len(reports)>=400:raise ValueError('Italian METAR response missing or possibly truncated')
    grouped={};end=int(now.timestamp())
    for r in reports:
        if not isinstance(r,dict) or r.get('metarType') not in ('METAR','SPECI'):continue
        code=r.get('icaoId');m=metadata.get(code)
        if not m or m.get('country')!='IT' or not location('IT',m.get('lat'),m.get('lon')):continue
        t=number(r.get('obsTime'),end-2*3600,end+60)
        if t is None:continue
        speed,gust=number(r.get('wspd'),0,195),number(r.get('wgst'),0,195)
        direction=number(r.get('wdir'),0,360)
        row=[int(t),number(r.get('temp'),-90,55),None if speed is None else speed*1852/3600,
             None if gust is None else gust*1852/3600,direction]
        s=grouped.setdefault(code,dict(code='METAR-'+code,identity=code,name=m['name'],lat=m['lat'],lon=m['lon'],rows={},
            sourceName='Official Italian airport METAR/SPECI observations via NOAA Aviation Weather Center',
            gustLabel='Reported METAR gust',period='Official airport mean wind and explicitly reported METAR/SPECI gusts; knots converted to m/s. Gusts are not an hourly maximum. Native UTC report times; unreported gusts stay unavailable.'))
        s['rows'][int(t)]=row
    return finalize(grouped,now)

def load_italy(now,download):
    from europe_synop import collect,TEMP,SPEED,GUST,DIRECTION
    out=[]
    try:
        for code,m,rows in collect('IT',now,download,(TEMP,SPEED,GUST,DIRECTION)):
            out.append(dict(code='SYNOP-'+code,identity=m.get('icao') or code,name=m['name'],lat=m['lat'],lon=m['lon'],
                rows=[[t,v[TEMP],None if v[SPEED] is None else v[SPEED]/3.6,None if v[GUST] is None else v[GUST]/3.6,v[DIRECTION]] for t,v in rows],
                sourceName='Servizio Meteorologico dell’Aeronautica Militare / official SYNOP via DWD',
                gustLabel='Gust max · 1 hour',period='Ten-minute mean wind at 10 m and maximum gust over the preceding hour. Hourly UTC observations; km/h converted to m/s. Missing hourly gusts are not replaced by six-hour or daily maxima.'))
    except Exception as error:print('IT SYNOP unavailable:',str(error)[:140],flush=True)
    metadata=json.loads(Path(__file__).with_name('italy_airport_stations.json').read_text())['stations']
    codes=sorted(metadata)
    for start in range(0,len(codes),30):
        try:
            url=METAR+'?'+urllib.parse.urlencode(dict(ids=','.join(codes[start:start+30]),format='json',hours=2))
            out.extend(parse_italian_metars(json.loads(download(url)),metadata,now))
        except Exception as error:print('IT airport batch unavailable:',str(error)[:140],flush=True)
    if not out:raise ValueError('No current official Italian observations')
    return out

def load(country,now,download):
    if country=='HU':return parse_hungary(download(HU_URL),now)
    if country=='IT':return load_italy(now,download)
    raise ValueError('Unknown country')

def load_temperature(country,now,download):
    import update_official_temperature as core
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    out={};end=int(now.timestamp())
    for s in load(country,now,download):
        item=core.make_station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[1]) for r in s['rows']])
        if not item or item['rows'][-1][0]<end-2*3600:continue
        item['source']=s['sourceName']
        # Prefer SYNOP at a shared airport; do not put two numbers on one station.
        out.setdefault(s['identity'],item)
    if not out:raise ValueError('No current official '+country+' temperatures')
    return list(out.values())

def load_wind(country,now,download):
    import update_official_wind as core
    out={};end=int(now.timestamp())
    for s in load(country,now,download):
        item=core.station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[2],r[3],r[4]) for r in s['rows']])
        if not item['rows'] or item['rows'][-1][0]<end-2*3600:continue
        item.update(sourceName=s['sourceName'],gustLabel=s['gustLabel'],period=s['period'])
        out.setdefault(s['identity'],item)
    if not out:raise ValueError('No current official '+country+' wind measurements')
    return list(out.values())
