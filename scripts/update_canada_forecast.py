"""Shared ECMWF IFS North America and Atlantic maps, aligned with the existing forecast timeline.

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
BOUNDS = [-190, 18, -30, 84]
SIZE = 2048
VERSION = 'northamerica-v5'
ASSET_ROOT = 'forecast-canada-cache'
MAX_BYTES = 200*1024*1024
GUST_AREAS = [[west,south,east,north] for south,north in [(18,40),(40,62),(62,84)]
              for west,east in [(-190,-150),(-150,-110),(-110,-70),(-70,-30)]]


def cycle_name(run,resolution=.1):
    version=VERSION if resolution==.1 else 'northamerica-v4'
    return run.strftime('%Y%m%dT%HZ')+'-'+version


def retire_previous_cycles(root, current):
    # Only remove recognized forecast cycles after the current one is complete.
    # Omitting them from publication lets central R2 expiry retire their assets.
    pattern=r'\d{8}T\d{2}Z-(?:canada-v1|northamerica-v2|northamerica-v3|northamerica-v4|'+re.escape(VERSION)+r')'
    for old in root.iterdir():
        if old.is_dir() and not old.is_symlink() and old!=current and re.fullmatch(pattern,old.name):
            shutil.rmtree(old)


def gust_manifest(run,resolution=.1):
    return [{'path':f'data/{ASSET_ROOT}/{cycle_name(run,resolution)}/gust-grid-{i}-v1.json',
             'bounds':bounds,'units':'m/s'}
            for i,bounds in enumerate(GUST_AREAS)]


def write_gusts(frames, run, destination):
    # Preserve the native 0.25-degree samples; fetch only the regional grid
    # containing a clicked point instead of downloading all North America gusts.
    first=frames[min(frames)]
    for band,(west,south,east,north) in enumerate(GUST_AREAS):
        latmask=(first['lat']>=south)&(first['lat']<=north)
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
                            'values':ifs.gust_values(values,first.get('grid_spacing_degrees',.25))})
        payload={'source':'ECMWF IFS open data','region':'North America','reference_time':run.isoformat(),
                 'units':'m/s','bounds':[west,south,east,north],'grid_spacing_degrees':first.get('grid_spacing_degrees',.25),**ifs.gust_encoding(first.get('grid_spacing_degrees',.25)),
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
            palettes[kind]=rgba[rgba.shape[0]//2,np.linspace(2,253,128 if kind=='temperature' else 64).round().astype(int)]
    return palettes


def complete_previous(previous, run, root, resolution=None):
    resolution=previous.get('grid_spacing_degrees',.1) if resolution is None else resolution
    version=VERSION if resolution==.1 else 'northamerica-v4'
    if previous.get('reference_time')!=run.isoformat() or previous.get('asset_version')!=version or previous.get('bounds')!=BOUNDS:
        return False
    expected=87
    paths=[]
    for kind in ifs.FIELDS:
        images=previous.get('images',{}).get(kind,{})
        if len(images)!=expected:return False
        paths.extend(images.values());paths.append(previous.get('legends',{}).get(kind,''))
    if previous.get('gust_grids')!=gust_manifest(run,resolution):return False
    paths.extend(g['path'] for g in previous['gust_grids'])
    prefix=f'data/{ASSET_ROOT}/{cycle_name(run,resolution)}/'
    return all(isinstance(p,str) and p.startswith(prefix) and (root/p).is_file() and (root/p).stat().st_size>0 for p in paths)


def publish(frames, run, nordic, palettes, data=DATA, size=SIZE):
    resolution=frames[min(frames)].get('grid_spacing_degrees',.25)
    version=VERSION if resolution==.1 else 'northamerica-v4'
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
                          'precipitation_type_time':ifs.iso(run+timedelta(hours=lower)),
                          'gust_start':ifs.iso(run+timedelta(hours=frames[gust_step]['gust_start'])),
                          'gust_end':ifs.iso(run+timedelta(hours=frames[gust_step]['gust_end'])),
                          'gust_sample_time':ifs.iso(run+timedelta(hours=gust_step))}
            for kind,grid in fields.items():
                filename=kind+'-'+valid.strftime('%Y%m%dT%HZ')+'.webp'
                ifs.render(grid,frames[lower]['lat'],frames[lower]['lon'],kind,palettes[kind],stage/filename,bounds=BOUNDS,size=size,precipitation_type=frames[lower].get('ptype') if kind=='rain' else None)
                images[kind][key]=f'data/{ASSET_ROOT}/{cycle_name(run,resolution)}/{filename}'
            if hour%6==0:print('Rendered North America maps:',hour,'/ 90 hours',flush=True)
        total=sum(p.stat().st_size for p in stage.iterdir())
        if total>MAX_BYTES:raise ValueError('Canada forecast cache exceeds 200 MiB; previous cycle retained')
        manifest={'delivery':'static-regional-images','asset_root':ASSET_ROOT,'asset_version':version,'temperature_range_celsius':[-60,60],
                  'source':'ECMWF IFS open data · North America and Atlantic','reference_time':run.isoformat(),
                  'generated_at':datetime.now(timezone.utc).isoformat(),'bounds':BOUNDS,'layers':ifs.FIELDS,
                  'images':images,'cached_times':times,'periods':periods,'image_size':[size,size],
                  'legends':{k:f'data/{ASSET_ROOT}/{cycle_name(run,resolution)}/{k}-legend.webp' for k in ifs.FIELDS},
                  'grid_spacing_degrees':resolution,'resolution_label':'9 km / 0.1°' if resolution==.1 else '0.25° fallback','native_step_hours':3,'cache_bytes':total,'licence':'CC BY 4.0',
                  'documentation':'https://www.ecmwf.int/en/forecasts/datasets/open-data',
                  'gust_grids':gust_manifest(run,resolution),
                  'precipitation_types':{'version':1,'source':'ECMWF IFS precipitation type','method':'Nearest-neighbour categories held from the preceding native three-hour valid time; intensity is a three-hour mean liquid-water-equivalent rate.'},
                  'processing':'Same palettes as MET Nordic. Hourly instantaneous fields are numerically interpolated between native three-hour forecasts. Rain is the three-hour mean rate. Gusts retain the maximum from the nearest native forecast period.'}
        target=root/cycle_name(run,resolution)
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
        retire_previous_cycles(root,target)
        print('Published North America:',len(times),'hours;',round(total/1024/1024,2),'MiB',flush=True)
        return manifest
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    nordic=json.loads((DATA/'forecast-map.json').read_text())
    previous_path=DATA/'forecast-canada.json'
    previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
    now=datetime.now(timezone.utc)
    run,resolution,first,last=ifs.tiers.choose_cycle(now,ifs.index,lambda run,res:complete_previous(previous,run,DATA.parent,res))
    if first is None:
        retire_previous_cycles(DATA/ASSET_ROOT,DATA/ASSET_ROOT/cycle_name(run,resolution))
        print('North America IFS tier already current:',resolution,run,flush=True);return
    palettes=ensure_palettes(nordic,DATA.parent)
    frames={}
    for step in range(0,91,3):
        frames[step]=ifs.read_step(run,step,first if step==0 else last if step==90 else ifs.index(run,step,resolution),bounds=BOUNDS)
        print('Downloaded Canada fields:',step,'/ 90 hours',flush=True)
    publish(frames,run,nordic,palettes)

if __name__=='__main__':main()




