#!/usr/bin/env python3
"""Shared native cloud forecasts for the northern aurora viewing planner."""
import base64
import json
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
import time
from update_aurora_cloud import cloud_cycle, read_cloud, utc, iso_z, WIDTH, HEIGHT, LAT_MIN, LAT_MAX, RESOLUTION

ROOT = Path(__file__).resolve().parents[1]
STEPS = range(0, 73, 3)
VERSION = 'cloud-v2'

def bands(resolution=RESOLUTION):
    height=round((LAT_MAX-LAT_MIN)/resolution)+1;columns=round(30/resolution)+1
    return [{'bounds':[-180+i*30,LAT_MIN,-150+i*30,LAT_MAX], 'width':columns, 'height':height} for i in range(12)]

def split_cloud(values, band,resolution=RESOLUTION):
    width=round(360/resolution);height=round((LAT_MAX-LAT_MIN)/resolution)+1;columns=round(30/resolution)
    if len(values)!=width*height:raise ValueError('Incomplete shared cloud grid')
    start=band*columns
    return bytes(values[y*width+(start+x)%width] for y in range(height) for x in range(columns+1))


def main():
    data=ROOT/'data'; cache=data/'aurora-planner-cloud'; manifest_path=data/'aurora-planner.json'
    run,resolution,_,_=cloud_cycle()
    version=VERSION if resolution==.1 else 'cloud-v1'
    cycle=run.strftime('%Y%m%dT%HZ')+'-'+version
    target=cache/cycle
    try:
        previous=json.loads(manifest_path.read_text())
    except (OSError,json.JSONDecodeError):
        previous={}
    if previous.get('reference_time')==iso_z(run) and previous.get('asset_version')==version and all((target/f'cloud-{i}-v1.json').is_file() for i in range(12)):
        print('Aurora planner cloud forecasts already current; no field downloads.',flush=True);return
    cache.mkdir(parents=True,exist_ok=True)
    stage=cache/(cycle+'.tmp');shutil.rmtree(stage,ignore_errors=True);stage.mkdir()
    samples=[[] for _ in range(12)]
    try:
        with tempfile.TemporaryDirectory(prefix='aurora-planner-') as directory:
            grib=Path(directory)/'cloud.grib2'
            for step in STEPS:
                time.sleep(2)
                values=read_cloud(run,step,resolution,grib)['bytes']
                for i in range(12):
                    samples[i].append({'time':iso_z(run+timedelta(hours=step)), 'values':base64.b64encode(split_cloud(values,i,resolution)).decode('ascii')})
                print('Prepared aurora cloud forecast:',step,'/ 72 hours',flush=True)
        grids=[]
        for i,band in enumerate(bands(resolution)):
            path=f'data/aurora-planner-cloud/{cycle}/cloud-{i}-v1.json'
            grid=dict(band, version=1, reference_time=iso_z(run), resolution=resolution, encoding='uint8-base64', missing=255, samples=samples[i])
            (stage/f'cloud-{i}-v1.json').write_text(json.dumps(grid,separators=(',',':'))+'\n')
            grids.append(dict(band,path=path))
        if sum(p.stat().st_size for p in stage.iterdir())>100*1024*1024:raise ValueError('Aurora cloud cache exceeds 100 MiB')
        shutil.rmtree(target,ignore_errors=True);stage.rename(target)
        manifest={'version':1,'asset_version':version,'reference_time':iso_z(run),'generated_at':iso_z(datetime.now(timezone.utc)), 'provider':'ECMWF IFS Open Data','resolution':resolution,'grids':grids}
        temporary=manifest_path.with_suffix('.json.tmp');temporary.write_text(json.dumps(manifest,separators=(',',':'))+'\n');temporary.replace(manifest_path)
        for old in cache.iterdir():
            if old.is_dir() and old!=target:shutil.rmtree(old)
        print('Published aurora planner:',sum(p.stat().st_size for p in target.iterdir()),'bytes',flush=True)
    finally:
        shutil.rmtree(stage,ignore_errors=True)

if __name__=='__main__':main()
