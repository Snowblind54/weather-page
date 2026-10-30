"""Official UHMC and ANM measured air temperatures, with native station times."""
import datetime as dt
import gzip
import hashlib
import html
import json
import math
from pathlib import Path
import re
import urllib.request
from zoneinfo import ZoneInfo

import update_official_temperature as core

BOUNDS={'UA':(44,52.5,22,40.5),'RO':(43.5,48.5,20,30)}
SOURCES={'UA':'Ukrainian Hydrometeorological Center (UHMC) / official station observations',
         'RO':'Administrația Națională de Meteorologie (ANM), Romania / official station observations'}
UA_URL='https://www.meteo.gov.ua/_/m/current.js'
RO_URL='https://www.meteoromania.ro/wp-json/meteoapi/v2/starea-vremii'

def number(value,low,high):
    if value is None or isinstance(value,bool) or str(value).strip()=='':return None
    try:v=float(value)
    except (ValueError,TypeError):return None
    return v if math.isfinite(v) and low<=v<=high else None

def local_time(value,zone,reference=None):
    a=value.replace(tzinfo=ZoneInfo(zone),fold=0);b=value.replace(tzinfo=ZoneInfo(zone),fold=1)
    if a.utcoffset()!=b.utcoffset():
        # A repeated autumn hour cannot be assigned to either UTC time without
        # an explicit provider offset. ANM's root date can resolve that hour.
        if reference and reference.replace(tzinfo=None)==value and reference.utcoffset() in (a.utcoffset(),b.utcoffset()):return int(reference.timestamp())
        raise ValueError('Ambiguous local observation hour')
    return int(a.timestamp())

def make(country,code,name,lat,lon,rows,now):
    end=int(now.timestamp());age=4*3600 if country=='UA' else 2*3600
    rows=[(t,v) for t,v in rows if end-86400<=t<=end+60 and v is not None]
    if not rows or max(t for t,v in rows)<end-age:return None
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    return core.make_station(country,code,name,lat,lon,rows)

def parse_ukraine(payload,metadata,now):
    if not isinstance(payload,dict) or len(payload)>300:raise ValueError('Unexpected UHMC current observation product')
    out=[]
    for code,row in payload.items():
        m=metadata.get(code)
        if not m or not isinstance(row,dict):continue
        value=number(row.get('C_T'),-89.99,54.99)
        date=row.get('CD');hour=row.get('CT')
        if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date) or isinstance(hour,bool) or not re.fullmatch(r'\d{1,2}',str(hour)):continue
        try:
            when=dt.datetime.strptime(date+' '+str(hour),'%Y-%m-%d %H')
            t=local_time(when,'Europe/Kyiv')
        except (ValueError,TypeError):continue
        s=make('UA',code,m['name'],m['lat'],m['lon'],[(t,value)],now)
        if s:out.append(s)
    if not out:raise ValueError('No recent official Ukrainian temperatures')
    return out

def parse_romania(payload,now):
    if payload.get('success') is not True or payload.get('type')!='FeatureCollection' or not isinstance(payload.get('features'),list) or len(payload['features'])>500:raise ValueError('Unexpected ANM observation product')
    try:
        reference=dt.datetime.fromisoformat(payload['date'])
        if reference.tzinfo is None:raise ValueError('ANM root date missing UTC offset')
    except (KeyError,TypeError,ValueError):raise ValueError('Invalid ANM observation date')
    out=[];seen=set()
    for f in payload['features']:
        p=f.get('properties') or {};g=f.get('geometry') or {};coords=g.get('coordinates') or []
        if g.get('type')!='Point' or len(coords)!=2:continue
        # The national map publishes Web Mercator metres (EPSG:3857), not
        # longitude/latitude. Keep the actual gauge position after inversion.
        x=number(coords[0],2e6,3.4e6);y=number(coords[1],5e6,6.5e6)
        if x is None or y is None:continue
        lon=math.degrees(x/6378137);lat=math.degrees(math.atan(math.sinh(y/6378137)))
        date=' '.join(html.unescape(str(p.get('actualizat') or '')).split())
        try:t=local_time(dt.datetime.strptime(date,'%d-%m-%Y ora %H:%M'),'Europe/Bucharest',reference)
        except (ValueError,TypeError):continue
        name=str(p.get('nume') or '').strip()
        if not name:continue
        code='ANM-'+hashlib.sha256((name.upper()+'|'+f'{lat:.5f}|{lon:.5f}').encode()).hexdigest()[:16]
        if code in seen:continue
        s=make('RO',code,name,lat,lon,[(t,number(p.get('tempe'),-89.99,54.99))],now)
        if s:out.append(s);seen.add(code)
    if not out:raise ValueError('No recent official Romanian temperatures')
    return out

def download_ukraine():
    # Public feed used by the UHMC station map; retain its publisher referrer.
    req=urllib.request.Request(UA_URL,headers={'User-Agent':'NorthernWeather/official-station-observations (+https://northweather.app)',
        'Referer':'https://www.meteo.gov.ua/en/','Accept-Encoding':'gzip'})
    with urllib.request.urlopen(req,timeout=30) as response:raw=response.read(2*1024*1024+1)
    if len(raw)>2*1024*1024:raise ValueError('UHMC response too large')
    raw=gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw
    return json.loads(raw)

def load(country,now,download=core.download):
    if country=='RO':return parse_romania(json.loads(download(RO_URL)),now)
    if country=='UA':
        catalogue=json.loads(Path(__file__).with_name('ukraine_temperature_stations.json').read_text())['stations']
        return parse_ukraine(download_ukraine(),catalogue,now)
    raise ValueError('Unknown eastern European country')
