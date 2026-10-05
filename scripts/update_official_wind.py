"""Hourly shared snapshots of official EE/FI station wind; never substitute models.

EE exposes a feed timestamp, not per-station observation timestamps. Keep that
meaning explicit. FMI supplies actual observation times. Native values and gaps
remain intact; readings are not interpolated or treated as hourly peak gusts.
"""
import concurrent.futures as futures
import datetime as dt
import gzip
import json
import math
import pathlib
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/official-wind.json'
SOURCES = {
    'EE': dict(name='Estonian Environment Agency / Keskkonnaagentuur',url='https://www.ilmateenistus.ee/',timeKind='feed',period='Latest reported mean wind and gust; feed updates every 10 minutes.'),
    'FI': dict(name='Finnish Meteorological Institute (FMI)',url='https://en.ilmatieteenlaitos.fi/open-data',timeKind='observation',period='10-minute mean wind and reported 10-minute gust maximum, sampled hourly.',license='CC BY 4.0'),
}

def number(value,maximum=100):
    if value is None or isinstance(value,bool) or str(value).strip()=='': return None
    try: n=float(value)
    except (ValueError,TypeError): return None
    return round(n,2) if math.isfinite(n) and 0<=n<=maximum else None

def local(el): return el.tag.split('}')[-1]
def download(url):
    req=urllib.request.Request(url,headers={'User-Agent':'NorthernWeather/8.57 (github.com/Snowblind54/weather-page)','Accept-Encoding':'gzip'})
    with urllib.request.urlopen(req,timeout=35) as r: raw=r.read(8*1024*1024+1)
    if len(raw)>8*1024*1024: raise ValueError('Wind response too large')
    return gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw

def station(country,code,name,lat,lon,rows):
    lat,lon=float(lat),float(lon)
    if not (53<=lat<=72 and 18<=lon<=33): raise ValueError('Station outside EE/FI bounds')
    readings={}
    for stamp,speed,gust,direction in rows:
        stamp=int(float(stamp));speed=number(speed);gust=number(gust);direction=number(direction,360)
        if speed is None and gust is None: continue
        readings[stamp]=[stamp,speed,gust,direction]
    return dict(country=country,code=str(code),name=str(name),lat=round(lat,6),lon=round(lon,6),rows=[readings[t] for t in sorted(readings)])

def parse_estonia(raw):
    root=ET.fromstring(raw)
    stamp=int(root.attrib['timestamp']);result=[]
    for el in root.findall('station'):
        speed,gust=number(el.findtext('windspeed')),number(el.findtext('windspeedmax'))
        if speed is None and gust is None: continue
        name=el.findtext('name') or 'Estonian station'
        result.append(station('EE',el.findtext('wmocode') or name,name,el.findtext('latitude'),el.findtext('longitude'),[(stamp,speed,gust,el.findtext('winddirection'))]))
    return result

def parse_finland(raw):
    root=ET.fromstring(raw)
    errors=[e.text or '' for e in root.iter() if local(e)=='ExceptionText']
    if errors: raise ValueError('FMI: '+' '.join(errors))
    points={}
    for p in root.iter():
        if local(p)!='Point': continue
        ident=next((v for k,v in p.attrib.items() if k.split('}')[-1]=='id'),'')
        pos=next((e.text or '' for e in p.iter() if local(e)=='pos'),'').split()
        if ident and len(pos)==2: points[ident]=pos
    metadata={}
    for el in root.iter():
        if local(el)!='Location': continue
        ident=next((e.text for e in el.iter() if local(e)=='identifier' and 'fmisid' in e.attrib.get('codeSpace','')),'')
        name=next((e.text for e in el.iter() if local(e)=='name' and e.attrib.get('codeSpace','').endswith('/name')),'FMI station')
        href=next((v for e in el.iter() if local(e)=='representativePoint' for k,v in e.attrib.items() if k.split('}')[-1]=='href'),'')
        pos=points.get(href.lstrip('#'))
        if pos: metadata[(round(float(pos[0]),5),round(float(pos[1]),5))]=(ident,name)
    grouped={}
    for coverage in root.iter():
        if local(coverage)!='MultiPointCoverage': continue
        fields=[e.attrib.get('name','').lower() for e in coverage.iter() if local(e)=='field']
        needed=['ws_10min','wg_10min','wd_10min']
        if len(set(fields))!=len(fields) or not all(p in fields for p in needed): raise ValueError('FMI wind fields missing/duplicated')
        coords=next((e.text or '' for e in coverage.iter() if local(e)=='positions'),'').split()
        values=next((e.text or '' for e in coverage.iter() if local(e)=='doubleOrNilReasonTupleList'),'').split()
        if not fields or len(coords)%3 or len(values)!=len(coords)//3*len(fields): raise ValueError('FMI wind coordinates and values do not match')
        indices=[fields.index(p) for p in needed]
        for i in range(len(coords)//3):
            lat,lon,stamp=map(float,coords[i*3:i*3+3]);key=(round(lat,5),round(lon,5))
            if key not in metadata: continue  # Never silently invent station identities.
            code,name=metadata[key]
            speed,gust,direction=[values[i*len(fields)+j] for j in indices]
            grouped.setdefault(key,[code,name,lat,lon,[]])[4].append((stamp,speed,gust,direction))
    return [station('FI',*record) for record in grouped.values()]

def load_estonia(now):
    return parse_estonia(download('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php'))
def load_finland(now):
    end=now.replace(minute=0,second=0,microsecond=0)
    params=dict(service='WFS',version='2.0.0',request='getFeature',storedquery_id='fmi::observations::weather::multipointcoverage',bbox='19,59,32,71.7',starttime=(end-dt.timedelta(hours=3)).isoformat(),endtime=end.isoformat(),timestep=60,parameters='ws_10min,wg_10min,wd_10min')
    return parse_finland(download('https://opendata.fmi.fi/wfs?'+urllib.parse.urlencode(params)))

def merge(previous,current,now):
    cutoff=int(now.timestamp())-24*3600;limit=int(now.timestamp())+60;stations={}
    for s in previous+current:
        key=(s['country'],s['code']);old=stations.get(key,{}).get('rows',[])
        rows={r[0]:r for r in old+s['rows'] if cutoff<=r[0]<=limit}
        if rows: stations[key]={**s,'rows':[rows[t] for t in sorted(rows)]}
    return sorted(stations.values(),key=lambda s:(s['country'],s['code']))

def main():
    now=dt.datetime.now(dt.timezone.utc)
    try: previous=json.loads(OUTPUT.read_text())
    except (OSError,ValueError): previous={}
    old=previous.get('stations',[]);results=[];sources={}
    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending={pool.submit(loader,now):country for country,loader in [('EE',load_estonia),('FI',load_finland)]}
        for task in futures.as_completed(pending):
            country=pending[task]
            try:
                rows=task.result()
                if not any(s['rows'] and s['rows'][-1][0]>=int(now.timestamp())-3*3600 for s in rows): raise ValueError('No current measured wind observations')
                results+=rows;sources[country]={**SOURCES[country],'status':'ok','fetchedAt':int(now.timestamp())}
                print(country,len([s for s in rows if s['rows']]),'official wind stations',flush=True)
            except Exception as error:
                print(country,'unavailable:',str(error)[:250],flush=True)
                sources[country]={**SOURCES[country],'status':'unavailable','error':str(error)[:200],'fetchedAt':previous.get('sources',{}).get(country,{}).get('fetchedAt')}
    stations=merge(old,results,now)
    if not results: raise ValueError('Both official wind feeds unavailable; retaining previous snapshot')
    snapshot=dict(version=1,generatedAt=int(now.timestamp()),refreshMinutes=60,units='m/s',sources=sources,stations=stations)
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',dir=OUTPUT.parent,delete=False) as f:
        json.dump(snapshot,f,separators=(',',':'),ensure_ascii=False,allow_nan=False);f.write('\n');name=f.name
    pathlib.Path(name).replace(OUTPUT)
    print('Published',len(stations),'stations;',OUTPUT.stat().st_size,'bytes',flush=True)
if __name__=='__main__': main()
