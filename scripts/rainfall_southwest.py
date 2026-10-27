"""Official French, Andorran and Spanish precipitation, in mm and UTC.

Preserve native daily intervals. They may supplement complete hourly histories,
but are never divided into hourly amounts or relabelled as current rolling sums.
"""
import concurrent.futures as futures
import csv
import datetime as dt
import gzip
import io
import json
import pathlib
import re
import tarfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import update_rainfall as core
import rainfall_europe as europe
from iberia_observations import AEMET, aemet_names, point, stamp
from andorra_observations import BASE as ANDORRA, text as ad_text

BOUNDS={'FR':(41,51.5,-5.5,10),'AD':(42.4,42.7,1.4,1.8),'ES':(27,44.5,-19,5)}
SOURCES={
 'FR':('Météo-France / official SYNOP precipitation, distributed by DWD',europe.POI),
 'AD':('Servei Meteorològic Nacional / Meteo.ad','https://www.meteo.ad/'),
 'ES':('AEMET / Agencia Estatal de Meteorología',AEMET)}
PERIODS={
 'FR':'Official Météo-France SYNOP precipitation in mm. Native 1-, 3-, 6-, 12- and 24-hour reports retain their UTC observation times. The official annual SYNOP archive bootstraps history; DWD supplies current reports. Only complete non-overlapping intervals form 24/48-hour totals. Coverage is the reporting SYNOP subset, not the full national gauge network.',
 'AD':'Source: Servei Meteorològic Nacional / Meteo.ad. Hourly precipitation chart values retain their native UTC hour labels; the current chart hour is excluded. Climatological daily precipitation runs from 06:00 UTC on the labelled day to 06:00 UTC the next day. Two complete adjacent days can form a 48-hour total ending at 06:00 UTC; it is not a current rolling total. Missing hours stay unavailable; provisional.',
 'ES':'AEMET hourly precipitation in mm (native UTC interval ends), including the Balearic and Canary Islands. Calendar-day precipitation covers 00:00–24:00 UTC; the daily layer date is the labelled calendar day, not its map-generation offset. Daily reports can form complete 24/48-hour totals ending at midnight; actual ends are shown. Missing hours stay unavailable; provisional.'}


def parse_spain(raw,names,now):
    grouped={};count=0;size=0;end=int(now.timestamp())
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r|*') as archive:
        for m in archive:
            count+=1;size+=m.size
            if count>1500 or size>120*1024*1024:raise ValueError('AEMET rainfall archive exceeds bounds')
            kind='hourly' if re.fullmatch(r'horarios/prec/[^/]+\.geojson',m.name) else 'daily' if re.fullmatch(r'diarios/pre-0024/[^/]+\.geojson',m.name) else None
            if kind is None or not m.isfile():continue
            if m.size>4*1024*1024:raise ValueError('AEMET rainfall layer exceeds bounds')
            p=json.load(archive.extractfile(m))
            if p.get('type')!='FeatureCollection' or not isinstance(p.get('features'),list):raise ValueError('AEMET rainfall GeoJSON changed')
            for f in p['features']:
                geo=point(f,'ES')
                if not geo:continue
                lat,lon,v=geo;code=str(v.get('IDEMA') or '')
                if code not in names:continue
                if kind=='hourly':
                    t=stamp(v.get('FINT'));amount=core.amount(v.get('PREC'))
                else:
                    # FINIT labels the calendar date; its offset belongs to map
                    # generation/local display, not the published 00–24 UTC sum.
                    date=str(v.get('FINIT') or '')
                    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T00:00:00(?:[+-]\d{2}:\d{2}|Z)?',date):continue
                    try:t=int((dt.datetime.strptime(date[:10],'%Y-%m-%d').replace(tzinfo=dt.timezone.utc)+dt.timedelta(days=1)).timestamp())
                    except ValueError:continue
                    amount=core.amount(v.get('pre-0024'))
                if t is None or t%3600 or not end-72*3600<=t<=end or amount is None:continue
                s=grouped.setdefault(code,core.station('ES',code,names[code],lat,lon,[]))
                if kind=='hourly':s['times'].append(t);s['amounts'].append(amount)
                else:s.setdefault('periods',[]).append({'end':t,'hours':24,'value':amount})
    return europe.trimmed(list(grouped.values()),now)


def load_spain(now,previous):
    page=core.download(AEMET,False)
    text=page.decode('iso-8859-15')
    link=re.search(r'href="(/es/geojson/download/udat/udat_descarga_\d+\.tar\.gz)"',text)
    if not link:raise ValueError('AEMET official rainfall download link missing')
    return parse_spain(core.download(urllib.parse.urljoin(AEMET,link[1]),False),aemet_names(page),now)


def parse_andorra_chart(raw,code,meta,now):
    root=ET.fromstring(raw)
    labels=root.find('chart_data');rows=list(labels) if labels is not None else []
    if len(rows)!=2 or rows[1][0].text!='prec' or not any(x.text=='Hora UTC' for x in root.findall('./draw/text')) or not any(x.text=='mm' for x in root.findall('./draw/text')):
        raise ValueError('Andorran hourly precipitation chart units/schema changed')
    categories=list(rows[0])[1:];values=list(rows[1])[1:]
    if len(categories)!=len(values) or not 1<=len(values)<=25:raise ValueError('Andorran chart time axis changed')
    anchors=[]
    for i,x in enumerate(categories):
        if re.fullmatch(r'\d{2}/\d{2}/\d{4}',x.text or ''):
            anchors.append((i,int(dt.datetime.strptime(x.text,'%d/%m/%Y').replace(tzinfo=dt.timezone.utc).timestamp())))
    if not anchors:raise ValueError('Andorran chart absolute UTC date missing')
    anchor_i,anchor=anchors[0];samples=[];end=int(now.timestamp())//3600*3600
    for i,(label,v) in enumerate(zip(categories,values)):
        t=anchor+(i-anchor_i)*3600
        expected=dt.datetime.fromtimestamp(t,dt.timezone.utc)
        if label.text!=(expected.strftime('%d/%m/%Y') if expected.hour==0 else str(expected.hour)+'h'):
            raise ValueError('Andorran chart hour sequence changed')
        # Exclude the live/current-hour bin even if the provider publishes 0.
        if end-72*3600<=t<end and v.tag=='number':samples.append((t,v.text,False))
    return core.station('AD',code,meta['name'],meta['lat'],meta['lon'],samples)


def parse_andorra_day(payload,date,metadata,now):
    expected=dt.datetime.strptime(date,'%d/%m/%Y').replace(tzinfo=dt.timezone.utc)
    end=int((expected+dt.timedelta(days=1,hours=6)).timestamp())
    if not int(now.timestamp())-72*3600<=end<=int(now.timestamp()):return []
    out=[]
    for row in payload:
        if not isinstance(row,list) or len(row)<5:continue
        code=str(row[0]);meta=metadata.get(code)
        if not meta:continue
        label=re.search(r'\b\d{2}/\d{2}/\d{4}\b',ad_text(row[1]))
        match=re.fullmatch(r'(\d+(?:[.,]\d+)?)\s*mm',ad_text(row[4]))
        if not label or label[0]!=date or not match:continue
        amount=core.amount(match[1].replace(',','.'))
        if amount is None:continue
        s=core.station('AD',code,meta['name'],meta['lat'],meta['lon'],[])
        s['periods']=[{'end':end,'hours':24,'value':amount}];out.append(s)
    return out


def load_andorra(now,previous):
    metadata=json.loads(pathlib.Path(__file__).with_name('andorra_stations.json').read_text())['stations']
    # Discover reporting rain gauges through the official national map; unknown
    # IDs have no trusted coordinates and are never guessed from pixel positions.
    current=core.download(ANDORRA+'home/DadesActuals?idioma=0&pestanya=2&privat=&data=&esDiaries=false')
    ids={str(r[0]) for r in current if isinstance(r,list) and len(r)>=5 and str(r[0]) in metadata and re.fullmatch(r'\d+(?:[.,]\d+)?\s*mm',ad_text(r[4]))}
    if not ids or len(ids)>60:raise ValueError('Andorran rainfall catalogue missing/oversized')
    def collect(code):
        try:return parse_andorra_chart(core.download(ANDORRA+'home/sample?'+urllib.parse.urlencode({'codi':code,'camp':'prec','idioma':0}),False),code,metadata[code],now)
        except Exception as error:print('AD rain chart',code,'unavailable:',str(error)[:100],flush=True);return None
    with futures.ThreadPoolExecutor(max_workers=4) as pool:out=[s for s in pool.map(collect,sorted(ids)) if s]
    for days in (1,2,3):
        date=(now-dt.timedelta(days=days)).strftime('%d/%m/%Y')
        try:
            query=urllib.parse.urlencode({'idioma':0,'pestanya':3,'privat':'','data':date,'esDiaries':'true'})
            out.extend(parse_andorra_day(core.download(ANDORRA+'home/DadesActuals?'+query),date,metadata,now))
        except Exception as error:print('AD daily rain unavailable:',date,str(error)[:100],flush=True)
    return europe.trimmed(out,now)


def france_metadata():
    return {k:v for k,v in json.loads(pathlib.Path(__file__).with_name('europe_synop_stations.json').read_text())['stations'].items() if v['country']=='FR'}


def parse_france_archive(lines,metadata,now):
    reader=csv.DictReader(lines,delimiter=';')
    if not {'geo_id_wmo','validity_time','rr1','rr3','rr6','rr12','rr24'}<=set(reader.fieldnames or []):raise ValueError('Météo-France SYNOP archive columns changed')
    grouped={};end=int(now.timestamp())
    for i,r in enumerate(reader):
        if i>2000000:raise ValueError('Météo-France SYNOP archive exceeds bounded rows')
        code=r['geo_id_wmo']
        if code not in metadata:continue
        try:t=core.unix(r['validity_time'])
        except (ValueError,TypeError):continue
        if t%3600 or not end-72*3600<=t<=end:continue
        meta=metadata[code];s=grouped.setdefault(code,core.station('FR',code,meta['name'],meta['lat'],meta['lon'],[]))
        for hours in (1,3,6,12,24):
            v=core.amount(r['rr'+str(hours)])
            if v is None:continue
            if hours==1:s['times'].append(t);s['amounts'].append(v)
            else:s.setdefault('periods',[]).append({'end':t,'hours':hours,'value':v})
    return europe.trimmed(list(grouped.values()),now)


def load_france(now,previous):
    metadata=france_metadata();out=[]
    if not any(s['country']=='FR' for s in previous):
        # One bootstrap download, not a yearly archive fetched every visitor or
        # updater cycle. Keep only the recent 72 h in the shared rainfall cache.
        try:
            url='https://meteofrance.s3.sbg.io.cloud.ovh.net/data/OBS/SYNOP/synop_'+str(now.year)+'.csv.gz'
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'NorthernWeather/official-rainfall'}),timeout=45) as response:
                with gzip.GzipFile(fileobj=response) as stream:
                    out.extend(parse_france_archive(io.TextIOWrapper(stream,encoding='utf-8-sig'),metadata,now))
        except Exception as error:print('FR archive bootstrap unavailable:',str(error)[:150],flush=True)
    def collect(pair):
        code,meta=pair
        try:return europe.parse_synop(core.download(europe.POI+code+'-BEOB.csv',False),code,meta)
        except Exception as error:print('FR rain gauge',code,'unavailable:',str(error)[:100],flush=True);return None
    with futures.ThreadPoolExecutor(max_workers=6) as pool:out.extend(s for s in pool.map(collect,metadata.items()) if s)
    return europe.trimmed(out,now)


def install(target):
    target.SOURCES.update(SOURCES)
    target.LOADERS.update({'FR':load_france,'AD':load_andorra,'ES':load_spain})
