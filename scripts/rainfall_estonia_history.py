"""Recover missing official XML hours from the University of Tartu archive.

The national XML publishes only the latest hour. The archive preserves those
same hourly measurements; it is not used to estimate or distribute rainfall.
"""
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import gzip
import json
import math
from pathlib import Path
import re
import threading
import time
import unicodedata
import urllib.request

BASE = 'https://explorer.kliima.ut.ee/data/station_xml/'
STATE = Path(__file__).resolve().parents[1]/'data/estonia-rain-history-state.json'


def fetch(path):
    request=urllib.request.Request(BASE+path,headers={'User-Agent':'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page','Accept-Encoding':'gzip'})
    with urllib.request.urlopen(request,timeout=12) as response:
        raw=response.read(8*1024*1024+1)
    if len(raw)>8*1024*1024:raise ValueError('Archive file exceeds limit')
    if raw[:2]==b'\x1f\x8b':raw=gzip.decompress(raw)
    return json.loads(raw)


def name(value):
    return ''.join(c for c in unicodedata.normalize('NFKD',str(value).lower()) if c.isalnum())


def number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and 0<=value<=1000


def recover(now,current,previous,reader=fetch,state_path=STATE):
    end=int(now.timestamp())//3600*3600;cutoff=end-72*3600
    known={s['code']:dict(zip(s.get('times',[]),s.get('amounts',[]))) for s in previous if s['country']=='EE'}
    for s in current:known.setdefault(s['code'],{}).update(zip(s['times'],s['amounts']))
    try:attempts=json.loads(state_path.read_text())
    except (OSError,ValueError):attempts={}
    wanted=[]
    for s in current:
        hours=known[s['code']];latest=max(hours,default=0)
        complete=latest>=end-3600 and all(number(hours.get(latest-i*3600)) for i in range(48))
        if not complete and now.timestamp()-attempts.get(s['code'],0)>=3600:wanted.append(s)
    if not wanted:return []
    manifest=reader('manifest.json.gz')
    if manifest.get('dataset')!='station_xml' or manifest.get('source')!='ilmateenistus observations XML':raise ValueError('Unexpected history archive source')
    if not any(v.get('key')=='precip' and v.get('unit')=='mm' and 'hour' in v.get('label','').lower() for v in manifest.get('variables',[])):
        raise ValueError('Archive does not describe measured hourly precipitation')
    metadata={name(s.get('name')):s for s in manifest.get('stations',[]) if 'precip' in s.get('fields',[])}
    first=dt.datetime.fromtimestamp(cutoff,dt.timezone.utc).date();last=now.date()
    periods=[p for p in manifest.get('periods',[]) if re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?',p.get('key','')) and dt.date.fromisoformat(p['end'])>=first and dt.date.fromisoformat(p['start'])<=last]
    periods=sorted(periods,key=lambda p:p['start'],reverse=True)[:4]
    deadline=time.monotonic()+120;failures=threading.Event()
    def one(station):
        meta=metadata.get(name(station['name']))
        if not meta or not re.fullmatch(r'[a-z0-9-]{1,80}',str(meta.get('id',''))):return None
        if abs(float(meta['lat'])-station['lat'])>.02 or abs(float(meta['lon'])-station['lon'])>.03:return None
        values={};attempted=False
        for period in periods:
            if time.monotonic()>=deadline or failures.is_set():break
            if meta['id'] not in period.get('stations',[meta['id']]):continue
            attempted=True
            try:series=reader(meta['id']+'/'+period['key']+'.json.gz')
            except Exception:
                # Stop a failing mirror quickly; live XML is independent.
                failures.set();break
            for row in series.get('precip',[]):
                if not isinstance(row,list) or len(row)!=2 or not number(row[1]):continue
                try:stamp=dt.datetime.fromisoformat(row[0].replace('Z','+00:00'))
                except (AttributeError,TypeError,ValueError):continue
                if stamp.tzinfo is None:continue
                t=int(stamp.timestamp())
                if cutoff<=t<=end and t%3600==0 and t not in known[station['code']]:values[t]=float(row[1])
        if attempted:attempts[station['code']]=int(now.timestamp())
        if not values:return None
        times=sorted(values)
        return {**station,'times':times,'amounts':[values[t] for t in times],'traces':[]}
    with ThreadPoolExecutor(max_workers=3) as pool:recovered=[s for s in pool.map(one,wanted) if s]
    state_path.parent.mkdir(parents=True,exist_ok=True)
    temporary=state_path.with_suffix('.tmp');temporary.write_text(json.dumps(attempts));temporary.replace(state_path)
    print('EE recovered archived official hours:',sum(len(s['times']) for s in recovered),'across',len(recovered),'gauges',flush=True)
    return recovered
