"""MGM measured rolling rain and consecutive 06–06 UTC daily totals.

Rolling 1/24-hour totals retain the provider's minute-resolution ending time.
Daily reports are complete measured days, never reset-to-midnight counters.
Two consecutive daily reports at the same gauge are required for 48 hours.
"""
import concurrent.futures as futures
import datetime as dt
import json
import re

import update_rainfall as core
from mediterranean_temperature import download_turkey, TR_METADATA, TR_OBSERVATIONS

BOUNDS=(35.8,42.2,25.6,45)
BASE='https://servis.mgm.gov.tr/web/sondurumlar/'
SOURCE=('Meteoroloji Genel Müdürlüğü (MGM) / official Turkish rain gauges','https://www.mgm.gov.tr/sondurum/toplam-yagis.aspx')
PERIOD=('MGM provisional measured precipitation in mm. Rolling 1-hour and 24-hour totals retain their actual UTC ending minute. '
        'Daily totals end at 06:00 UTC; 48-hour totals require two consecutive complete daily reports from the same gauge. '
        'A 24-hour daily total supplements stations without a rolling report. Missing reports remain unavailable; '
        'midnight-to-now counters are not used. Daily and rolling windows may have different ending times.')
UTC=dt.timezone.utc


def stamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z',value):return None
    try:return int(dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())
    except ValueError:return None


def meta(row,code_field,name_field):
    code=str(row.get(code_field) or '')
    if not re.fullmatch(r'\d{5}',code) or row.get('il') in ('Yurtdışı','Suriye'):return None
    try:lat=float(row['enlem']);lon=float(row['boylam'])
    except (KeyError,ValueError,TypeError):return None
    if isinstance(row['enlem'],bool) or isinstance(row['boylam'],bool) or not BOUNDS[0]<=lat<=BOUNDS[1] or not BOUNDS[2]<=lon<=BOUNDS[3]:return None
    name=str(row.get(name_field) or '').strip()
    if not name:return None
    return code,dict(name=name,lat=lat,lon=lon)


def parse(daily,metadata,current,now):
    if not isinstance(metadata,list) or len(metadata)>200 or not isinstance(current,list) or len(current)>300:raise ValueError('MGM current rain product changed')
    end=int(now.timestamp());catalogue={};totals={};conflicts=set()
    def register(pair):
        if not pair:return None
        code,m=pair
        old=catalogue.get(code)
        if old and (abs(old['lat']-m['lat'])>.005 or abs(old['lon']-m['lon'])>.005):conflicts.add(code)
        catalogue.setdefault(code,m)
        return code
    for expected,payload in daily:
        if not isinstance(payload,list) or not 1<=len(payload)<=4000:raise ValueError('MGM daily rain product changed')
        expected_time=stamp(expected)
        if expected_time is None or expected_time%86400!=6*3600:raise ValueError('MGM daily end must be 06 UTC')
        for r in payload:
            if not isinstance(r,dict):continue
            code=register(meta(r,'istNo','istAd'));t=stamp(r.get('tarih'));v=core.amount(r.get('deger'))
            if code is None or t!=expected_time or v is None or not end-72*3600<=t<=end:continue
            key=(t,24)
            values=totals.setdefault(code,{})
            if key in values and values[key]!=v:conflicts.add(code)
            values[key]=v
    # Derive a fixed 48 h interval only from adjoining 24 h daily intervals.
    for values in totals.values():
        for (t,h),v in list(values.items()):
            prior=values.get((t-86400,24))
            if prior is not None and core.amount(v+prior) is not None:values[(t,48)]=round(v+prior,3)
    known={}
    for m in metadata:
        if not isinstance(m,dict):continue
        pair=meta(m,'sondurumIstNo','il');code=register(pair)
        if code is not None:known[code]=pair[1]
    seen={}
    for r in current:
        if not isinstance(r,dict):continue
        code=str(r.get('istNo') or '');t=stamp(r.get('veriZamani'))
        if code not in known or t is None or not end-2*3600<=t<=end:continue
        for hours,field in [(1,'yagis1Saat'),(24,'yagis24Saat')]:
            v=core.amount(r.get(field))
            if v is None:continue
            key=(code,t,hours)
            if key in seen and seen[key]!=v:conflicts.add(code)
            seen[key]=v
            totals.setdefault(code,{})[(t,hours)]=v
    result=[]
    for code,values in totals.items():
        if code in conflicts:continue
        m=catalogue[code];s=core.station('TR','MGM-'+code,m['name'],m['lat'],m['lon'],[])
        s['accumulations']=[dict(end=t,hours=h,value=values[t,h]) for t,h in sorted(values)]
        if s['accumulations']:result.append(s)
    if not result:raise ValueError('No recent official Turkish precipitation')
    return result


def load(now,previous,download=download_turkey):
    dates=json.loads(download(BASE+'yagisMaxTarih'))
    if not isinstance(dates,list) or not dates or len(dates)>14:raise ValueError('MGM rain date catalogue changed')
    end=int(now.timestamp())
    dates=sorted({d for d in dates if (t:=stamp(d)) is not None and t%86400==21600 and end-72*3600<=t<=end},reverse=True)[:3]
    if not dates:raise ValueError('MGM rain bulletin is stale')
    def day(d):
        try:return d,json.loads(download(BASE+'toplamyagis?tarih='+d[:10]))
        except Exception as e:print('TR daily rain unavailable',d,str(e)[:120],flush=True);return None
    # Three small shared day files and two current station requests; no calls
    # per visitor, per pixel or per one of the ~1,750 daily gauges.
    with futures.ThreadPoolExecutor(max_workers=3) as pool:daily=[d for d in pool.map(day,dates) if d]
    try:metadata=json.loads(download(TR_METADATA));current=json.loads(download(TR_OBSERVATIONS))
    except Exception as e:print('TR rolling rain unavailable',str(e)[:120],flush=True);metadata=[];current=[]
    return parse(daily,metadata,current,now)


def install(target):
    target.SOURCES['TR']=SOURCE
    target.LOADERS['TR']=load
