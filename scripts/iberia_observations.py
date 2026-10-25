"""Official AEMET and IPMA measured observations, retaining native UTC times."""
import datetime as dt
import html
import io
import json
import math
from pathlib import Path
import re
import tarfile
import time
import urllib.error
import urllib.parse

AEMET='https://www.aemet.es/es/eltiempo/observacion/ultimosdatos'
METAR='https://aviationweather.gov/api/data/metar'
METAR_SOURCE='Official Spanish airport METAR/SPECI observations via NOAA Aviation Weather Center (AEMET backup)'
METAR_PERIOD='Reported airport mean wind and gusts at the native METAR/SPECI observation time; knots converted to m/s. Gusts appear only when explicitly reported and are not an hourly maximum. Airport coverage is smaller than the AEMET national network.'
IPMA='https://api.ipma.pt/open-data/observation/meteorology/stations/'
BOUNDS={'ES':(27,44.5,-19,5),'PT':(30,43,-32,-6)}
SOURCES={'ES':'AEMET / Agencia Estatal de Meteorología (provisional observations)',
         'PT':'IPMA / Instituto Português do Mar e da Atmosfera (provisional observations)'}
DIRECTIONS={name:i*45 for i,name in enumerate(('N','NE','E','SE','S','SW','W','NW'))}
DIRECTIONS.update({'O':270,'NO':315,'SO':225})


def number(value,low,high):
    if isinstance(value,bool) or value is None or value=='':return None
    try:n=float(value)
    except (TypeError,ValueError):return None
    return n if math.isfinite(n) and low<=n<=high else None


def stamp(value):
    if not isinstance(value,str):return None
    try:
        # Both services publish measurement times in UTC. AEMET's archive
        # filenames also contain local offsets; those are never used as dates.
        t=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
        return int(t.replace(tzinfo=t.tzinfo or dt.timezone.utc).timestamp())
    except ValueError:return None


def point(feature,country):
    g=feature.get('geometry') or {};p=feature.get('properties') or {}
    coords=g.get('coordinates') or []
    if g.get('type')!='Point' or not isinstance(coords,list) or len(coords)!=2:return None
    south,north,west,east=BOUNDS[country]
    lat,lon=number(coords[1],south,north),number(coords[0],west,east)
    return (lat,lon,p) if lat is not None and lon is not None else None


def aemet_names(page):
    raw=page.decode('iso-8859-15') if isinstance(page,bytes) else page
    match=re.search(r'var\s+estaciones\s*=\s*\[(.*?)\];',raw,re.S)
    if not match:raise ValueError('AEMET station-name catalogue missing')
    names={}
    for code,name in re.findall(r'\{\s*id:\s*"([A-Z0-9]+)",\s*nombre:\s*"((?:\\.|[^"\\])*)"\s*\}',match[1]):
        names[code]=html.unescape(json.loads('"'+name+'"'))
    if not names:raise ValueError('AEMET station-name catalogue changed')
    return names


def parse_aemet(raw,names,now):
    end=int(now.timestamp());grouped={};total=0;members=0
    # Stream archive members; never extract paths to disk. Daily summary
    # maxima are intentionally excluded from current wind/gust measurements.
    # Shared collectors may already decode gzip, including .tar.gz downloads.
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r|*') as archive:
        for member in archive:
            members+=1;total+=member.size
            if members>1500 or total>120*1024*1024:raise ValueError('AEMET archive exceeds safe observation size')
            match=re.fullmatch(r'horarios/(temp|vien|rach)/[^/]+\.geojson',member.name)
            if not match or not member.isfile():continue
            if member.size>4*1024*1024:raise ValueError('AEMET observation layer too large')
            payload=json.load(archive.extractfile(member))
            if payload.get('type')!='FeatureCollection' or not isinstance(payload.get('features'),list):raise ValueError('AEMET hourly GeoJSON schema changed')
            for f in payload['features']:
                geo=point(f,'ES')
                if not geo:continue
                lat,lon,p=geo;code=str(p.get('IDEMA') or '');t=stamp(p.get('FINT'))
                if code not in names or t is None or not end-24*3600<=t<=end+60:continue
                item=grouped.setdefault(code,dict(code=code,name=names[code],lat=lat,lon=lon,rows={}))
                row=item['rows'].setdefault(t,[t,None,None,None,None])
                kind=match[1]
                if kind=='temp':row[1]=number(p.get('TA'),-90,55)
                elif kind=='vien':
                    speed=number(p.get('VV10m'),0,360)
                    row[2]=None if speed is None else speed/3.6
                    row[4]=DIRECTIONS.get(str(p.get('DV10m') or '').upper())
                else:
                    gust=number(p.get('VMAX10m'),0,360)
                    row[3]=None if gust is None else gust/3.6
    return [{**s,'observationNetwork':'aemet-hourly'} for s in finalize(grouped,now,'AEMET')]


def parse_ipma(observations,metadata,now):
    if not isinstance(observations,dict) or not isinstance(metadata,list):raise ValueError('IPMA observation schema changed')
    stations={}
    for f in metadata:
        geo=point(f,'PT')
        if not geo:continue
        lat,lon,p=geo;code=str(p.get('idEstacao') or '')
        if code:stations[code]=dict(code=code,name=p.get('localEstacao') or 'IPMA '+code,lat=lat,lon=lon,rows={})
    end=int(now.timestamp())
    for date,records in observations.items():
        t=stamp(date)
        if t is None or not end-24*3600<=t<=end+60 or not isinstance(records,dict):continue
        for code,p in records.items():
            if code not in stations or not isinstance(p,dict):continue
            # -99 is the provider's missing-data sentinel. The API already
            # reports m/s; its rounded km/h companion is not a second sensor.
            temp=number(p.get('temperatura'),-90,55)
            speed=number(p.get('intensidadeVento'),0,100)
            direction=number(p.get('idDireccVento'),1,9)
            degrees={1:0,9:0,2:45,3:90,4:135,5:180,6:225,7:270,8:315}.get(direction)
            stations[code]['rows'][t]=[t,temp,speed,None,degrees]
    return finalize(stations,now,'IPMA')


def finalize(grouped,now,provider):
    end=int(now.timestamp());out=[]
    for s in grouped.values():
        rows=[r for _,r in sorted(s['rows'].items()) if any(v is not None for v in r[1:4])]
        if rows and any(r[0]>=end-2*3600 for r in rows):out.append({**s,'rows':rows})
    if not out:raise ValueError('No current official '+provider+' temperature or wind observations')
    return out


def load_aemet(now,download):
    def aemet_download(url):
        for attempt in range(2):
            try:return download(url)
            except urllib.error.HTTPError as error:
                if attempt or error.code not in (408,429,500,502,503,504):raise
            except (urllib.error.URLError,TimeoutError,ConnectionError):
                if attempt:raise
            time.sleep(2)
    page=aemet_download(AEMET)
    text=page.decode('iso-8859-15') if isinstance(page,bytes) else page
    match=re.search(r'href="(/es/geojson/download/udat/udat_descarga_\d+\.tar\.gz)"',text)
    if not match:raise ValueError('AEMET official download link unavailable')
    url=urllib.parse.urljoin(AEMET,match[1])
    return parse_aemet(aemet_download(url),aemet_names(page),now)



def parse_spain_metars(reports,metadata,now):
    if not isinstance(reports,list) or len(reports)>400:raise ValueError('Unexpected Spanish METAR response')
    end=int(now.timestamp());stations={}
    for report in reports:
        if not isinstance(report,dict) or report.get('metarType') not in ('METAR','SPECI'):continue
        code=report.get('icaoId');meta=metadata.get(code)
        if not meta or meta.get('country')!='ES':continue
        geo=point({'geometry':{'type':'Point','coordinates':[meta['lon'],meta['lat']]}},'ES')
        t=number(report.get('obsTime'),end-2*3600,end+60)
        if not geo or t is None:continue
        lat,lon,_=geo
        speed=number(report.get('wspd'),0,200);gust=number(report.get('wgst'),0,200)
        direction=number(report.get('wdir'),0,360)
        row=[int(t),number(report.get('temp'),-90,55),None if speed is None else speed*1852/3600,
             None if gust is None else gust*1852/3600,None if direction is None else direction%360]
        item=stations.setdefault(code,dict(code='METAR-'+code,name=meta['name'],lat=lat,lon=lon,rows={},
            source=METAR_SOURCE,gustLabel='Reported METAR gust',period=METAR_PERIOD,observationNetwork='spain-airport-metar'))
        item['rows'][int(t)]=row
    return finalize(stations,now,'Spanish METAR')


def load_spain_metars(now,download):
    metadata=json.loads(Path(__file__).with_name('spain_airport_stations.json').read_text())['stations']
    # One small centrally fetched query, shared by all map visitors. Keep the
    # two-hour window below the service's result cap; retained history is merged
    # by the normal publisher. Do not turn old AEMET readings into current data.
    url=METAR+'?'+urllib.parse.urlencode({'ids':','.join(sorted(metadata)),'format':'json','hours':2})
    return parse_spain_metars(json.loads(download(url)),metadata,now)


def load(country,now,download):
    if country=='PT':return parse_ipma(json.loads(download(IPMA+'observations.json')),json.loads(download(IPMA+'stations.json')),now)
    if country!='ES':raise ValueError('Unknown Iberian observation country')
    try:return load_aemet(now,download)
    except (ValueError,OSError,tarfile.TarError) as error:
        print('ES AEMET observations unavailable:',str(error)[:160],'; using fresh official airport METAR/SPECI backup',flush=True)
        return load_spain_metars(now,download)


def load_temperature(country,now,download):
    import update_official_temperature as core
    out=[];end=int(now.timestamp())
    for s in load(country,now,download):
        item=core.make_station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[1]) for r in s['rows']])
        if item and item['rows'][-1][0]>=end-2*3600:
            item['source']=s.get('source') or SOURCES[country]
            if s.get('observationNetwork'):item['observationNetwork']=s['observationNetwork']
            out.append(item)
    if not out:raise ValueError('No current official '+country+' temperatures')
    return out


def load_wind(country,now,download):
    import update_official_wind as core
    out=[];end=int(now.timestamp())
    for s in load(country,now,download):
        item=core.station(country,s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[2],r[3],r[4]) for r in s['rows']])
        if not item['rows'] or item['rows'][-1][0]<end-2*3600:continue
        item.update(sourceName=SOURCES[country],gustLabel='Gust max · 1 hour' if country=='ES' else 'Current gust unavailable',
                    period='Ten-minute mean wind at 10 m, reported hourly. '+('Maximum gust over the preceding 60 minutes, converted from km/h to m/s.' if country=='ES' else 'Current gusts are not provided by this IPMA feed; daily maxima are not substituted.')+' Native UTC observation time; provisional.')
        if s.get('source'):item['sourceName']=s['source']
        for key in ('gustLabel','period','observationNetwork'):
            if key in s:item[key]=s[key]
        out.append(item)
    if not out:raise ValueError('No current official '+country+' wind observations')
    return out
