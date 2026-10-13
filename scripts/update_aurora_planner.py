#!/usr/bin/env python3
"""Shared native cloud forecasts for the northern aurora viewing planner."""
import base64
import json
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
import time
from ecmwf.opendata import Client
from update_aurora_cloud import quantize_cloud, utc, iso_z, WIDTH, HEIGHT, LAT_MIN, LAT_MAX, RESOLUTION

ROOT = Path(__file__).resolve().parents[1]
STEPS = range(0, 73, 3)
VERSION = 'cloud-v1'

def bands():
    return [{'bounds':[-180+i*30,LAT_MIN,-150+i*30,LAT_MAX], 'width':121, 'height':HEIGHT} for i in range(12)]

def split_cloud(values, band):
    if len(values) != WIDTH*HEIGHT:
        raise ValueError('Incomplete shared cloud grid')
    start=band*120
    return bytes(values[y*WIDTH+(start+x)%WIDTH] for y in range(HEIGHT) for x in range(121))

def main():
    data=ROOT/'data'; cache=data/'aurora-planner-cloud'; manifest_path=data/'aurora-planner.json'
    client=Client(source='ecmwf', model='ifs', resol='0p25')
    run=utc(client.latest(stream='oper',type='fc',levtype='sfc',param='tcc',step=72))
    cycle=run.strftime('%Y%m%dT%HZ')+'-'+VERSION
    target=cache/cycle
    try:
        previous=json.loads(manifest_path.read_text())
    except (OSError,json.JSONDecodeError):
        previous={}
    if previous.get('reference_time')==iso_z(run) and previous.get('asset_version')==VERSION and all((target/f'cloud-{i}-v1.json').is_file() for i in range(12)):
        print('Aurora planner cloud forecasts already current; no field downloads.',flush=True);return
    cache.mkdir(parents=True,exist_ok=True)
    stage=cache/(cycle+'.tmp');shutil.rmtree(stage,ignore_errors=True);stage.mkdir()
    samples=[[] for _ in range(12)]
    try:
        with tempfile.TemporaryDirectory(prefix='aurora-planner-') as directory:
            grib=Path(directory)/'cloud.grib2'
            for step in STEPS:
                time.sleep(2)
                client.retrieve(date=run.strftime('%Y%m%d'),time=run.hour,stream='oper',type='fc',levtype='sfc',param='tcc',step=step,target=str(grib))
                values=quantize_cloud(grib)['bytes']
                for i in range(12):
                    samples[i].append({'time':iso_z(run+timedelta(hours=step)), 'values':base64.b64encode(split_cloud(values,i)).decode('ascii')})
                print('Prepared aurora cloud forecast:',step,'/ 72 hours',flush=True)
        grids=[]
        for i,band in enumerate(bands()):
            path=f'data/aurora-planner-cloud/{cycle}/cloud-{i}-v1.json'
            grid=dict(band, version=1, reference_time=iso_z(run), resolution=RESOLUTION, encoding='uint8-base64', missing=255, samples=samples[i])
            (stage/f'cloud-{i}-v1.json').write_text(json.dumps(grid,separators=(',',':'))+'\n')
            grids.append(dict(band,path=path))
        shutil.rmtree(target,ignore_errors=True);stage.rename(target)
        manifest={'version':1,'asset_version':VERSION,'reference_time':iso_z(run),'generated_at':iso_z(datetime.now(timezone.utc)), 'provider':'ECMWF IFS Open Data','resolution':RESOLUTION,'grids':grids}
        temporary=manifest_path.with_suffix('.json.tmp');temporary.write_text(json.dumps(manifest,separators=(',',':'))+'\n');temporary.replace(manifest_path)
        for old in cache.iterdir():
            if old.is_dir() and old!=target:shutil.rmtree(old)
        print('Published aurora planner:',sum(p.stat().st_size for p in target.iterdir()),'bytes',flush=True)
    finally:
        shutil.rmtree(stage,ignore_errors=True)

if __name__=='__main__':main()
