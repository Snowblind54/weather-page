"""Official Mediterranean station winds; gusts only when explicitly measured."""
import concurrent.futures as futures
import datetime as dt
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import update_official_wind as core
from mediterranean_temperature import BOUNDS, CY_URL, TR_METADATA, TR_OBSERVATIONS, download_turkey
from eastern_temperature import number, local_time
from official_wind_balkans import airport_data, SYNOP_PERIOD
from official_wind_us import parse_us_metars
from official_wind_eastern import synop
from adriatic_greece_temperature import BASE, download_bulletin
from europe_synop import POI, parse as parse_poi, SPEED, GUST, DIRECTION

NAMES={'MT':'Malta International Airport / official WMO and airport observations',
       'CY':'Weather Data © Cyprus Department of Meteorology · CC BY 4.0',
       'TR':'Meteoroloji Genel Müdürlüğü (MGM), Türkiye'}
URLS={'MT':'https://aviationweather.gov/data/metar/','CY':CY_URL,'TR':'https://www.mgm.gov.tr/sondurum/turkiye.aspx'}
PERIOD='Official measured station winds at native observation times. Wind units converted to m/s. Explicit SYNOP and METAR gusts supplement national means; missing gusts remain unavailable. Gust measurement periods are identified per station; delayed reports are marked after 90 minutes.'
BULLETINS=['sm/smtu'+n+'.ltaa..txt' for n in ('10','11','12','13','60','61','62','63')]+['si/situ'+n+'.ltaa..txt' for n in ('10','11','12','13','60','61','62','63')]
POI_CODES={'MT':('16597',),'CY':('17600','17609'),'TR':()}


def finish(country,code,m,rows,now,kind='national'):
    end=int(now.timestamp());age=7*3600 if country=='TR' and kind=='synop' else 3*3600
    rows=[r for r in rows if end-86400<=r[0]<=end and (r[1] is not None or r[2] is not None)]
    if not rows or max(r[0] for r in rows)<end-age:return None
    south,north,west,east=BOUNDS[country]
    if number(m.get('lat'),south,north) is None or number(m.get('lon'),west,east) is None:return None
    s=core.station(country,code,m['name'],m['lat'],m['lon'],rows)
    s.update(sourceName=NAMES[country],sourceUrl=URLS[country],period=PERIOD,gustLabel='Reported gust',observationNetwork='mediterranean-official')
    return s


def parse_cyprus(raw,now):
    root=ET.fromstring(raw)
    if root.tag!='meteorology':raise ValueError('Unexpected Cyprus product')
    entries=root.findall('stations/station');observations=root.findall('observations')
    if not entries or len(entries)>200 or len(observations)>200:raise ValueError('Unexpected Cyprus station count')
    meta={};ambiguous=set();grouped={}
    for e in entries:
        code=e.findtext('station_code') or ''
        if not re.fullmatch(r'[A-Z0-9_]+',code):continue
        lat=number(e.findtext('station_latitude'),34.5,35.8);lon=number(e.findtext('station_longitude'),32.1,34.7)
        if lat is None or lon is None:continue
        m=dict(name=code.replace('_',' ').title(),lat=lat,lon=lon)
        if code in meta and meta[code]!=m:ambiguous.add(code)
        meta[code]=m
    for e in observations:
        code=e.findtext('station_code') or ''
        if code not in meta or code in ambiguous:continue
        match=re.fullmatch(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(Local Time\)',(e.findtext('date_time') or '').strip())
        if not match:continue
        try:t=local_time(dt.datetime.strptime(match[1],'%Y-%m-%d %H:%M'),'Asia/Nicosia')
        except ValueError:continue
        def channel(name,unit,high):
            channels=[o for o in e.findall('observation') if o.findtext('observation_name')==name]
            return number(channels[0].findtext('observation_value'),0,high) if len(channels)==1 and channels[0].findtext('observation_unit')==unit else None
        speed=channel('Wind Speed (10m)','Knots',194);direction=channel('Wind Direction (10m)','Degrees',360)
        if speed is not None:grouped.setdefault(code,[]).append((t,speed*1852/3600,None,direction if speed else None))
    out=[]
    for code,rows in grouped.items():
        s=finish('CY','CYDOM-'+code,meta[code],rows,now)
        if s:
            s.update(period='Cyprus DoM provisional ten-minute mean wind at 10 m; knots converted to m/s. Local station times converted to UTC. Weather Data © Cyprus Department of Meteorology, CC BY 4.0. The national XML feed does not publish gusts; 2 m wind and daily extremes are excluded.',gustLabel='Gust unavailable in national feed')
            out.append(s)
    return out


def parse_turkey(metadata,observations,now):
    if not isinstance(metadata,list) or not 1<=len(metadata)<=200 or not isinstance(observations,list) or len(observations)>300:raise ValueError('Unexpected MGM product')
    meta={};ambiguous=set();grouped={}
    for m in metadata:
        code=str(m.get('sondurumIstNo') or '');lat=number(m.get('enlem'),35.8,42.2);lon=number(m.get('boylam'),25.6,45)
        if not re.fullmatch(r'\d{5}',code) or lat is None or lon is None or not m.get('il'):continue
        name=str(m['il']).strip();district=str(m.get('ilce') or '').strip()
        if district and district!='Merkez':name+=' / '+district
        item=dict(name=name,lat=lat,lon=lon)
        if code in meta and meta[code]!=item:ambiguous.add(code)
        meta[code]=item
    for r in observations:
        code=str(r.get('istNo') or '')
        if code not in meta or code in ambiguous or not isinstance(r.get('veriZamani'),str):continue
        try:
            date=dt.datetime.fromisoformat(r['veriZamani'].replace('Z','+00:00'))
            if date.tzinfo is None:continue
            t=int(date.timestamp())
        except ValueError:continue
        speed=number(r.get('ruzgarHiz'),0,360);direction=number(r.get('ruzgarYon'),0,360)
        if speed is not None:grouped.setdefault(code,[]).append((t,speed/3.6,None,direction if speed else None))
    out=[]
    for code,rows in grouped.items():
        s=finish('TR','MGM-'+code,meta[code],rows,now)
        if s:
            s.update(period='MGM provisional measured wind speed at the provincial reporting station, converted from km/h to m/s; wind direction in degrees and actual UTC observation time. The current national feed does not publish gusts; daily maximum winds are not used.',gustLabel='Gust unavailable in national feed')
            out.append(s)
    return out


def load(country,now,download=core.download,mgm_download=download_turkey,bulletin_download=download_bulletin,aviation_data=airport_data):
    if country not in BOUNDS:raise ValueError('Unknown Mediterranean country')
    metadata=json.loads(Path(__file__).with_name('mediterranean_wind_stations.json').read_text())['stations'][country];out=[]
    if country in ('CY','TR'):
        try:out.extend(parse_cyprus(download(CY_URL),now) if country=='CY' else parse_turkey(json.loads(mgm_download(TR_METADATA)),json.loads(mgm_download(TR_OBSERVATIONS)),now))
        except Exception as e:print(country,'national wind unavailable:',str(e)[:150],flush=True)
    def one(path):
        try:
            raw,reference=bulletin_download(BASE+path);parts=path.split('/')[-1].split('.');grouped={}
            for code,row in synop(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,now):grouped.setdefault(code,[]).append(row)
            result=[]
            for code,rows in grouped.items():
                s=finish(country,'SYNOP-'+code,metadata[code],rows,now,'synop')
                if s:s.update(sourceUrl=BASE+path,period=SYNOP_PERIOD,gustLabel='Reported SYNOP gust');result.append(s)
            return result
        except Exception as e:print(country,'SYNOP unavailable',path,str(e)[:120],flush=True);return []
    if country=='TR':
        with futures.ThreadPoolExecutor(max_workers=4) as pool:
            for rows in pool.map(one,BULLETINS):out.extend(rows)
    for code in POI_CODES[country]:
        try:
            rows=[(t,None if v[SPEED] is None else v[SPEED]/3.6,None if v[GUST] is None else v[GUST]/3.6,v[DIRECTION]) for t,v in parse_poi(download(POI+code+'-BEOB.csv'),code,(SPEED,GUST,DIRECTION))]
            s=finish(country,'SYNOP-'+code,metadata[code],rows,now,'synop')
            if s:s.update(sourceUrl=POI+code+'-BEOB.csv',period='Official SYNOP ten-minute mean wind and maximum gust over the preceding hour; km/h converted to m/s, actual UTC observation time. Distributed by DWD. Missing gusts remain unavailable.',gustLabel='Gust max · 1 hour');out.append(s)
        except Exception as e:print(country,'DWD SYNOP unavailable',code,str(e)[:120],flush=True)
    try:
        catalogue,raw=aviation_data(download)
        if not isinstance(catalogue,list) or len(catalogue)>20000:raise ValueError('Unexpected airport catalogue')
        south,north,west,east=BOUNDS[country]
        airports={s['icaoId']:s for s in catalogue if s.get('country')==country and number(s.get('lat'),south,north) is not None and number(s.get('lon'),west,east) is not None}
        for s in parse_us_metars(raw,airports,now,country):
            s.update(code='METAR-'+s['code'],sourceName='Official airport METAR/SPECI via NOAA Aviation Weather Center',sourceUrl='https://aviationweather.gov/data/metar/',period='Official airport mean wind and explicitly reported METAR/SPECI gusts. Knots converted to m/s; actual UTC observation time. Missing gusts remain unavailable.',gustLabel='Reported METAR gust',observationNetwork='mediterranean-official');out.append(s)
    except Exception as e:print(country,'airport wind unavailable:',str(e)[:150],flush=True)
    result=core.merge([],out,now)
    if not result:raise ValueError('No recent official '+country+' winds')
    return result
