"""Official SYNOP and airport temperatures, with bounded, dated NOAA bulletins."""
import concurrent.futures as futures
import datetime as dt
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

import update_official_temperature as core
from eastern_temperature import number
from southeast_temperature import parse_airports

BOUNDS={'ME':(41.8,43.6,18.4,20.5),'GR':(34.7,41.8,19.3,29.8),'AL':(39.6,42.7,19.2,21.1)}
SOURCES={'ME':'ZHMS Montenegro official SYNOP reports via NOAA WMO feed; official airport METAR/SPECI via NOAA AWC',
         'GR':'HNMS Greece official SYNOP reports via NOAA WMO feed; official airport METAR/SPECI via NOAA AWC',
         'AL':'Official Albanian SYNOP reports via NOAA WMO feed, airport METAR/SPECI via NOAA AWC and SYNOP via DWD'}
BASE='https://tgftp.nws.noaa.gov/data/raw/'
BULLETINS={'ME':['sm/smmk10.lypg..txt','si/siyg20.lybm..txt'],
 'AL':['sm/smab11.zati..txt','si/siab30.zati..txt'],
 'GR':['sm/smgr01.lgat..txt','sm/smgr20.lgat..txt','sm/smgr21.lgat..txt',
       'si/sigr20.lgat..txt','si/sigr21.lgat..txt','si/sigr22.lgat..txt']}
UTC=dt.timezone.utc


def download_bulletin(url):
    req=urllib.request.Request(url,headers={'User-Agent':core.USER_AGENT})
    with urllib.request.urlopen(req,timeout=25) as response:
        raw=response.read(512*1024+1);modified=response.headers.get('Last-Modified')
    if len(raw)>512*1024 or not modified:raise ValueError('Undated or oversized NOAA SYNOP bulletin')
    reference=parsedate_to_datetime(modified)
    if reference.tzinfo is None:raise ValueError('NOAA file time lacks UTC offset')
    return raw,reference.astimezone(UTC)


def observation_time(day,hour,reference):
    candidates=[]
    for shift in (-1,0,1):
        month=(reference.year*12+reference.month-1)+shift;year,m=divmod(month,12)
        try:candidates.append(dt.datetime(year,m+1,day,hour,tzinfo=UTC))
        except ValueError:pass
    if not candidates:raise ValueError('Invalid SYNOP observation date')
    when=min(candidates,key=lambda t:abs((t-reference).total_seconds()))
    if not -3600<=(reference-when).total_seconds()<=36*3600:raise ValueError('SYNOP report inconsistent with file date')
    return int(when.timestamp())


def parse_bulletin(raw,reference,expected,metadata,now):
    if reference.tzinfo is None or not -60<=(now-reference).total_seconds()<=86400:raise ValueError('NOAA bulletin file is stale or undated')
    text=raw.decode('ascii') if isinstance(raw,bytes) else raw
    if len(text)>512*1024:raise ValueError('SYNOP bulletin too large')
    heading=re.match(r'\s*([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})(?:\s+[A-Z]{3})?\s*\n',text)
    if not heading or (heading[1],heading[2])!=expected:raise ValueError('Unexpected WMO bulletin identity')
    body=text[heading.end():];match=re.match(r'\s*AAXX\s+(\d{5})\s+',body)
    if not match:raise ValueError('Only fixed-land AAXX reports are accepted')
    group=match[1];day,hour=int(group[:2]),int(group[2:4])
    if heading[3][:4]!=group[:4] or hour>23:raise ValueError('SYNOP observation header changed')
    stamp=observation_time(day,hour,reference)
    out=[]
    for report in body[match.end():].split('='):
        tokens=report.split()
        if len(tokens)<4 or tokens[0] not in metadata or tokens[1]=='NIL':continue
        # WMO FM-12 section 1: station, iRiXhVV, Nddff, [00fff],
        # 1snTTT. Never use section 3 maxima/minima or section 5 fields.
        if not re.fullmatch(r'[0-9/]{5}',tokens[1]) or not re.fullmatch(r'[0-9/]{5}',tokens[2]):continue
        section=[]
        for token in tokens[3:]:
            if token in ('222','333','444','555') or token.startswith('222'):break
            section.append(token)
        temperatures=[t for t in section if re.fullmatch(r'1[01]\d{3}',t)]
        if len(temperatures)!=1:continue
        group=temperatures[0];value=int(group[2:])/10*(-1 if group[1]=='1' else 1)
        value=number(value,-89.99,54.99)
        if value is not None:out.append((metadata[tokens[0]],stamp,value))
    return out


def finalize(country,observations,now):
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    grouped={};end=int(now.timestamp())
    for m,t,value,source in observations:
        code=m['code'];age=7*3600 if country in ('ME','GR') and code.startswith('SYNOP-') else (4 if country=='AL' else 2)*3600
        if not end-86400<=t<=end+60 or value is None:continue
        entry=grouped.setdefault(code,dict(meta=m,rows={},age=age,source=source))
        entry['rows'][t]=[t,value]
        if t>=max(entry['rows']):entry['source']=source
    out=[]
    for code,g in grouped.items():
        if max(g['rows'])<end-g['age']:continue
        m=g['meta'];s=core.make_station(country,code,m['name'],m['lat'],m['lon'],list(g['rows'].values()))
        if s:s['source']=g['source'];out.append(s)
    return out


def load(country,now,download=core.download,bulletin_download=download_bulletin):
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    metadata=json.loads(Path(__file__).with_name('adriatic_greece_temperature_stations.json').read_text())['stations'][country]
    observations=[]
    if country=='AL':
        try:
            from southeast_temperature import load as previous
            for s in previous('AL',now,download):
                m={k:s[k] for k in ('code','name','lat','lon')}
                observations.extend((m,r[0],r[1],s['source']) for r in s['rows'])
        except Exception as error:print('AL existing airport feed unavailable:',str(error)[:140],flush=True)
    else:
        airports={m['icao']:m for m in metadata.values() if m.get('icao')}
        codes=sorted(airports)
        for start in range(0,len(codes),24):
            try:
                url='https://aviationweather.gov/api/data/metar?'+urllib.parse.urlencode(dict(ids=','.join(codes[start:start+24]),format='json',hours=2))
                for s in parse_airports(country,json.loads(download(url)),airports,now):
                    m={k:s[k] for k in ('code','name','lat','lon')}
                    observations.extend((m,r[0],r[1],s['source']) for r in s['rows'])
            except Exception as error:print(country,'airport observations unavailable:',str(error)[:140],flush=True)
    def one(path):
        try:
            raw,reference=bulletin_download(BASE+path)
            parts=path.split('/')[-1].split('.')
            rows=parse_bulletin(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,now)
            return [(m,t,v,SOURCES[country]+' · nominal UTC SYNOP hour') for m,t,v in rows]
        except Exception as error:print(country,path,'unavailable:',str(error)[:140],flush=True);return []
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        for rows in pool.map(one,BULLETINS[country]):observations.extend(rows)
    out=finalize(country,observations,now)
    if not out:raise ValueError('No recent official '+country+' temperatures')
    return out
