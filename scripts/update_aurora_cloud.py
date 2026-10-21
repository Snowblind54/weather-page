#!/usr/bin/env python3
"""Build a compact ECMWF IFS total-cloud field for aurora viewing conditions."""

from __future__ import annotations

import base64
import json
import math
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from eccodes import codes_get, codes_get_array, codes_grib_new_from_file, codes_release
import numpy as np
import ecmwf_open_grid as tiers
from update_iceland_forecast import request, ROOT as IFS_ROOT

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "aurora-cloud.json"

LAT_MIN = 35.0
LAT_MAX = 90.0
RESOLUTION = 0.1
WIDTH = int(round(360.0 / RESOLUTION))
HEIGHT = int(round((LAT_MAX - LAT_MIN) / RESOLUTION)) + 1
MISSING = 255


def utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return utc(value).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def choose_step(run_time: datetime) -> int:
    """Choose the 3-hour IFS step closest to the short-term aurora forecast time."""
    target = datetime.now(timezone.utc) + timedelta(hours=1)
    hours = max(0.0, (target - utc(run_time)).total_seconds() / 3600.0)
    step = int(round(hours / 3.0) * 3)
    return max(0, min(144, step))


def quantize_cloud(grib_path: Path,run=None,step=None):
    with grib_path.open('rb') as handle:
        gid=codes_grib_new_from_file(handle)
        if gid is None:raise RuntimeError('ECMWF cloud GRIB did not contain a field')
        try:
            units=str(codes_get(gid,'units'));param_id=int(codes_get(gid,'paramId'))
            resolution=float(codes_get(gid,'iDirectionIncrementInDegrees'))
            if resolution not in (.1,.25):raise ValueError('Invalid cloud grid spacing')
            if run is not None:
                reference=datetime.strptime(str(codes_get(gid,'dataDate'))+f"{codes_get(gid,'dataTime'):04d}",'%Y%m%d%H%M').replace(tzinfo=timezone.utc)
                valid=datetime.strptime(str(codes_get(gid,'validityDate'))+f"{codes_get(gid,'validityTime'):04d}",'%Y%m%d%H%M').replace(tzinfo=timezone.utc)
                if reference!=run or valid!=run+timedelta(hours=step):raise ValueError('Cloud forecast run/time mismatch')
            latitudes=codes_get_array(gid,'latitudes');longitudes=codes_get_array(gid,'longitudes');values=codes_get_array(gid,'values')
        finally:codes_release(gid)
    if not(len(latitudes)==len(longitudes)==len(values)):raise ValueError('Cloud array sizes differ')
    if param_id==164 and units in ('(0 - 1)','1'):multiplier=100.
    elif param_id==228164 and units in ('%','percent'):multiplier=1.
    else:raise ValueError('Unexpected cloud parameter/units')
    width=round(360/resolution);height=round((LAT_MAX-LAT_MIN)/resolution)+1
    mask=(latitudes>=LAT_MIN-1e-6)&(latitudes<=LAT_MAX+1e-6)&np.isfinite(values)
    v=values[mask]*multiplier
    if not len(v) or v.min()< -1e-4 or v.max()>100.0001:raise ValueError('Invalid cloud fraction')
    x=np.rint((((longitudes[mask]+180)%360))/resolution).astype(int)%width
    y=np.rint((latitudes[mask]-LAT_MIN)/resolution).astype(int)
    grid=np.full(width*height,MISSING,dtype=np.uint8)
    grid[y*width+x]=np.clip(np.rint(v),0,100).astype(np.uint8)
    good=grid[grid!=MISSING];coverage=len(good)/len(grid)
    if coverage<.98:raise ValueError('Incomplete cloud crop')
    return {'bytes':grid.tobytes(),'paramId':param_id,'units':units,'sourceResolution':resolution,
            'width':width,'height':height,'coverage':coverage,'min':int(good.min()),'max':int(good.max()),'mean':round(float(good.mean()),1)}

def cloud_index(run,step,resolution):
    return tiers.index(IFS_ROOT,run,step,request,{'tcc'},resolution)

def cloud_cycle(now=None):
    return tiers.choose_cycle(now or datetime.now(timezone.utc),cloud_index,horizon=72,minimum_hours=48)

def read_cloud(run,step,resolution,grib_path):
    row=cloud_index(run,step,resolution)['tcc']
    length=int(row['_length'])
    if not 0<length<32*1024*1024:raise ValueError('Unexpected cloud GRIB size')
    grib_path.write_bytes(request(row['_grib_url'],int(row['_offset']),length))
    cloud=quantize_cloud(grib_path,run,step)
    if cloud['sourceResolution']!=resolution:raise ValueError('Cloud tier/grid mismatch')
    return cloud


def existing_identity():
    try:
        data = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return data.get("runTime"), data.get("validTime"), data.get("resolution")
    except (OSError, json.JSONDecodeError):
        return None, None, None


def main():
    run_time,resolution,_,_=cloud_cycle()
    step=choose_step(run_time);valid_time=run_time+timedelta(hours=step)
    run_iso=iso_z(run_time);valid_iso=iso_z(valid_time)
    if existing_identity()==(run_iso,valid_iso,resolution):
        print('Aurora cloud already current:',resolution,run_iso,valid_iso,flush=True);return
    with tempfile.TemporaryDirectory(prefix='aurora-cloud-') as temp_dir:
        cloud=read_cloud(run_time,step,resolution,Path(temp_dir)/'tcc.grib2')
    data = {
        "version": 1,
        "generatedAt": int(time.time()),
        "provider": "ECMWF IFS Open Data",
        "runTime": run_iso,
        "validTime": valid_iso,
        "stepHours": step,
        "latMin": LAT_MIN,
        "latMax": LAT_MAX,
        "lonMin": -180.0,
        "lonMax": 180.0,
        "resolution": resolution,
        "width": cloud["width"],
        "height": cloud["height"],
        "encoding": "uint8-base64",
        "missing": MISSING,
        "values": base64.b64encode(cloud["bytes"]).decode("ascii"),
        "source": {
            "param": "tcc",
            "paramId": cloud["paramId"],
            "units": cloud["units"],
            "sourceResolution": cloud["sourceResolution"],
        },
        "stats": {
            "coverage": round(cloud["coverage"], 4),
            "min": cloud["min"],
            "max": cloud["max"],
            "mean": cloud["mean"],
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    temporary.replace(OUTPUT)

    print(
        f"ECMWF aurora cloud: run={run_iso} valid={valid_iso} step={step}h "
        f"coverage={cloud['coverage']:.1%} cloud={cloud['min']}..{cloud['max']}% "
        f"mean={cloud['mean']}%"
    )
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
