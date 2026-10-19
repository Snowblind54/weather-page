"""Official Czech, Slovak and Luxembourg measured air temperatures."""
import concurrent.futures as futures
import datetime as dt
import json
import re

import update_official_temperature as core
from update_western_temperature import download, recent_stations, temperature

CHMI='https://opendata.chmi.cz/meteorology/climate/now/'
METEOLUX='https://metapi.ana.lu/api/v1/hvd/'
SHMU='https://www.shmu.sk/api/v1/meteo/getweathergeojson'


def chmi_table(payload):
    table=payload.get('data',{}).get('data',{})
    header=table.get('header','').split(',')
    rows=table.get('values')
    if not isinstance(rows,list) or not header:
        raise ValueError('Invalid CHMI table')
    return [dict(zip(header,row)) for row in rows if isinstance(row,list) and len(row)==len(header)]


def chmi_metadata(payload):
    out={}
    for row in chmi_table(payload):
        try:lat,lon=float(row['GEOGR2']),float(row['GEOGR1'])
        except (KeyError,TypeError,ValueError):continue
        if (48.5<=lat<=51.1 and 12<=lon<=18.9 and row.get('WSI')
                and not str(row.get('GH_ID','')).startswith('Z')):
            out[row['WSI']]={'name':row.get('FULL_NAME') or row['WSI'],'lat':lat,'lon':lon}
    if not out:raise ValueError('No Czech station metadata')
    return out


def chmi_station(payload,code,meta):
    rows=[]
    for row in chmi_table(payload):
        # T is air temperature; soil, ground frost and daily extrema differ.
        if row.get('STATION')!=code or row.get('ELEMENT')!='T' or row.get('QUALITY') not in (0,5):continue
        value=temperature(row.get('VAL'))
        if value is not None:rows.append((row.get('DT'),value))
    return core.make_station('CZ',code,meta['name'],meta['lat'],meta['lon'],rows)


def parse_czechia():
    now=dt.datetime.now(dt.timezone.utc)
    date=now.strftime('%Y%m%d')
    metadata=chmi_metadata(json.loads(download(CHMI+'metadata/meta1-'+date+'.json')))
    elements=chmi_table(json.loads(download(CHMI+'metadata/meta2-'+date+'.json')))
    measured={row['WSI'] for row in elements if row.get('OBS_TYPE')=='10M' and row.get('EG_EL_ABBREVIATION')=='T'}
    listing=download(CHMI+'data/').decode('utf-8')
    dates={date}
    if now.hour<2:dates.add((now-dt.timedelta(days=1)).strftime('%Y%m%d'))
    targets=[(name,code) for name,code,day in re.findall(r'href="(10m-([\w-]+)-(\d{8})\.json)"',listing)
             if day in dates and code in metadata and code in measured]
    if not targets or len(targets)>1600:raise ValueError('No current Czech observation files')
    def station(target):
        name,code=target
        try:return chmi_station(json.loads(download(CHMI+'data/'+name,timeout=25)),code,metadata[code])
        except Exception as error:
            print('CHMI station unavailable:',code,type(error).__name__,flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        stations=list(pool.map(station,targets))
    return recent_stations(stations)


def meteolux_station(observations,metadata):
    station=metadata.get('data') or {}
    if station.get('id')!='LUX0000001':raise ValueError('Unexpected MeteoLux station')
    values=[row.get('value') for row in observations.get('data',[]) if row.get('id')=='st']
    if len(values)!=1 or temperature(values[0]) is None:raise ValueError('MeteoLux 2 m air temperature missing')
    coords=station.get('location') or []
    if len(coords)!=2:raise ValueError('MeteoLux coordinates missing')
    return core.make_station('LU',station['id'],station.get('shortName') or station.get('name'),coords[1],coords[0],
                             [(observations.get('timestamp'),temperature(values[0]))])


def parse_luxembourg():
    metadata=json.loads(download(METEOLUX+'stations/LUX0000001'))
    observations=json.loads(download(METEOLUX+'observations'))
    return recent_stations([meteolux_station(observations,metadata)])


def shmu_stations(payload):
    if payload.get('type')!='FeatureCollection' or not isinstance(payload.get('features'),list):
        raise ValueError('Invalid SHMU official map feed')
    out=[]
    for feature in payload['features']:
        props=feature.get('properties') or {}
        weather=props.get('prop_weather') or {}
        geometry=feature.get('geometry') or {}
        coords=geometry.get('coordinates') or []
        value=temperature(weather.get('ttt'))
        code=weather.get('station_id')
        timestamp=weather.get('dt')
        if (geometry.get('type')!='Point' or len(coords)!=2 or value is None or not code
                or not isinstance(timestamp,(int,float)) or isinstance(timestamp,bool)):
            continue
        # The official map publishes Unix UTC seconds per station, including
        # its real observation time. Do not use page/table refresh time.
        item=core.make_station('SK',code,props.get('prop_name') or code,coords[1],coords[0],[(timestamp,value)])
        if item:out.append(item)
    return out


def parse_slovakia():
    return recent_stations(shmu_stations(json.loads(download(SHMU))))


core.SOURCES.update({'CZ':'Czech Hydrometeorological Institute (ČHMÚ) / ten-minute air temperature (provisional)',
                     'SK':'Slovak Hydrometeorological Institute (SHMÚ) / measured air temperature (provisional)',
                     'LU':'MeteoLux / ANA Luxembourg-Findel / one-minute air temperature at 2 m'})
core.COUNTRY_BOUNDS.update({'CZ':(48.5,51.1,12,18.9),'SK':(47.6,49.7,16.7,22.7),'LU':(49.4,50.2,5.7,6.6)})
core.LOADERS.update({'CZ':parse_czechia,'SK':parse_slovakia,'LU':parse_luxembourg})
