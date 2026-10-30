"""UHMC and Belhydromet winds, with measured gusts from dated WMO bulletins.

National current maps do not provide gust fields. Only explicit FM-12 910/911
reports supply gusts; neither daily maxima nor model estimates fill their gaps.
"""
import concurrent.futures as futures
import datetime as dt
import json
from pathlib import Path
import re

import update_official_wind as core
from eastern_temperature import download_ukraine, local_time, number
from moldova_belarus_temperature import BY_URL
from adriatic_greece_temperature import BASE, download_bulletin, observation_time

BOUNDS={'BY':(51.2,56.3,23,33),'UA':(44,52.5,22,40.5)}
URLS={'BY':'https://pogoda.by/observation/interactive-maps','UA':'https://www.meteo.gov.ua/en/'}
NAMES={'BY':'Belhydromet / official station map and SYNOP via NOAA','UA':'Ukrainian Hydrometeorological Center / official station map and SYNOP via NOAA'}
PERIOD=('Reported station wind speed in m/s; SYNOP winds are ten-minute means. '
        'Gusts are reported SYNOP maxima: 910 is the preceding ten minutes; '
        '911 is the preceding six hours at 00/06/12/18 UTC or three hours at intermediate SYNOP times. '
        'Reports with other gust reference periods are excluded. Native observation times; '
        'three-hourly reports can be up to four hours old and are marked delayed after 90 minutes. '
        'Missing gusts remain unavailable; no daily maxima or model values are substituted.')
BULLETINS={'BY':['sm/smby01.ummn..txt','sm/smby20.ummn..txt','sm/smby40.ummn..txt',
                 'si/siby20.ummn..txt','si/siby21.ummn..txt','si/siby40.ummn..txt'],
           'UA':['sm/smur10.ukms..txt','sm/smur11.ukms..txt','si/siur20.ukms..txt','si/siur21.ukms..txt']}
DIRECTIONS={'Северный':0,'С-В':45,'Восточный':90,'Ю-В':135,'Южный':180,'Ю-З':225,'Западный':270,'С-З':315}


def belarus(payload):
    if not isinstance(payload,list) or len(payload)>200:raise ValueError('Unexpected Belhydromet national observation map')
    metadata={};rows=[]
    for r in payload:
        if not isinstance(r,dict) or r.get('country')!='BY':continue
        code=str(r.get('number') or '')
        lat=number(r.get('LATITUDE'),51.2,56.3);lon=number(r.get('LONGITUDE'),23,33)
        name=str(r.get('name') or '').strip()
        if not re.fullmatch(r'\d{5}',code) or lat is None or lon is None or not name:continue
        m=dict(name=name,lat=lat,lon=lon)
        if code in metadata and metadata[code]!=m:raise ValueError('Conflicting Belhydromet station metadata')
        metadata[code]=m
        date=r.get('date');hour=r.get('HH')
        if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z',date):continue
        if isinstance(hour,bool) or not re.fullmatch(r'\d{1,2}',str(hour)) or not 0<=int(hour)<=23:continue
        try:t=int((dt.datetime.fromisoformat(date.replace('Z','+00:00'))+dt.timedelta(hours=int(hour))).timestamp())
        except ValueError:continue
        speed=number(r.get('Speed'),0,100)
        if speed is not None:rows.append((code,[t,speed,None,DIRECTIONS.get(r.get('Dir')) if speed else None]))
    return metadata,rows


def ukraine(payload,metadata):
    if not isinstance(payload,dict) or len(payload)>300:raise ValueError('Unexpected UHMC current observation map')
    rows=[]
    for code,r in payload.items():
        if code not in metadata or not isinstance(r,dict):continue
        date=r.get('CD');hour=r.get('CT')
        if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date) or isinstance(hour,bool) or not re.fullmatch(r'\d{1,2}',str(hour)):continue
        try:t=local_time(dt.datetime.strptime(date+' '+str(hour),'%Y-%m-%d %H'),'Europe/Kyiv')
        except ValueError:continue
        speed=number(r.get('C_W'),0,100)
        # UHMC direction is the WMO tens-of-degrees index, not whole degrees.
        direction=number(r.get('C_D'),1,36)
        if direction is not None and not direction.is_integer():direction=None
        if speed is not None:rows.append((code,[t,speed,None,None if direction is None or speed==0 else direction*10]))
    return rows


def synop(raw,reference,expected,metadata,now):
    if reference.tzinfo is None or not -60<=(now-reference).total_seconds()<=86400:raise ValueError('Undated or stale SYNOP file')
    text=raw.decode('ascii') if isinstance(raw,bytes) else raw
    if len(text)>512*1024:raise ValueError('Oversized SYNOP bulletin')
    h=re.match(r'\s*([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})(?:\s+[A-Z]{3})?\s*\n',text)
    if not h or (h[1],h[2])!=expected:raise ValueError('Unexpected SYNOP bulletin identity')
    body=text[h.end():];a=re.match(r'\s*AAXX\s+(\d{5})\s+',body)
    if not a or a[1][:4]!=h[3][:4]:raise ValueError('Invalid fixed-land SYNOP time')
    day,hour,iw=int(a[1][:2]),int(a[1][2:4]),a[1][4]
    if hour>23 or iw not in ('1','4'):return []  # measured m/s or measured knots only
    t=observation_time(day,hour,reference);factor=1 if iw=='1' else 1852/3600
    out=[]
    for report in body[a.end():].split('='):
        tokens=report.split()
        if len(tokens)<3 or tokens[0] not in metadata or not all(re.fullmatch(r'[\d/]{5}',g) for g in tokens[1:3]):continue
        code=tokens[0];wind=tokens[2];speed=number(wind[3:],0,98);direction=number(wind[1:3],1,36)
        if wind[3:]=='99':speed=number(tokens[3][2:],0,999) if len(tokens)>3 and re.fullmatch(r'00\d{3}',tokens[3]) else None
        section=1;gust10=[];gust_period=[];modified_period=False;actual_time_changed=False
        for i,g in enumerate(tokens[3:],3):
            if g in ('444','555'):break
            if g.startswith('222'):section=2;continue
            if g=='333':section=3;continue
            if section==1 and re.fullmatch(r'9\d{4}',g):actual_time_changed=True
            if section!=3:continue
            # 904/907 can change the following gust's time or period. Do not
            # assign such a gust to a guessed observation window.
            if re.fullmatch(r'90[47][\d/]{2}',g):modified_period=True
            if not re.fullmatch(r'91[01]\d{2}',g):continue
            v=int(g[3:])
            if v==99:v=int(tokens[i+1][2:]) if i+1<len(tokens) and re.fullmatch(r'00\d{3}',tokens[i+1]) else None
            v=number(None if v is None else v*factor,0,100)
            if v is not None:
                if g.startswith('910'):gust10.append(v)
                elif not modified_period and hour%3==0:gust_period.append(v)
        if actual_time_changed:continue
        gust=max(gust10) if gust10 else max(gust_period) if gust_period else None
        speed=number(None if speed is None else speed*factor,0,100)
        if speed is not None or gust is not None:out.append((code,[t,speed,gust,None if direction is None or speed==0 else direction*10]))
    return out


def finalize(country,metadata,observations,now):
    end=int(now.timestamp());grouped={}
    for code,row in observations:
        if code not in metadata or not end-86400<=row[0]<=end+60:continue
        entry=grouped.setdefault(code,{})
        # Merge only an identical station AND observation time. A newer national
        # mean must never inherit an older SYNOP gust or a daily maximum.
        previous=entry.get(row[0],[row[0],None,None,None])
        entry[row[0]]=[row[0]]+[row[i] if row[i] is not None else previous[i] for i in range(1,4)]
    result=[]
    for code,rows in grouped.items():
        if max(rows)<end-4*3600:continue
        m=metadata[code];s=core.station(country,('UHMC-' if country=='UA' else 'BELHYDROMET-')+code,m['name'],m['lat'],m['lon'],rows.values())
        s.update(sourceName=NAMES[country],sourceUrl=URLS[country],period=PERIOD,gustLabel='Reported SYNOP gust',observationNetwork='eastern-national-synop')
        if s['rows']:result.append(s)
    if not result:raise ValueError('No recent measured '+country+' winds')
    return result


def load(country,now,download=core.download,bulletin_download=download_bulletin,ua_download=download_ukraine):
    if country=='BY':metadata,observations=belarus(json.loads(download(BY_URL)))
    elif country=='UA':
        metadata=json.loads(Path(__file__).with_name('ukraine_temperature_stations.json').read_text())['stations']
        observations=ukraine(ua_download(),metadata)
    else:raise ValueError('Unknown eastern wind country')
    def one(path):
        try:
            raw,reference=bulletin_download(BASE+path);parts=path.split('/')[-1].split('.')
            return synop(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,now)
        except Exception as e:print(country,'SYNOP unavailable',path,str(e)[:140],flush=True);return []
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        for rows in pool.map(one,BULLETINS[country]):observations.extend(rows)
    return finalize(country,metadata,observations,now)
