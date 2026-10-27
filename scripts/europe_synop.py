"""Observed SYNOP data distributed by DWD, with station identity and native units checked."""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
from pathlib import Path
import math

POI='https://opendata.dwd.de/weather/weather_reports/poi/'
TEMP='dry_bulb_temperature_at_2_meter_above_ground'
SPEED='mean_wind_speed_during last_10_min_at_10_meters_above_ground'
GUST='maximum_wind_speed_last_hour'
DIRECTION='mean_wind_direction_during_last_10 min_at_10_meters_above_ground'
PROVIDERS={'IT':'Servizio Meteorologico dell’Aeronautica Militare','GB':'Met Office','FR':'Météo-France','LV':'LVĢMC'}


def value(text,low,high):
    try:n=float(text.replace(',','.'))
    except (ValueError,TypeError,AttributeError):return None
    return n if math.isfinite(n) and low<=n<=high else None


def parse(raw,code,required):
    records=list(csv.reader(io.StringIO(raw.decode('latin1') if isinstance(raw,bytes) else raw),delimiter=';'))
    if len(records)<4 or not set(required)<=set(records[0]):raise ValueError('Missing SYNOP observation columns')
    indices={k:records[0].index(k) for k in required}
    units={TEMP:'Grad C',SPEED:'km/h',GUST:'km/h',DIRECTION:'Grad'}
    if records[1][0]!=code or any(records[1][i]!=units[k] for k,i in indices.items()):raise ValueError('SYNOP station identity or units changed')
    rows=[]
    for row in records[3:]:
        if len(row)<=max(indices.values()):continue
        try:stamp=int(dt.datetime.strptime(row[0]+' '+row[1],'%d.%m.%y %H:%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except ValueError:continue
        values={k:value(row[i],-90 if k==TEMP else 0,55 if k==TEMP else 360) for k,i in indices.items()}
        rows.append((stamp,values))
    return rows


def collect(country,now,download,required):
    metadata=json.loads(Path(__file__).with_name('europe_synop_stations.json').read_text())['stations']
    end=int(now.timestamp());age=4*3600 if country in ('LV','FR') else 3*3600
    def one(pair):
        code,meta=pair
        try:
            rows=[r for r in parse(download(POI+code+'-BEOB.csv'),code,required) if end-24*3600<=r[0]<=end+60]
            if not rows or max(r[0] for r in rows)<end-age:return None
            return code,meta,rows
        except Exception as error:
            print(country,'SYNOP',code,'unavailable:',str(error)[:150],flush=True)
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        return [r for r in pool.map(one,[(k,v) for k,v in metadata.items() if v['country']==country]) if r]


def load_wind(country,now,download):
    import update_official_wind as core
    results=[]
    for code,meta,rows in collect(country,now,download,(SPEED,GUST,DIRECTION)):
        item=core.station(country,'SYNOP-'+code,meta['name'],meta['lat'],meta['lon'],
            [(t,None if v[SPEED] is None else v[SPEED]/3.6,None if v[GUST] is None else v[GUST]/3.6,v[DIRECTION]) for t,v in rows])
        item.update(sourceName=PROVIDERS[country]+' official SYNOP observations distributed by DWD',
            sourceUrl=POI+code+'-BEOB.csv',gustLabel='Gust max · 1 hour',
            period='10-minute mean wind at 10 m and maximum gust over the preceding hour. '+('Three-hourly' if country in ('FR','LV') else 'Hourly')+' UTC observation times; missing gusts remain unavailable.')
        if item['rows'] and item['rows'][-1][0]>=int(now.timestamp())-(4 if country in ('LV','FR') else 3)*3600:results.append(item)
    return results


def load_latvian_temperature(now,download):
    return load_temperature('LV',now,download)


def load_temperature(country,now,download):
    import update_official_temperature as core
    results=[]
    for code,meta,rows in collect(country,now,download,(TEMP,)):
        item=core.make_station(country,'SYNOP-'+code,meta['name'],meta['lat'],meta['lon'],[(t,v[TEMP]) for t,v in rows])
        if item and item['rows'][-1][0]>=int(now.timestamp())-4*3600:
            item['source']=PROVIDERS[country]+' official SYNOP observations distributed by DWD (three-hourly, UTC)';results.append(item)
    if not results:raise ValueError('No current official '+country+' SYNOP temperatures')
    return results
