"""Incremental official Nordic/Baltic radar tile trial for static hosting.

Immutable, lossless 256px Mercator PNGs, zooms 3–7. Latest observations first;
keep a rolling 2.5h archive plus the last successful frame per station on failure.
No interpolation, invented observations or raw files committed to git.
"""
import concurrent.futures as futures
import datetime as dt
import hashlib
import io
import json
import math
import pathlib
import shutil
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo
import numpy as np
from PIL import Image
from pyproj import Transformer
import update_nordic_radar as archive
from radar_archive import pack_tiles

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/radar-tiles.json'
TILES = ROOT / 'data/radar-tiles'
KEEP = 9000
MAX_NEW = 24
MAX_BYTES = 240 * 1024 * 1024
HOSTS = {'openwms.fmi.fi','www.meteo.lt','opendata.fmi.fi','opendata-download-radar.smhi.se','radar-stacapi.met.no','rgw.met.no',
         'avaandmed.keskkonnaportaal.ee','new.meteo.lt','videscentrs.lvgmc.lv',*archive.ALLOWED}
BOUNDS = {'ee':[[56.48834379574241,20.354150207505985],[61.33568305549932,29.760049907697866]],
          'lt':[[49.876389,15.618611],[59.701667,34.313611]],
          'lv':[[54.5934155033868,19.8278947347231],[59.0900395033868,28.0663127347231]]}


def download(url, body=None):
    parsed=urllib.parse.urlparse(url)
    if parsed.scheme!='https' or parsed.hostname not in HOSTS: raise ValueError('Unexpected radar URL')
    headers={'User-Agent':'NorthernWeather-radar-tiles/1.0'}
    if body is not None: headers['Content-Type']='application/json'
    request=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with urllib.request.urlopen(request,timeout=25) as response:
        if urllib.parse.urlparse(response.url).scheme!='https' or urllib.parse.urlparse(response.url).hostname not in HOSTS: raise ValueError('Unexpected radar redirect')
        chunks=[];size=0;started=time.perf_counter()
        while True:
            chunk=response.read(256*1024)
            if not chunk:break
            chunks.append(chunk);size+=len(chunk)
            if size>64*1024*1024:raise ValueError('Radar file exceeds trial download budget')
            if time.perf_counter()-started>50:raise TimeoutError('Radar download exceeded trial time budget')
        return b''.join(chunks)


def stamp(value): return int(dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())
def iso(value): return dt.datetime.fromtimestamp(value,dt.timezone.utc).isoformat()
def query(url,params): return url+'?'+urllib.parse.urlencode(params)


def discover(source,first,last):
    records=[]
    if source=='fi':
        url=query('https://opendata.fmi.fi/wfs',dict(service='WFS',version='2.0.0',request='getFeature',storedquery_id='fmi::radar::composite::rr',starttime=iso(first),endtime=iso(last)))
        tree=ET.fromstring(download(url))
        for obs in tree.iter():
            if obs.tag.split('}')[-1]!='GridSeriesObservation': continue
            fields={e.tag.split('}')[-1]:e.text for e in obs.iter()}
            url=fields.get('fileReference','').strip()
            if 'geotiff' in url:
                gain,offset=.01,0
                for param in obs.iter():
                    if param.tag.split('}')[-1]!='NamedValue': continue
                    p={e.tag.split('}')[-1]:e for e in param.iter()}
                    name=p.get('name'); value=p.get('value')
                    if name is None or value is None: continue
                    ref=name.get('{http://www.w3.org/1999/xlink}href',name.text or '')
                    if 'linearTransformationGain' in ref: gain=float(''.join(value.itertext()).strip())
                    if 'linearTransformationOffset' in ref: offset=float(''.join(value.itertext()).strip())
                records.append(dict(source=source,station=source,time=stamp(fields['timePosition']),source_url=url,format='tif',quantity='RATE',gain=gain,offset=offset,nodata=65535,undetect=0))
    elif source=='no':
        payload=json.loads(download(query('https://radar-stacapi.met.no/v1/collections/Mosaic-Norway-v1/items',dict(limit=200,datetime=iso(first)+'/'+iso(last)))))
        for f in payload.get('features',[]):
            if f['properties'].get('dataType')=='dBZ' and f.get('assets',{}).get('data',{}).get('href'):
                records.append(dict(source=source,station=source,time=stamp(f['properties']['datetime']),source_url=f['assets']['data']['href'],format='tif',quantity='DBZH',projection=f['properties'].get('proj:wkt2')))
    elif source=='se':
        for day in sorted({iso(first)[:10],iso(last)[:10]}):
            payload=json.loads(download('https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp/'+day.replace('-','/')))
            for f in payload.get('files',[]):
                fmt=next((v for v in f.get('formats',[]) if v['key']=='h5'),None)
                if fmt: records.append(dict(source=source,station=source,time=stamp(f['valid'].replace(' ','T')+'Z'),source_url=fmt['link'],format='h5'))
    elif source=='dk':
        records=archive.parse_dmi(json.loads(download(query('https://opendataapi.dmi.dk/v1/radardata/collections/composite/items',dict(limit=100,sortorder='datetime,DESC',datetime=iso(first)+'/'+iso(last))))),first,last)
        for r in records:r['format']='h5'
    elif source=='is':
        # Reuse the existing IMO archive without downloading/decoding HDF twice.
        path=ROOT/'data/nordic-radar-cache.json'
        if path.exists(): records=[{**r,'format':'prepared'} for r in json.loads(path.read_text()).get('frames',[]) if r['source']=='is']
    elif source=='ee':
        body={'filter':{'and':{'children':[{'isEqual':{'field':'$contentType','value':'0102FB01'}},{'isEqual':{'field':'Phenomenon','value':'COMP'}},{'greaterThan':{'field':'Timestamp','value':iso(first)}}]}},'pageSize':50,'includeFileMetadata':True,'fields':['Timestamp','Radar','Phenomenon']}
        payload=json.loads(download('https://avaandmed.keskkonnaportaal.ee/api/lists/active/items/query',body))
        for doc in payload.get('documents',[]):
            for file in doc.get('fileMetadata',[])[:1]:
                url=f"https://avaandmed.keskkonnaportaal.ee/api/lists/active/items/{doc['id']}/files/{file['id']}"
                records.append(dict(source=source,station=source,time=stamp(doc['metadata']['Timestamp']),source_url=url,format='ee-h5'))
    elif source=='lt':
        for target in range(last//600*600,first-1,-600):
            name=dt.datetime.fromtimestamp(target,dt.timezone.utc).strftime('%Y%m%d%H%M')
            records.append(dict(source=source,station=source,time=target,source_url=f'https://new.meteo.lt/meteo_jobs/radaru_informacija/Header_Radar-composite-{name}.png',format='native-png'))
    elif source=='lv':
        error=None
        for url in ['https://videscentrs.lvgmc.lv/data/static_maps?name=Latvija%2FLatvija_satelits','https://videscentrs.lvgmc.lv/kartes-images/Latvija/Latvija_satelits.files.json']:
            try:
                payload=json.loads(download(url)); entries=payload if isinstance(payload,list) else payload.get('files',[])
                import re
                for e in entries:
                    name=e if isinstance(e,str) else e.get('name','')
                    if not re.fullmatch(r'Latvija/Latvija_satelits/(?:png/)?[A-Za-z0-9_.-]+\.png',name):continue
                    match=re.search(r'_(\d{12})(?:_|\.)',name)
                    if match:
                        acquired=int(dt.datetime.strptime(match[1],'%Y%m%d%H%M').replace(tzinfo=ZoneInfo('Europe/Riga')).timestamp())
                        records.append(dict(source=source,station=source,time=acquired,source_url='https://videscentrs.lvgmc.lv/kartes-images/'+name,format='native-png'))
                if records: break
            except Exception as exc:error=exc
        if not records:raise ValueError('LVĢMC is not publishing recent radar images') from error
    return [r for r in records if first<=r['time']<=last]


def project_tiff(raw,record):
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.warp import transform_bounds,reproject,Resampling
    with MemoryFile(raw) as memory, memory.open() as src:
        crs=src.crs or record.get('projection')
        if not crs: raise ValueError('Missing official GeoTIFF projection')
        west,south,east,north=transform_bounds(crs,'EPSG:4326',*src.bounds,densify_pts=32)
        left,bottom,right,top=transform_bounds('EPSG:4326','EPSG:3857',west,south,east,north)
        aspect=(right-left)/(top-bottom); width,height=(2000,round(2000/aspect)) if aspect>1 else (round(2000*aspect),2000)
        vals=src.read(1).astype(np.float32);nodata=record.get('nodata',src.nodata)
        valid=np.isfinite(vals)&(vals!=nodata)&(vals!=record.get('undetect'))
        measured=vals*record.get('gain',1)+record.get('offset',0)
        rates=measured if record['quantity']=='RATE' else (10**(measured/10)/200)**(1/1.6)
        rates[~valid]=np.nan
        dest=np.full((height,width),np.nan,np.float32)
        transform=rasterio.transform.from_bounds(left,bottom,right,top,width,height)
        reproject(rates,dest,src_transform=src.transform,src_crs=crs,src_nodata=np.nan,dst_transform=transform,dst_crs='EPSG:3857',dst_nodata=np.nan,resampling=Resampling.nearest)
        return Image.fromarray(archive.colour_rate_field(dest)),[[south,west],[north,east]]


def estonia_colours(rates):
    # Preserve KAIA's existing colour/opacity scale, independently of Nordic dBZ.
    stops=[.1,.3,.5,1,2,4,8,16,50,float('inf')]
    colours=np.array([[156,221,255,155],[54,170,255,175],[0,216,154,185],[232,247,0,195],
                      [255,196,0,205],[255,123,0,215],[255,42,42,225],[211,0,215,235],
                      [150,0,190,240],[90,0,145,245]],np.uint8)
    pixels=colours[np.minimum(np.searchsorted(stops,rates,side='right'),len(colours)-1)]
    pixels[~np.isfinite(rates)|(rates<.05)]=0
    return pixels


def image_for(record):
    if record['format']=='prepared':return Image.open(ROOT/record['url']).convert('RGBA'),record['bounds'],0
    url=record['source_url']
    if record['source']=='fi':
        parsed=urllib.parse.urlparse(url);params=dict(urllib.parse.parse_qsl(parsed.query));width,height=int(params.get('width',2000)),int(params.get('height',2000))
        scale=min(1,2000/max(width,height));params.update(width=str(round(width*scale)),height=str(round(height*scale)))
        url=urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(params)))
    raw=download(url)
    if record['format']=='tif':image,bounds=project_tiff(raw,record)
    elif record['format']=='h5':
        png,bounds=archive.project(raw);image=Image.open(io.BytesIO(png)).convert('RGBA')
    elif record['format']=='ee-h5':
        import h5py
        with h5py.File(io.BytesIO(raw),'r') as file:
            vals=file['dataset1/data1/data'][...]; what=archive.attrs(file.get('dataset1/what'))
            rate=vals.astype(np.float32)*float(what.get('gain',1))+float(what.get('offset',0))
            rate[(vals==what.get('nodata',65535))|(vals==what.get('undetect',0))|(vals>30000)]=np.nan
            image=Image.fromarray(estonia_colours(rate));image.thumbnail((1000,1000),Image.Resampling.NEAREST)
        bounds=BOUNDS['ee']
    else:
        image=Image.open(io.BytesIO(raw)).convert('RGBA');bounds=BOUNDS[record['source']]
        # Same achromatic-background filter as the existing browser LHMT layer.
        if record['source']=='lt':
            pixels=np.array(image);rgb=pixels[:,:,:3].astype(np.float32)/255
            mask=np.clip(6*(rgb.max(2)-rgb.min(2))-.6,0,1)
            pixels[:,:,3]=(pixels[:,:,3]*mask).astype(np.uint8);pixels[pixels[:,:,3]==0]=0;image=Image.fromarray(pixels)
    return image,bounds,len(raw)


def world(lon,lat,zoom):
    size=256*2**zoom;lat=max(-85.05112878,min(85.05112878,lat))
    return (lon+180)/360*size,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*size


def make_tiles(image,bounds,directory):
    (south,west),(north,east)=bounds;indices={};total=0
    for zoom in range(3,8):
        left,top=world(west,north,zoom);right,bottom=world(east,south,zoom)
        entries=[]
        for x in range(max(0,math.floor(left/256)),min(2**zoom,math.ceil(right/256))):
            for y in range(max(0,math.floor(top/256)),min(2**zoom,math.ceil(bottom/256))):
                box=((x*256-left)/(right-left)*image.width,(y*256-top)/(bottom-top)*image.height,
                     ((x+1)*256-left)/(right-left)*image.width,((y+1)*256-top)/(bottom-top)*image.height)
                tile=image.transform((256,256),Image.Transform.EXTENT,box,Image.Resampling.NEAREST)
                if tile.getchannel('A').getbbox() is None:continue
                # Lossless palette encoding keeps exact rain colours and alpha.
                palette=tile.convert('P',palette=Image.Palette.ADAPTIVE,colors=256)
                if palette.convert('RGBA').tobytes()==tile.tobytes():tile=palette
                path=directory/str(zoom)/str(x)/f'{y}.png';path.parent.mkdir(parents=True,exist_ok=True)
                tile.save(path,optimize=True);total+=path.stat().st_size;entries.append(f'{x}/{y}')
        indices[str(zoom)]=entries
    return indices,total


def retained(previous,first):
    latest={}
    for r in previous:
        if r['station'] not in latest or r['time']>latest[r['station']]['time']:latest[r['station']]=r
    return [r for r in previous if r['time']>=first or r is latest[r['station']]]


def main():
    started=time.perf_counter();now=int(time.time());first=now-KEEP
    TILES.mkdir(parents=True,exist_ok=True)
    previous=json.loads(OUT.read_text()) if OUT.exists() else {'frames':[]}
    existing={r['source_url']:r for r in retained(previous['frames'],first) if ((ROOT/r['path']).is_dir() or (r.get('archive') and (ROOT/r['archive']['path']).is_file())) and (r['source']!='ee' or r.get('style_version')==2)}
    records=[];errors=[];metrics=[]
    for record in existing.values():
        if not record.get('archive') and record.get('tiles') is not None:
            directory=ROOT/record['path']
            record['archive']=pack_tiles(directory,TILES/(directory.name+'.bin'),record['tiles'])
            record['bytes']=record['archive']['bytes']
            shutil.rmtree(directory)

    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs={pool.submit(discover,s,first,now):s for s in ['ee','fi','se','no','dk','lt','lv']}
        for job in futures.as_completed(jobs):
            try:records+=job.result()
            except Exception as exc:errors.append(jobs[job]+': '+str(exc))
    # One real observation per ten-minute bucket, never assign a synthetic time.
    slots={}
    for r in sorted(records,key=lambda r:r['time']):slots.setdefault((r['station'],r['time']//600),r)
    by_station={}
    for r in sorted(slots.values(),key=lambda r:-r['time']):by_station.setdefault(r['station'],[]).append(r)
    pending=[]
    # Round-robin latest first so one provider cannot consume the whole budget.
    for depth in range(16):
        for station,rows in by_station.items():
            if depth<len(rows) and rows[depth]['source_url'] not in existing:pending.append(rows[depth])
    for r in pending[:MAX_NEW]:
        if time.perf_counter()-started>600:
            errors.append('Trial processing time budget reached; remaining observations deferred');break
        begin=time.perf_counter();temporary=None
        print('Preparing '+r['station']+' '+iso(r['time']),flush=True)
        try:
            image,bounds,raw_bytes=image_for(r)
            identity=hashlib.sha256(image.tobytes()+json.dumps(bounds).encode()).hexdigest()[:12]
            name=f"{r['station']}-{r['time']}-{identity}";temporary=TILES/(name+'.tmp');temporary.mkdir(exist_ok=True)
            indices,size=make_tiles(image,bounds,temporary)
            if sum(v['bytes'] for v in existing.values())+size>MAX_BYTES:raise ValueError('Tile archive storage budget reached')
            packed=pack_tiles(temporary,TILES/(name+'.bin'),indices)
            size=packed['bytes']
            if sum(v['bytes'] for v in existing.values())+size>MAX_BYTES:raise ValueError('Tile archive storage budget reached')
            shutil.rmtree(temporary)
            existing[r['source_url']]={k:r[k] for k in ['source','station','time','source_url']}
            existing[r['source_url']].update(path='data/radar-tiles/'+name,bounds=bounds,tiles=indices,bytes=size,min_zoom=3,max_zoom=7,style_version=2,archive=packed)
            metrics.append(dict(source=r['source'],time=r['time'],raw_bytes=raw_bytes,tile_bytes=size,tile_count=sum(map(len,indices.values())),uploaded_objects=1,seconds=round(time.perf_counter()-begin,3)))
        except Exception as exc:errors.append(r['station']+' '+str(r['time'])+': '+str(exc))
        finally:
            if temporary is not None and temporary.exists():shutil.rmtree(temporary)
    frames=sorted(existing.values(),key=lambda r:(r['time'],r['station']))
    if not frames:raise RuntimeError('No successful radar tiles; previous published archive left untouched: '+'; '.join(errors))
    result=dict(version=1,generated_at=now,frames=frames,errors=errors,metrics=dict(processing_seconds=round(time.perf_counter()-started,3),archive_bytes=sum(r['bytes'] for r in frames),new_frames=metrics),trial=dict(min_zoom=3,max_zoom=7,retention_seconds=KEEP,max_archive_bytes=MAX_BYTES,max_new_frames=MAX_NEW))
    temp=OUT.with_suffix('.tmp');temp.write_text(json.dumps(result,separators=(',',':'))+'\n');temp.replace(OUT)
    keep={r['path'].split('/')[-1] for r in frames}
    for path in TILES.iterdir():
        if path.is_dir() and path.name not in keep:shutil.rmtree(path)
        elif path.is_file() and path.stem not in keep:path.unlink()
    print(json.dumps(result['metrics'],indent=2));print('\n'.join(errors))

if __name__=='__main__':main()
