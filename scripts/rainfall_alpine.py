"""Official GeoSphere Austria and MeteoSwiss measured hourly precipitation.

All times are UTC interval ends and amounts are mm. Six complete ten-minute
samples are required for an Austrian hour. Swiss provider-aggregated hourly
values are used directly, with an initial archive backfill for 24/48 h totals.
"""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib
import re
import urllib.parse

import update_rainfall as core
import rainfall_europe as europe
from alpine_observations import AUSTRIA, BOUNDS, valid_location, text

AT_HISTORY=AUSTRIA.replace('/current/','/historical/')
CH_BASE='https://data.geo.admin.ch/'
CH_DATASETS=('ch.meteoschweiz.ogd-smn','ch.meteoschweiz.ogd-smn-precip')
BACKFILL_STATE=pathlib.Path(__file__).resolve().parents[1]/'data/swiss-rain-backfill.json'
SOURCES={'AT':('GeoSphere Austria / TAWES rain gauges','https://data.hub.geosphere.at/en/dataset/tawes-v1-10min'),
         'CH':('Source: MeteoSwiss / SwissMetNet and automatic precipitation stations','https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations')}
PERIODS={'AT':'GeoSphere Austria TAWES ten-minute precipitation (RR), in mm and UTC. Every one of the six ten-minute samples is required for an hourly total. Complete consecutive hourly measurements form 24/48-hour totals; missing intervals stay unavailable. Operational raw measurements are provisional. CC BY 4.0.',
         'CH':'Source: MeteoSwiss. Provider-aggregated hourly precipitation (rre150h0), in mm and UTC, from SwissMetNet and automatic precipitation stations. The recent archive backfills the initial history; current hourly files update the shared cache. Complete consecutive hours are required for 24/48-hour totals. Missing values stay unavailable; operational data are provisional.'}


def parse_austria(payload,metadata,now):
    times=payload.get('timestamps');features=payload.get('features')
    if not isinstance(times,list) or not isinstance(features,list) or len(times)>450:raise ValueError('GeoSphere rainfall time axis changed')
    # Require timezone-aware timestamps from the provider; never use collection time.
    if any(not isinstance(t,str) or not t.endswith(('Z','+00:00')) for t in times):raise ValueError('GeoSphere rainfall UTC time missing')
    stamps=[core.unix(t) for t in times];end=int(now.timestamp())
    catalogue={str(s['id']):s for s in metadata['stations'] if s.get('is_active') is True}
    out=[]
    for f in features:
        p=f.get('properties') or {};code=str(p.get('station',''));meta=catalogue.get(code)
        if not meta or not valid_location('AT',meta.get('lat'),meta.get('lon')):continue
        rr=(p.get('parameters') or {}).get('RR') or {};data=rr.get('data')
        if rr.get('unit')!='mm' or not isinstance(data,list) or len(data)!=len(stamps):raise ValueError('GeoSphere RR units or time axis changed')
        samples=[(t,v) for t,v in zip(stamps,data) if end-72*3600<=t<=end]
        s=core.station('AT',code,meta['name'],meta['lat'],meta['lon'],europe.complete_hours(samples,600))
        if s['times']:out.append(s)
    return out


def load_austria(now,previous):
    metadata=core.download(AT_HISTORY+'/metadata')
    rr=next((p for p in metadata.get('parameters',[]) if p.get('name')=='RR'),{})
    if rr.get('unit')!='mm':raise ValueError('GeoSphere precipitation metadata units changed')
    ids=[str(s['id']) for s in metadata['stations'] if s.get('is_active') is True and valid_location('AT',s.get('lat'),s.get('lon'))]
    if not ids or len(ids)>600:raise ValueError('Unexpected GeoSphere rain gauge catalogue')
    params={'parameters':'RR','station_ids':','.join(ids),'start':(now-dt.timedelta(hours=72)).strftime('%Y-%m-%dT%H:%M'),'end':now.strftime('%Y-%m-%dT%H:%M')}
    return parse_austria(core.download(AT_HISTORY+'?'+urllib.parse.urlencode(params)),metadata,now)


def swiss_metadata(raw,dataset):
    out={}
    for r in csv.DictReader(io.StringIO(text(raw)),delimiter=';'):
        code=r.get('station_abbr','');lat=r.get('station_coordinates_wgs84_lat');lon=r.get('station_coordinates_wgs84_lon')
        if not re.fullmatch('[A-Z]{3}',code) or r.get('station_canton')=='FL' or not valid_location('CH',lat,lon):continue
        out[code]=dict(name=r['station_name'],lat=float(lat),lon=float(lon),dataset=dataset)
    if not out:raise ValueError('MeteoSwiss rain gauge metadata missing')
    return out


def parse_switzerland(raw,code,meta,now):
    reader=csv.DictReader(io.StringIO(text(raw)),delimiter=';')
    if not {'station_abbr','reference_timestamp','rre150h0'}<=set(reader.fieldnames or []):raise ValueError('MeteoSwiss hourly rainfall columns changed')
    samples=[];end=int(now.timestamp())
    for r in reader:
        if r['station_abbr']!=code:raise ValueError('MeteoSwiss hourly station identity changed')
        try:t=int(dt.datetime.strptime(r['reference_timestamp'],'%d.%m.%Y %H:%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except (ValueError,TypeError):continue
        if end-72*3600<=t<=end:samples.append((t,r['rre150h0'],False))
    return core.station('CH',code,meta['name'],meta['lat'],meta['lon'],samples)


def load_switzerland(now,previous):
    metadata={};end=int(now.timestamp())
    try:
        backfills=json.loads(BACKFILL_STATE.read_text())
        if not isinstance(backfills,dict):backfills={}
    except (OSError,ValueError):backfills={}
    prior={s['code']:s for s in previous if s['country']=='CH'}
    for dataset in CH_DATASETS:
        prefix=dataset.split('.')[-1]
        try:
            parameters=list(csv.DictReader(io.StringIO(text(core.download(CH_BASE+dataset+'/'+prefix+'_meta_parameters.csv',False))),delimiter=';'))
            if not any(r.get('parameter_shortname')=='rre150h0' and r.get('parameter_unit')=='mm' for r in parameters):raise ValueError('MeteoSwiss hourly rainfall units changed')
            definitions=swiss_metadata(core.download(CH_BASE+dataset+'/'+prefix+'_meta_stations.csv',False),dataset)
            for code,meta in definitions.items():metadata.setdefault(code,meta)
        except Exception as error:print('CH rain network unavailable:',dataset,str(error)[:120],flush=True)
    if not metadata or len(metadata)>500:raise ValueError('MeteoSwiss rainfall station metadata missing/oversized')
    def collect(pair):
        code,meta=pair;prefix=meta['dataset'].split('.')[-1]
        url=CH_BASE+meta['dataset']+'/'+code.lower()+'/'+prefix+'_'+code.lower()+'_h_'
        old=prior.get(code);rows=[]
        # The recent file is a year-to-date archive, so bootstrap only while
        # history is absent/incomplete, not for every visitor or refresh.
        need_history=not old or len([t for t in old['times'] if t>=end-54*3600])<48
        last=backfills.get(code)
        if need_history and (not isinstance(last,(int,float)) or end-last>=6*3600):
            backfills[code]=end
            try:rows.append(parse_switzerland(core.download(url+'recent.csv',False),code,meta,now))
            except Exception as error:print('CH rain history',code,'unavailable:',str(error)[:100],flush=True)
        try:rows.append(parse_switzerland(core.download(url+'now.csv',False),code,meta,now))
        except Exception as error:print('CH rain current',code,'unavailable:',str(error)[:100],flush=True)
        return rows
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        out=europe.trimmed([s for rows in pool.map(collect,metadata.items()) for s in rows],now)
    try:
        BACKFILL_STATE.parent.mkdir(parents=True,exist_ok=True)
        BACKFILL_STATE.write_text(json.dumps({code:backfills[code] for code in metadata if code in backfills}))
    except OSError:print('CH rain backfill retry state unavailable; observations retained',flush=True)
    return out


def install(target):
    target.SOURCES.update(SOURCES)
    target.LOADERS.update({'AT':load_austria,'CH':load_switzerland})
