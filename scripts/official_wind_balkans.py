"""Official ANM/RHMZ/NIMH winds, WMO SYNOP gusts and airport METAR/SPECI.

Reports keep their actual times and native measurement periods. An absent
national gust field never becomes zero, a daily maximum or a model estimate.
"""
import concurrent.futures as futures
import datetime as dt
import hashlib
import html
import json
import math
from pathlib import Path
import re
import threading
import xml.etree.ElementTree as ET

import update_official_wind as core
from balkan_temperature import ObservationTable, URLS as BALKAN_URLS
from eastern_temperature import local_time, number, RO_URL
from moldova_belarus_temperature import normalized
from southeast_temperature import URLS as SOUTHEAST_URLS
from official_wind_eastern import synop
from adriatic_greece_temperature import BASE, download_bulletin
from official_wind_us import parse_us_metars

BOUNDS={'MK':(40.8,42.4,20.4,23.1),'GR':(34.7,41.8,19.3,29.8),'AL':(39.6,42.7,19.2,21.1),'RO':(43.5,48.5,20,30),'RS':(42.2,46.3,18.8,23.1),'BG':(41.2,44.3,22.2,28.8)}
URLS={'MK':'https://uhmr.gov.mk/aktuelni-podatoci/','GR':'https://emy.gr/','AL':'https://tgftp.nws.noaa.gov/data/raw/','RO':RO_URL,'RS':BALKAN_URLS['RS'],'BG':SOUTHEAST_URLS['BG']}
NAMES={'MK':'Hydrometeorological Service (UHMR), North Macedonia','GR':'Hellenic National Meteorological Service (HNMS), Greece','AL':'Official Albanian WMO station observations','RO':'Administrația Națională de Meteorologie (ANM), Romania',
       'RS':'Republic Hydrometeorological Service of Serbia (RHMZ)',
       'BG':'National Institute of Meteorology and Hydrology (NIMH), Bulgaria'}
PERIOD=('Official national station wind, supplemented by WMO SYNOP and airport METAR/SPECI observations. '
        'Native observation times and periods are retained; reports are marked delayed after 90 minutes. '
        'Gusts are included only when explicitly reported, and missing gusts remain unavailable.')
SYNOP_PERIOD=('Measured ten-minute mean wind. Reported gust maximum over the preceding ten minutes, '
              'or the native three/six-hour SYNOP period when a ten-minute gust is absent. '
              'Reports with other gust reference periods are excluded. Actual UTC observation time; '
              'Some land stations report only every three or six hours. '
              'Missing gusts remain unavailable.')
BULLETINS={'MK':['sm/smmj20.mjsk..txt','si/simj20.mjsk..txt','sm/smmj01.lwoh..txt','sm/smmj41.lwsk..txt','si/simj01.lwoh..txt','si/simj41.lwsk..txt'],
 'GR':['sm/smgr01.lgat..txt','sm/smgr20.lgat..txt','sm/smgr21.lgat..txt','sm/smgr55.lgat..txt','sm/smgr56.lgat..txt','si/sigr20.lgat..txt','si/sigr21.lgat..txt','si/sigr22.lgat..txt'],
 'AL':['sm/smab11.zati..txt','si/siab30.zati..txt'],
 'RO':['sm/smro01.yrbk..txt','si/siro21.yrbk..txt'],
 'RS':['sm/smyg10.lybm..txt','sm/smyg21.lybm..txt','sm/smyg22.lybm..txt','sm/smyg23.lybm..txt',
       'si/siyg20.lybm..txt','si/siyg21.lybm..txt','si/siyg22.lybm..txt','si/siyg23.lybm..txt'],
 'BG':['sm/smbu01.lzso..txt','sm/smbu40.lzso..txt','si/sibu20.lzso..txt']}
COMPASS={v:i*22.5 for i,v in enumerate(['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'])}
RO_COMPASS={k.replace('W','V'):v for k,v in COMPASS.items()}
NS={'a':'https://www.w3.org/2005/Atom'}
AVIATION='https://aviationweather.gov/data/cache/'
_aviation_lock=threading.Lock()
_aviation_cache=None


def finish(country,code,m,rows,now,kind='national'):
    end=int(now.timestamp());age=7*3600 if country in ('RO','GR') and kind=='synop' else 4*3600 if country=='BG' or kind=='synop' else 3*3600
    rows=[r for r in rows if end-86400<=r[0]<=end and (r[1] is not None or r[2] is not None)]
    if not rows or max(r[0] for r in rows)<end-age:return None
    south,north,west,east=BOUNDS[country]
    if number(m.get('lat'),south,north) is None or number(m.get('lon'),west,east) is None:return None
    s=core.station(country,code,m['name'],m['lat'],m['lon'],rows)
    s.update(sourceName=NAMES[country]+(' / official SYNOP via NOAA' if kind=='synop' else ''),sourceUrl=URLS[country],
      period=SYNOP_PERIOD if kind=='synop' else 'Reported national station wind speed in m/s and actual observation time. This national feed does not publish gusts; missing gusts remain unavailable.',
      gustLabel='Reported SYNOP gust' if kind=='synop' else 'Gust unavailable in national feed',observationNetwork='balkan-official')
    return s


def parse_romania(p,now):
    if not isinstance(p,dict) or p.get('success') is not True or p.get('type')!='FeatureCollection' or not isinstance(p.get('features'),list) or len(p['features'])>500:raise ValueError('Unexpected ANM observation product')
    reference=dt.datetime.fromisoformat(p['date'])
    if reference.tzinfo is None:raise ValueError('ANM reference time lacks UTC offset')
    out=[];seen=set()
    for f in p['features']:
        prop=f.get('properties') or {};g=f.get('geometry') or {};coords=g.get('coordinates') or []
        if g.get('type')!='Point' or len(coords)!=2:continue
        x=number(coords[0],2e6,3.4e6);y=number(coords[1],5e6,6.5e6)
        if x is None or y is None:continue
        lat=math.degrees(math.atan(math.sinh(y/6378137)));lon=math.degrees(x/6378137)
        name=str(prop.get('nume') or '').strip();wind=html.unescape(str(prop.get('vant') or '')).strip()
        match=re.fullmatch(r'(\d+(?:[.,]\d+)?)\s*m/s,\s*directia\s*:\s*([A-Z-]+)',wind)
        if not match or not name:continue
        speed=number(match[1].replace(',','.'),0,100);direction=RO_COMPASS.get(match[2]) if speed else None
        date=' '.join(html.unescape(str(prop.get('actualizat') or '')).split())
        try:t=local_time(dt.datetime.strptime(date,'%d-%m-%Y ora %H:%M'),'Europe/Bucharest',reference)
        except ValueError:continue
        code='ANM-'+hashlib.sha256((name.upper()+'|'+f'{lat:.5f}|{lon:.5f}').encode()).hexdigest()[:16]
        if code in seen:continue
        s=finish('RO',code,dict(name=name,lat=lat,lon=lon),[(t,speed,None,direction)],now)
        if s:out.append(s);seen.add(code)
    return out


def parse_serbia(raw,metadata,now):
    root=ET.fromstring(raw)
    if root.tag!='{'+NS['a']+'}feed':raise ValueError('Unexpected RHMZ Atom feed')
    date=re.fullmatch(r'RHMS of Serbia - Data from major meteorological stations (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})',root.findtext('a:title','',NS).strip())
    if not date:raise ValueError('RHMZ observed hour missing')
    t=local_time(dt.datetime.strptime(date[1],'%d.%m.%Y %H:%M'),'Europe/Belgrade')
    entries=root.findall('a:entry',NS)
    if len(entries)>100:raise ValueError('RHMZ station limit exceeded')
    out=[];seen=set()
    for en in entries:
        text=en.findtext('a:summary','',NS)
        code=re.search(r'(?:^|;)\s*Station ID:\s*(\d{5});',text)
        speed=re.search(r'(?:^|;)\s*Wind speed:\s*(\d+(?:[.,]\d+)?)\s*m/s;',text)
        direction=re.search(r'(?:^|;)\s*Wind direction:\s*([A-Z-]+)\s*;',text)
        if not code or not speed or code[1] not in metadata or code[1] in seen:continue
        m=metadata[code[1]]
        if normalized(en.findtext('a:title','',NS).removeprefix('Station: ').rstrip(';'))!=normalized(m['name']):continue
        v=number(speed[1].replace(',','.'),0,100);d=COMPASS.get(direction[1]) if direction and v else None
        s=finish('RS','RHMZ-'+code[1],m,[(t,v,None,d)],now)
        if s:out.append(s);seen.add(code[1])
    return out


def parse_bulgaria(raw,metadata,now):
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    parser=ObservationTable();parser.feed(text);parser.finish_cell();parser.finish_row()
    names={normalized(m['name']):(code,m) for code,m in metadata.items()}
    out=[];header=False;seen=set()
    for r in parser.rows:
        if len(r)==7 and normalized(r[0])=='станция':
            header='Дата' in r[1] and '[m/s]' in r[4] and 'посока' in r[5];continue
        if not header or len(r)!=7 or normalized(r[0]) not in names:continue
        code,m=names[normalized(r[0])]
        if code in seen:continue
        date=re.fullmatch(r'(\d{2}\.\d{2}\.\d{4})\s*г\.(\d{1,2})ч\.',r[1])
        if not date:continue
        try:t=local_time(dt.datetime.strptime(date[1]+' '+date[2],'%d.%m.%Y %H'),'Europe/Sofia')
        except ValueError:continue
        v=number(r[4].replace(',','.'),0,100);d=COMPASS.get(r[5]) if v else None
        s=finish('BG','NIMH-'+code,m,[(t,v,None,d)],now)
        if s:out.append(s);seen.add(code)
    return out


def airport_data(download):
    global _aviation_cache
    with _aviation_lock:
        if _aviation_cache is None:_aviation_cache=(json.loads(download(AVIATION+'stations.cache.json.gz')),download(AVIATION+'metars.cache.csv.gz'))
        return _aviation_cache


def load(country,now,download=core.download,bulletin_download=download_bulletin,aviation_data=airport_data):
    if country not in BOUNDS:raise ValueError('Unknown Balkan wind country')
    metadata=(json.loads(Path(__file__).with_name('southern_balkan_wind_stations.json').read_text())['stations'][country] if country in ('MK','GR','AL') else
      json.loads(Path(__file__).with_name('romania_wind_stations.json').read_text())['stations'] if country=='RO' else
      json.loads(Path(__file__).with_name('balkan_temperature_stations.json' if country=='RS' else 'southeast_temperature_stations.json').read_text())['stations'][country])
    out=[]
    if country in ('RO','RS','BG'):
        try:
            raw=download(URLS[country])
            out= parse_romania(json.loads(raw),now) if country=='RO' else (parse_serbia if country=='RS' else parse_bulgaria)(raw,metadata,now)
        except Exception as e:print(country,'national wind unavailable:',str(e)[:150],flush=True)
    def one(path):
        try:
            raw,reference=bulletin_download(BASE+path);parts=path.split('/')[-1].split('.')
            grouped={}
            for code,row in synop(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,now,allowed_reference_periods=('30',) if country=='GR' else ()):grouped.setdefault(code,[]).append(row)
            return [s for code,rows in grouped.items() if (s:=finish(country,'SYNOP-'+code,metadata[code],rows,now,'synop'))]
        except Exception as e:print(country,'SYNOP wind unavailable',path,str(e)[:130],flush=True);return []
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        for rows in pool.map(one,BULLETINS[country]):out.extend(rows)
    try:
        catalogue,raw=aviation_data(download)
        if not isinstance(catalogue,list) or len(catalogue)>20000:raise ValueError('Unexpected AWC station catalogue')
        south,north,west,east=BOUNDS[country]
        airports={s['icaoId']:s for s in catalogue if s.get('country')==country and isinstance(s.get('lat'),(int,float)) and isinstance(s.get('lon'),(int,float)) and south<=s['lat']<=north and west<=s['lon']<=east}
        for s in parse_us_metars(raw,airports,now,country):
            s.update(code='METAR-'+s['code'],sourceName='Official airport METAR/SPECI observations via NOAA Aviation Weather Center',sourceUrl='https://aviationweather.gov/data/metar/',period='Airport ten-minute mean wind and explicitly reported METAR/SPECI gusts, in m/s. Knots converted to m/s; actual UTC observation time. Missing gusts remain unavailable.',gustLabel='Reported METAR gust',observationNetwork='balkan-official')
            out.append(s)
    except Exception as e:print(country,'airport wind unavailable:',str(e)[:150],flush=True)
    if country=='AL':
        # Kukës reports SYNOP even when no METAR is present in the airport cache.
        try:
            from europe_synop import POI, parse, SPEED, GUST, DIRECTION
            m=metadata['13610']
            rows=[(t,None if v[SPEED] is None else v[SPEED]/3.6,None if v[GUST] is None else v[GUST]/3.6,v[DIRECTION]) for t,v in parse(download(POI+'13610-BEOB.csv'),'13610',(SPEED,GUST,DIRECTION))]
            s=finish('AL','SYNOP-13610',m,rows,now,'synop')
            if s:
                s.update(sourceUrl=POI+'13610-BEOB.csv',sourceName='Official Kukës airport SYNOP via DWD',gustLabel='Gust max · 1 hour',period='Ten-minute mean wind and maximum gust over the preceding hour, converted from km/h to m/s. Actual UTC SYNOP observation time; missing gusts remain unavailable.')
                out.append(s)
        except Exception as e:print('AL Kukës SYNOP unavailable:',str(e)[:150],flush=True)
    # Keep independent national/SYNOP/airport measurement products distinct:
    # a newer mean must not inherit an older gust from another report.
    out=core.merge([],out,now)
    if not out:raise ValueError('No recent official '+country+' winds')
    return out
