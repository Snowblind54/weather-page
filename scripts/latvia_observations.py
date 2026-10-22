"""LVĢMC's current public station feed, as used by its official observations map.

Times are UTC (the official website converts these to Europe/Riga for display).
Temperature is Celsius; reported wind and hourly maximum gust are in m/s.
The legacy weather_monitoring_data_raw endpoint is archived and must not be used.
"""
import datetime as dt
import math

BASE='https://videscentrs.lvgmc.lv/data/'
SOURCE='Latvian Environment, Geology and Meteorology Centre (LVĢMC) official observations'


def numeric(v,low,high):
    if v is None or isinstance(v,bool):return None
    try:n=float(v)
    except (ValueError,TypeError):return None
    return round(n,2) if math.isfinite(n) and low<=n<=high else None


def parse(observations,metadata,now):
    if not isinstance(observations,list) or not isinstance(metadata,list):raise ValueError('Invalid LVĢMC station feed')
    stations={str(s.get('kods')):s for s in metadata if s.get('kods')}
    grouped={};end=int(now.timestamp())
    for obs in observations:
        code=str(obs.get('station_code') or '');meta=stations.get(code)
        if not meta:continue
        try:
            lat,lon=float(meta['lat']),float(meta['lon'])
            t=int(dt.datetime.strptime(obs['time'],'%Y.%m.%d %H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp())
        except (KeyError,ValueError,TypeError):continue
        if not(55.5<=lat<=58.2 and 20.5<=lon<=28.4 and end-24*3600<=t<=end+60):continue
        row=[t,numeric(obs.get('air_temperature_actual'),-90,55),numeric(obs.get('wind_speed_actual'),0,100),numeric(obs.get('wind_speed_maximum'),0,100),numeric(obs.get('wind_direction_actual'),0,360)]
        if all(v is None for v in row[1:4]):continue
        s=grouped.setdefault(code,dict(code=code,name=meta.get('nosaukums') or obs.get('name') or code,lat=lat,lon=lon,rows={}))
        s['rows'][t]=row
    result=[{**s,'rows':[s['rows'][t] for t in sorted(s['rows'])]} for s in grouped.values()]
    if not any(s['rows'][-1][0]>=end-2*3600 for s in result):raise ValueError('LVĢMC station feed has no recent observations')
    return result


def load(now,download_json):
    return parse(download_json(BASE+'weather_monitoring_data'),download_json(BASE+'weather_monitoring_points'),now)
