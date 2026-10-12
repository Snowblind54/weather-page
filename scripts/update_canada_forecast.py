"""Shared ECMWF IFS Canada maps, aligned with the existing forecast timeline.

Reuse the validated Iceland GRIB decoder and Mercator renderer. Never publish
partial cycles: a failed run leaves the last complete manifest and assets intact.
"""
import hashlib
import json
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image
import update_iceland_forecast as ifs

DATA = Path(__file__).resolve().parents[1]/'data'
BOUNDS = [-142, 40, -50, 84]
SIZE = 2048
VERSION = 'canada-v1'
ASSET_ROOT = 'forecast-canada-cache'
MAX_BYTES = 150*1024*1024
GUST_BANDS = [(-142,-110),(-110,-80),(-80,-50)]


def cycle_name(run):
    return run.strftime('%Y%m%dT%HZ')+'-'+VERSION


def gust_manifest(run):
    return [{'path':f'data/{ASSET_ROOT}/{cycle_name(run)}/gust-grid-{i}-v1.json',
             'bounds':[west,BOUNDS[1],east,BOUNDS[3]],'units':'m/s'}
            for i,(west,east) in enumerate(GUST_BANDS)]


def write_gusts(frames, run, destination):
    # Preserve the native 0.25-degree samples; fetch only the longitude band
    # containing a clicked point instead of downloading all Canada gusts.
    first=frames[min(frames)]
    latmask=(first['lat']>=BOUNDS[1])&(first['lat']<=BOUNDS[3])
    for band,(west,east) in enumerate(GUST_BANDS):
        lonmask=(first['lon']>=west)&(first['lon']<=east)
        lat=first['lat'][latmask];lon=first['lon'][lonmask]
        if len(lat)<2 or len(lon)<2:raise ValueError('Incomplete Canada gust grid')
        samples=[]
        for step,frame in sorted(frames.items()):
            if step==0:continue
            if not np.array_equal(frame['lat'],first['lat']) or not np.array_equal(frame['lon'],first['lon']):
                raise ValueError('Canada gust grids differ')
            values=frame['10fg'][np.ix_(latmask,lonmask)]
            if not np.isfinite(values).all() or values.min()<0 or values.max()>150:
                raise ValueError('Invalid Canada gust values')
            samples.append({'time':ifs.iso(run+timedelta(hours=step)),
                            'start':ifs.iso(run+timedelta(hours=frame['gust_start'])),
                            'end':ifs.iso(run+timedelta(hours=frame['gust_end'])),
                            'values':np.round(values,3).ravel().tolist()})
        payload={'source':'ECMWF IFS open data','region':'Canada','reference_time':run.isoformat(),
                 'units':'m/s','bounds':[west,BOUNDS[1],east,BOUNDS[3]],'grid_spacing_degrees':.25,
                 'latitudes':lat.tolist(),'longitudes':lon.tolist(),'samples':samples}
        (destination/f'gust-grid-{band}-v1.json').write_text(json.dumps(payload,separators=(',',':'))+'\n')


def ensure_palettes(nordic, root, restore=None):
    paths=[nordic['legends'][kind] for kind in ifs.FIELDS]
    if any(not (root/path).resolve().is_relative_to((root/'data/forecast-cache').resolve()) for path in paths):
        raise ValueError('Forecast palette escapes shared cache')
    if any(not (root/path).is_file() for path in paths):
        if restore is None:
            from hydrate_r2_data import restore_inputs
            restore=restore_inputs
        restore(paths)
    palettes={}
    for kind,path in zip(ifs.FIELDS,paths):
        with Image.open(root/path) as image:
            if image.size!=(256,18):raise ValueError('Invalid shared forecast colour scale')
            rgba=np.array(image.convert('RGBA'))
            palettes[kind]=rgba[rgba.shape[0]//2,np.linspace(2,253,64).round().astype(int)]
    return palettes


def complete_previous(previous, run, root):
    if previous.get('reference_time')!=run.isoformat() or previous.get('asset_version')!=VERSION or previous.get('bounds')!=BOUNDS:
        return False
    expected=87
    paths=[]
    for kind in ifs.FIELDS:
        images=previous.get('images',{}).get(kind,{})
        if len(images)!=expected:return False
        paths.extend(images.values());paths.append(previous.get('legends',{}).get(kind,''))
    if previous.get('gust_grids')!=gust_manifest(run):return False
    paths.extend(g['path'] for g in previous['gust_grids'])
    prefix=f'data/{ASSET_ROOT}/{cycle_name(run)}/'
    return all(isinstance(p,str) and p.startswith(prefix) and (root/p).is_file() and (root/p).stat().st_size>0 for p in paths)


def publish(frames, run, nordic, palettes, data=DATA, size=SIZE):
    root=data/ASSET_ROOT;root.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='_staging-',dir=root))
    try:
        write_gusts(frames,run,stage)
        for kind in ifs.FIELDS:shutil.copyfile(data.parent/nordic['legends'][kind],stage/(kind+'-legend.webp'))
        images={kind:{} for kind in ifs.FIELDS};periods={};times=[]
        for hour in range(3,90):
            valid=run+timedelta(hours=hour);lower=hour//3*3;upper=lower+3
            fields=ifs.hourly_fields(frames[lower],frames[upper],(hour-lower)/3)
            gust_step=int(round(hour/3))*3
            fields['gusts']=frames[gust_step]['10fg']
            key=ifs.iso(valid);times.append(key)
            periods[key]={'start':ifs.iso(run+timedelta(hours=lower)),
                          'end':ifs.iso(run+timedelta(hours=upper)), 'interpolated':hour%3!=0,
                          'gust_start':ifs.iso(run+timedelta(hours=frames[gust_step]['gust_start'])),
                          'gust_end':ifs.iso(run+timedelta(hours=frames[gust_step]['gust_end'])),
                          'gust_sample_time':ifs.iso(run+timedelta(hours=gust_step))}
            for kind,grid in fields.items():
                filename=kind+'-'+valid.strftime('%Y%m%dT%HZ')+'.webp'
                ifs.render(grid,frames[lower]['lat'],frames[lower]['lon'],kind,palettes[kind],stage/filename,bounds=BOUNDS,size=size)
                images[kind][key]=f'data/{ASSET_ROOT}/{cycle_name(run)}/{filename}'
            if hour%6==0:print('Rendered Canada maps:',hour,'/ 90 hours',flush=True)
        total=sum(p.stat().st_size for p in stage.iterdir())
        if total>MAX_BYTES:raise ValueError('Canada forecast cache exceeds 150 MiB; previous cycle retained')
        manifest={'delivery':'static-regional-images','asset_root':ASSET_ROOT,'asset_version':VERSION,
                  'source':'ECMWF IFS open data · Canada','reference_time':run.isoformat(),
                  'generated_at':datetime.now(timezone.utc).isoformat(),'bounds':BOUNDS,'layers':ifs.FIELDS,
                  'images':images,'cached_times':times,'periods':periods,'image_size':[size,size],
                  'legends':{k:f'data/{ASSET_ROOT}/{cycle_name(run)}/{k}-legend.webp' for k in ifs.FIELDS},
                  'grid_spacing_degrees':.25,'native_step_hours':3,'cache_bytes':total,'licence':'CC BY 4.0',
                  'documentation':'https://www.ecmwf.int/en/forecasts/datasets/open-data',
                  'gust_grids':gust_manifest(run),
                  'processing':'Same palettes as MET Nordic. Hourly instantaneous fields are numerically interpolated between native three-hour forecasts. Rain is the three-hour mean rate. Gusts retain the maximum from the nearest native forecast period.'}
        target=root/cycle_name(run)
        if target.exists():
            # A restore interrupted after image staging may leave missing files.
            # Repair only when every existing immutable asset matches exactly.
            for asset in stage.iterdir():
                existing=target/asset.name
                if existing.exists() and hashlib.sha256(existing.read_bytes()).digest()!=hashlib.sha256(asset.read_bytes()).digest():
                    raise ValueError('Refusing to replace a changed immutable Canada asset')
            for asset in stage.iterdir():
                if not (target/asset.name).exists():asset.replace(target/asset.name)
        else:stage.rename(target)
        temp=data/'forecast-canada.json.tmp';temp.write_text(json.dumps(manifest,indent=2)+'\n');temp.replace(data/'forecast-canada.json')
        # One current cycle keeps the independent GitHub mirror comfortably
        # within its existing 1 GiB limit. R2 keeps retired assets until expiry.
        for old in root.iterdir():
            if old.is_dir() and old!=target and re.fullmatch(r'\d{8}T\d{2}Z-canada-v1',old.name):shutil.rmtree(old)
        print('Published Canada:',len(times),'hours;',round(total/1024/1024,2),'MiB',flush=True)
        return manifest
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    nordic=json.loads((DATA/'forecast-map.json').read_text())
    previous_path=DATA/'forecast-canada.json'
    previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
    now=datetime.now(timezone.utc)
    candidate=(now-timedelta(hours=5)).replace(minute=0,second=0,microsecond=0)
    candidate=candidate.replace(hour=candidate.hour//6*6)
    run=None
    for attempt in range(3):
        trial=candidate-timedelta(hours=6*attempt)
        if complete_previous(previous,trial,DATA.parent):
            print('Canada ECMWF images already current; no field downloads.',flush=True);return
        # Never call a short/old cycle a 72-hour forecast.
        if trial+timedelta(hours=89)<now+timedelta(hours=72):continue
        try:
            first,last=ifs.index(trial,0),ifs.index(trial,90)
            run=trial;break
        except Exception as error:print('Canada cycle not ready:',trial,str(error),flush=True)
    if run is None:raise RuntimeError('No complete ECMWF Canada cycle; previous maps retained')
    palettes=ensure_palettes(nordic,DATA.parent)
    frames={}
    for step in range(0,91,3):
        frames[step]=ifs.read_step(run,step,first if step==0 else last if step==90 else None,bounds=BOUNDS)
        print('Downloaded Canada fields:',step,'/ 90 hours',flush=True)
    publish(frames,run,nordic,palettes)

if __name__=='__main__':main()
