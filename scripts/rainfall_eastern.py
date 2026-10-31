"""Official Ukrainian/Romanian SYNOP rain and HungaroMet gauge histories.

Missing intervals are never filled with zero or divided from longer totals.
Hungarian daily rau is explicitly 06–06 UTC, not a rolling total to now.
"""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
from pathlib import Path
import re
import zipfile
import urllib.parse

import update_rainfall as core
import rainfall_europe as europe
from adriatic_greece_temperature import BASE, download_bulletin, observation_time
from official_wind_eastern import BULLETINS as EASTERN_BULLETINS
from official_wind_balkans import BULLETINS as BALKAN_BULLETINS

BOUNDS={'BA':(42.5,45.4,15.6,19.7),'ME':(41.8,43.6,18.4,20.5),'XK':(41.8,43.3,20,21.9),'GR':(34.7,41.8,19.3,29.8),'RS':(42.2,46.3,18.8,23.1),'BG':(41.2,44.3,22.2,28.8),'HR':(42.2,46.7,13.1,19.5),'UA':(44,52.5,22,40.5),'RO':(43.5,48.5,20,30),'HU':(45.7,48.7,16,23)}
UA_WIS='https://wis2.meteo.gov.ua/oapi/collections/urn:wmo:md:ua-hmc:aws1h/items'
HU_BASE='https://odp.met.hu/weather/weather_reports/synoptic/hungary/'
SOURCES={'UA':('Ukrainian Hydrometeorological Center / WIS2 automatic gauges with official SYNOP backup',UA_WIS),
         'RO':('Administrația Națională de Meteorologie (ANM) / official SYNOP via NOAA and DWD',europe.POI),
         'HU':('HungaroMet / official hourly automatic rain gauges and 06–06 UTC daily totals',HU_BASE)}
PERIODS={c:'Official national SYNOP precipitation in mm, with actual UTC observation times. Explicit one-hour reports are used for 1h; longer reports are never divided into invented hours. Complete, non-overlapping measured intervals form 24/48h totals. The shared 72-hour history builds automatically; incomplete windows remain unavailable. Delayed totals retain their actual ending times.' for c in ('UA','RO')}
PERIODS['UA']='UHMC WIS2 provisional measured precipitation/water equivalent: explicit 1-, 3-, 6-, 12- and 24-hour intervals, with native UTC start and end times. kg m-2 equals mm. Only adjacent complete intervals from the same WIGOS station form 24/48h totals. Official SYNOP observations supplement coverage. Missing, future, unknown-station and wrong-unit reports are excluded; no interval is divided into invented hourly rain.'
PERIODS['HU']='HungaroMet provisional hourly precipitation r in mm, at native UTC clock hours. Daily rau covers 06 UTC on the stated date to 06 UTC the following day. Only complete adjacent intervals from the same station form 24/48h totals. Daily-based totals retain their actual 06 UTC ending time; missing/sentinel values stay unavailable. Source quality columns are reserved for development, not quality-approved flags.'
TR_HOURS={'1':6,'2':12,'3':18,'4':24,'5':1,'6':2,'7':3,'8':9,'9':15}


def location(country,lat,lon):
    try:lat,lon=float(lat),float(lon)
    except (ValueError,TypeError):return False
    s,n,w,e=BOUNDS[country]
    return s<=lat<=n and w<=lon<=e


def parse_bulletin(raw,reference,expected,metadata,country,now,include_daily=False):
    if reference.tzinfo is None or not -60<=(now-reference).total_seconds()<=86400:raise ValueError('Stale or undated SYNOP rain bulletin')
    text=raw.decode('ascii') if isinstance(raw,bytes) else raw
    if len(text)>512*1024:raise ValueError('Oversized SYNOP rain bulletin')
    h=re.match(r'\s*([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})(?:\s+[A-Z]{3})?\s*\n',text)
    if not h or (h[1],h[2])!=expected:raise ValueError('Unexpected SYNOP rain identity')
    body=text[h.end():];a=re.match(r'\s*AAXX\s+(\d{5})\s+',body)
    if not a or a[1][:4]!=h[3][:4] or int(a[1][2:4])>23:raise ValueError('Invalid SYNOP rain time')
    t=observation_time(int(a[1][:2]),int(a[1][2:4]),reference)
    if not int(now.timestamp())-72*3600<=t<=int(now.timestamp()):return []
    out=[]
    for report in body[a.end():].split('='):
        tokens=report.split()
        if len(tokens)<3 or tokens[0] not in metadata or not re.fullmatch(r'[0-4][\d/]{4}',tokens[1]):continue
        code=tokens[0];m=metadata[code]
        if not location(country,m['lat'],m['lon']):continue
        section=1;groups={1:[],3:[]};daily=[];changed=False
        for g in tokens[3:]:
            if g in ('444','555'):break
            if g.startswith('222'):section=2;continue
            if g=='333':section=3;continue
            if section==1 and re.fullmatch(r'9\d{4}',g):changed=True
            if section in groups and re.fullmatch(r'6\d{4}',g):groups[section].append(g)
            if section==3 and re.fullmatch(r'7\d{4}',g):daily.append(g)
        if changed:continue
        rows=[];periods=[]
        for sec,gg in groups.items():
            if len(gg)!=1 or tokens[1][0] not in (('0','1') if sec==1 else ('0','2')):continue
            g=gg[0];hours=TR_HOURS.get(g[4]);rrr=int(g[1:4])
            if hours not in (1,3,6,12,24):continue
            trace=rrr==990;v=0 if trace else rrr if rrr<990 else (rrr-990)/10
            if hours==1:rows.append((t,v,trace))
            else:periods.append(dict(end=t,hours=hours,value=v))
        if include_daily and len(daily)==1 and tokens[1][0]!='4':
            # WMO FM-12 section 3: 24h total in tenths of mm, ending now.
            # 9999 is trace and 9998 is a lower bound, not exact numeric totals.
            n=int(daily[0][1:])
            if n<9998:periods.append(dict(end=t,hours=24,value=n/10))
        if rows or periods:
            s=core.station(country,code,m['name'],m['lat'],m['lon'],rows);s['periods']=periods;out.append(s)
    return out


def load_synop(country,now,previous,download=core.download,bulletin_download=download_bulletin):
    poi=json.loads(Path(__file__).with_name('eastern_rain_stations.json').read_text())['stations'][country]
    metadata=json.loads(Path(__file__).with_name('ukraine_temperature_stations.json' if country=='UA' else 'romania_wind_stations.json').read_text())['stations']
    def one(pair):
        code,m=pair
        try:return europe.parse_synop(download(europe.POI+code+'-BEOB.csv',False),code,m)
        except Exception as e:print(country,'rain gauge',code,'unavailable:',str(e)[:100],flush=True)
    with futures.ThreadPoolExecutor(max_workers=4) as pool:out=[s for s in pool.map(one,poi.items()) if s]
    for path in (EASTERN_BULLETINS['UA'] if country=='UA' else BALKAN_BULLETINS['RO']):
        try:
            raw,reference=bulletin_download(BASE+path);parts=path.split('/')[-1].split('.')
            out.extend(parse_bulletin(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,country,now))
        except Exception as e:print(country,'rain bulletin unavailable',path,str(e)[:100],flush=True)
    if country=='UA':
        try:out.extend(load_ukraine_wis(now,previous,download))
        except Exception as e:print('UA WIS2 rain unavailable:',str(e)[:150],flush=True)
    return europe.trimmed(out,now)


def parse_ukraine_wis(features,metadata,now):
    groups={};end=int(now.timestamp())
    for f in features:
        p=f.get('properties') or {};coords=(f.get('geometry') or {}).get('coordinates') or []
        wigos=p.get('wigos_station_identifier');match=re.fullmatch(r'0-20000-0-(\d{5})',wigos or '')
        if not match or match[1] not in metadata or (f.get('geometry') or {}).get('type')!='Point' or len(coords)!=2:continue
        code=match[1]
        if not location('UA',coords[1],coords[0]) or p.get('name')!='total_precipitation_or_total_water_equivalent' or p.get('units')!='kg m-2':continue
        # 1 kg m-2 liquid-water equivalent equals exactly 1 mm. A reported
        # 6h/24h amount never becomes a 1h amount; use its explicit interval.
        value=core.amount(p.get('value'));period=p.get('phenomenonTime')
        if value is None or not isinstance(period,str) or period.count('/')!=1:continue
        try:
            dates=[dt.datetime.fromisoformat(v.replace('Z','+00:00')) for v in period.split('/')]
            reported=dt.datetime.fromisoformat(p['reportTime'].replace('Z','+00:00'))
            if any(v.tzinfo is None for v in dates+[reported]):continue
            start,t=[int(v.timestamp()) for v in dates];hours=(t-start)/3600
        except (ValueError,TypeError,KeyError):continue
        if hours not in (1,3,6,12,24) or t%3600 or start%3600 or t!=int(reported.timestamp()) or not end-72*3600<=t<=end:continue
        s=groups.setdefault(code,core.station('UA',code,metadata[code]['name'],coords[1],coords[0],[]))
        if abs(s['lat']-float(coords[1]))>.001 or abs(s['lon']-float(coords[0]))>.001:raise ValueError('UHMC WIS2 gauge coordinates changed')
        s.setdefault('periods',[])
        if hours==1:s['times'].append(t);s['amounts'].append(value)
        else:s['periods'].append(dict(end=t,hours=int(hours),value=value))
    return list(groups.values())


def load_ukraine_wis(now,previous,download=core.download):
    end=int(now.timestamp());latest=max((t for s in previous if s['country']=='UA' for t in s['times']),default=end-72*3600)
    start=max(end-72*3600,latest-6*3600)
    stamp=lambda t:dt.datetime.fromtimestamp(t,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    params=dict(f='json',limit=10000,datetime=stamp(start)+'/'+stamp(end),name='total_precipitation_or_total_water_equivalent',sortby='reportTime')
    url=UA_WIS+'?'+urllib.parse.urlencode(params);seen=set();features=[]
    for _ in range(4):
        if url in seen:raise ValueError('Repeated UHMC WIS2 page')
        seen.add(url);p=download(url);rows=p.get('features')
        if p.get('type')!='FeatureCollection' or not isinstance(rows,list) or len(rows)>10000:raise ValueError('Invalid UHMC WIS2 rain page')
        features.extend(rows)
        next_url=next((l['href'] for l in p.get('links',[]) if l.get('rel')=='next'),None)
        if not next_url:break
        parsed=urllib.parse.urlsplit(next_url);base=urllib.parse.urlsplit(UA_WIS)
        if (parsed.scheme,parsed.netloc,parsed.path)!=(base.scheme,base.netloc,base.path):raise ValueError('Unexpected UHMC WIS2 pagination destination')
        url=next_url
    else:raise ValueError('UHMC WIS2 rain response exceeds bounded history')
    metadata=json.loads(Path(__file__).with_name('ukraine_temperature_stations.json').read_text())['stations']
    result=parse_ukraine_wis(features,metadata,now)
    if not result:raise ValueError('No current UHMC WIS2 gauge rain')
    return result


def parse_hungary(raw,now,daily=False,expected_day=None):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        pattern=r'HABP_1D_\d{8}\.csv' if daily else r'HABP_1H_SYNOP_\d{14}\.csv'
        files=[f for f in archive.infolist() if re.fullmatch(pattern,f.filename)]
        if len(files)!=1 or files[0].file_size>8*1024*1024:raise ValueError('Unexpected HungaroMet rain archive')
        reader=csv.DictReader(io.StringIO(archive.read(files[0]).decode('utf-8-sig')),delimiter=';')
        reader.fieldnames=[k.strip() for k in reader.fieldnames or []]
        field='rau' if daily else 'r'
        if not {'Time','StationNumber','StationName','Latitude','Longitude',field,'Q_'+field}<=set(reader.fieldnames):raise ValueError('HungaroMet precipitation columns changed')
        groups={};end=int(now.timestamp())
        for r in reader:
            code=r['StationNumber'].strip();date=r['Time'].strip()
            if not re.fullmatch(r'\d{5}',code) or not location('HU',r['Latitude'],r['Longitude']):continue
            if daily and (expected_day is None or date!=expected_day or files[0].filename!='HABP_1D_'+expected_day+'.csv'):continue
            try:
                when=dt.datetime.strptime(date,'%Y%m%d' if daily else '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc)
                if daily:when+=dt.timedelta(days=1,hours=6)
                t=int(when.timestamp())
            except ValueError:continue
            v=core.amount(r[field].strip())
            if v is None or t%3600 or not end-72*3600<=t<=end:continue
            # Currently blank/reserved quality columns: reject unexpected flags.
            if r['Q_'+field].strip():continue
            lat,lon=float(r['Latitude']),float(r['Longitude'])
            s=groups.setdefault(code,core.station('HU','HUMET-'+code,r['StationName'].strip(),lat,lon,[]))
            if abs(s['lat']-lat)>.001 or abs(s['lon']-lon)>.001:raise ValueError('HungaroMet rain station moved')
            if daily:s.setdefault('periods',[]).append(dict(end=t,hours=24,value=v))
            else:s['times'].append(t);s['amounts'].append(v)
        return list(groups.values())


def load_hungary(now,previous,download=core.download):
    end=int(now.timestamp())//3600*3600;out=[]
    prior=[s for s in previous if s['country']=='HU' and s['code'].startswith('HUMET-')]
    latest=max((t for s in prior for t in s['times']),default=end-26*3600)
    listing=download(HU_BASE+'hourly/csv/',False).decode('latin1')
    names=sorted(set(re.findall(r'href="(HABP_1H_SYNOP_\d{14}\.csv.zip)"',listing)))
    if not names or len(names)>100:raise ValueError('HungaroMet hourly archive changed')
    cutoff=max(end-26*3600,latest-3*3600)
    names=[n for n in names if cutoff<=int(dt.datetime.strptime(n[14:28],'%Y%m%d%H%M%S').replace(tzinfo=dt.timezone.utc).timestamp())<=end+3600]
    def one(name):
        try:return parse_hungary(download(HU_BASE+'hourly/csv/'+name,False),now)
        except Exception as e:print('HU hourly rain unavailable',name,str(e)[:100],flush=True);return []
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        for rows in pool.map(one,names):out.extend(rows)
    # Three completed daily windows seed 48h immediately where both days exist.
    for days in range(3):
        day=(now-dt.timedelta(days=days+1)).strftime('%Y%m%d')
        try:out.extend(parse_hungary(download(HU_BASE+'daily/csv/HABP_1D_'+day+'.csv.zip',False),now,True,day))
        except Exception as e:print('HU daily rain unavailable',day,str(e)[:100],flush=True)
    if not out:raise ValueError('No official Hungarian rainfall')
    return europe.trimmed(out,now)


def install(target):
    target.SOURCES.update(SOURCES)
    target.LOADERS.update({c:(lambda now,previous,c=c:load_synop(c,now,previous)) for c in ('UA','RO')})
    target.LOADERS['HU']=load_hungary
