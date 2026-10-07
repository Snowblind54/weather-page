"""ECMWF IFS open-data Iceland maps, with explicit native three-hour periods.

Only selected GRIB messages are fetched by range. Hourly instantaneous fields
are interpolated numerically, not by blending coloured images. Precipitation
is a three-hour mean rate; gusts retain the maximum over their native GRIB interval.
"""
import io
import json
import math
import shutil
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import eccodes as ec
import numpy as np
from PIL import Image
from scipy.interpolate import RegularGridInterpolator

ROOT = 'https://data.ecmwf.int/forecasts/'
BOUNDS = [-28, 61, -12, 69]
SIZE = 2048
PARAMS = {'2t', '10u', '10v', 'tp', 'tcc', '10fg'}
FIELDS = {'temperature':'air_temperature_2m', 'rain':'precipitation_amount',
          'wind':'wind_speed_10m', 'gusts':'wind_speed_of_gust', 'clouds':'cloud_area_fraction'}
RANGES = {'temperature':(253.15,303.15), 'rain':(.1,10), 'wind':(0,30),
          'gusts':(0,40), 'clouds':(0,1)}
USER_AGENT = 'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page'

def iso(t):
    return t.isoformat(timespec='milliseconds').replace('+00:00','Z')

def url(run, step, suffix):
    return ROOT + f'{run:%Y%m%d}/{run:%H}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc.{suffix}'

def request(address, start=None, length=None):
    headers = {'User-Agent':USER_AGENT}
    if start is not None: headers['Range'] = f'bytes={start}-{start+length-1}'
    with urllib.request.urlopen(urllib.request.Request(address,headers=headers),timeout=90) as response:
        if start is not None:
            if response.status != 206 or not response.headers.get('Content-Range','').startswith(f'bytes {start}-'):
                raise ValueError('ECMWF server did not honour byte range')
        data = response.read((length if length is not None else 4*1024*1024)+1)
        if start is not None and len(data) != length: raise ValueError('Incomplete GRIB message')
        return data

def index(run, step):
    rows = [json.loads(line) for line in request(url(run,step,'index')).decode().splitlines()]
    selected = {r['param']:r for r in rows if r.get('levtype')=='sfc' and r.get('param') in PARAMS}
    required = PARAMS - ({'10fg'} if step==0 else set())
    if not required <= selected.keys(): raise ValueError('Missing ECMWF surface fields')
    return selected

def decode(raw, run, step):
    g = ec.codes_new_from_message(raw)
    try:
        valid = datetime.strptime(str(ec.codes_get(g,'validityDate'))+f"{ec.codes_get(g,'validityTime'):04d}",'%Y%m%d%H%M').replace(tzinfo=timezone.utc)
        reference = datetime.strptime(str(ec.codes_get(g,'dataDate'))+f"{ec.codes_get(g,'dataTime'):04d}",'%Y%m%d%H%M').replace(tzinfo=timezone.utc)
        if reference != run or valid != run+timedelta(hours=step): raise ValueError('ECMWF run/time mismatch')
        lats = ec.codes_get_array(g,'latitudes')
        lons = (ec.codes_get_array(g,'longitudes')+180)%360-180
        values = ec.codes_get_values(g)
        mask = (lats>=BOUNDS[1]-.25)&(lats<=BOUNDS[3]+.25)&(lons>=BOUNDS[0]-.25)&(lons<=BOUNDS[2]+.25)
        lat, lon = np.unique(lats[mask]), np.unique(lons[mask])
        grid = np.full((len(lat),len(lon)),np.nan)
        grid[np.searchsorted(lat,lats[mask]),np.searchsorted(lon,lons[mask])] = values[mask]
        if not np.isfinite(grid).all(): raise ValueError('Incomplete Iceland grid')
        return lat,lon,grid,ec.codes_get(g,'units'),int(ec.codes_get(g,'startStep')),int(ec.codes_get(g,'endStep')),float(ec.codes_get(g,'packingError'))
    finally: ec.codes_release(g)

def read_step(run, step, rows=None):
    result = {}
    for name, row in (rows or index(run,step)).items():
        if step==0 and name=='10fg': continue
        offset,length = int(row['_offset']),int(row['_length'])
        if not 0 < length < 8*1024*1024: raise ValueError('Unexpected GRIB size')
        raw = request(url(run,step,'grib2'),offset,length)
        lat,lon,grid,unit,start,end,packing_error = decode(raw,run,step)
        expected = {'2t':{'K'},'10u':{'m s**-1'},'10v':{'m s**-1'},'tp':{'m'},
                    'tcc':{'(0 - 1)','1'},'10fg':{'m s**-1'}}[name]
        if unit not in expected: raise ValueError(f'Unexpected {name} units: {unit}')
        if name=='tp' and (start!=0 or end!=step): raise ValueError('Rain is not accumulation since run start')
        if name=='tp':
            if not math.isfinite(packing_error) or not 0<=packing_error<=.0001:
                raise ValueError('Unexpected precipitation packing error')
            result['tp_packing_error']=packing_error
        if name=='10fg':
            if end!=step or not 0<=start<end: raise ValueError('Invalid native gust interval')
            result['gust_start']=start
            result['gust_end']=end
        limits = {'2t':(180,340),'10u':(-150,150),'10v':(-150,150),'tp':(-1e-7,5),
                  'tcc':(-1e-6,1.000001),'10fg':(0,150)}[name]
        if grid.min()<limits[0] or grid.max()>limits[1]: raise ValueError(f'Invalid {name} values')
        if 'lat' in result and (not np.array_equal(lat,result['lat']) or not np.array_equal(lon,result['lon'])):
            raise ValueError('ECMWF surface grids differ')
        result.update(lat=lat,lon=lon)
        result[name] = grid
    return result

def hourly_fields(lower, upper, fraction):
    mix = lambda name: lower[name]*(1-fraction)+upper[name]*fraction
    delta = upper['tp']-lower['tp']
    # CCSDS may truncate to a full quantum; ecCodes packingError is half a
    # quantum. Independently packed totals can therefore differ by the sum
    # of their full quanta even when physical accumulation did not decrease.
    tolerance=2*(lower.get('tp_packing_error',0)+upper.get('tp_packing_error',0))+1e-10
    if delta.min() < -tolerance: raise ValueError('Precipitation accumulation decreased beyond GRIB packing error')
    return {'temperature':mix('2t'), 'wind':np.hypot(mix('10u'),mix('10v')),
            'clouds':np.clip(mix('tcc'),0,1), 'rain':np.maximum(0,delta)*1000/3,
            'gusts':upper['10fg']}

def render(grid, lat, lon, kind, palette, destination):
    # Equal spacing in Mercator y is essential for Leaflet imageOverlay.
    merc = lambda v: math.log(math.tan(math.pi/4+math.radians(v)/2))
    y = np.linspace(merc(BOUNDS[3]),merc(BOUNDS[1]),SIZE)
    sample_lat = np.degrees(2*np.arctan(np.exp(y))-math.pi/2)
    sample_lon = np.linspace(BOUNDS[0],BOUNDS[2],SIZE)
    lo,hi = RANGES[kind]
    sampler = RegularGridInterpolator((lat,lon),grid,bounds_error=True)
    pixels = np.empty((SIZE,SIZE,4),dtype=np.uint8)
    # Small row blocks avoid a large 2048² coordinate array on the runner.
    for first in range(0,SIZE,64):
        la,ln = np.meshgrid(sample_lat[first:first+64],sample_lon,indexing='ij')
        values = sampler(np.stack((la,ln),axis=-1))
        bins = np.clip(np.floor((values-lo)/(hi-lo)*64),0,63).astype(int)
        rgba = palette[bins].copy()
        if kind=='rain': rgba[values<lo,3]=0
        pixels[first:first+64] = rgba
    Image.fromarray(pixels).save(destination,format='WEBP',lossless=True,method=4)

def main():
    data = Path(__file__).resolve().parents[1]/'data'
    nordic = json.loads((data/'forecast-map.json').read_text())
    previous_path = data/'forecast-iceland.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    now = datetime.now(timezone.utc)
    candidate = (now-timedelta(hours=5)).replace(minute=0,second=0,microsecond=0)
    candidate = candidate.replace(hour=candidate.hour//6*6)
    run = None
    for attempt in range(3):
        trial = candidate-timedelta(hours=6*attempt)
        if previous.get('reference_time')==trial.isoformat():
            files = [p for frames in previous.get('images',{}).values() for p in frames.values()]
            if files and all((data.parent/p).is_file() for p in files):
                print('Iceland ECMWF images already current; no field downloads.');return
        try:
            first,last = index(trial,0),index(trial,90)
            run = trial;break
        except Exception as error: print('Cycle not ready:',trial,str(error),flush=True)
    if run is None: raise RuntimeError('No complete ECMWF cycle; previous Iceland maps retained')
    frames = {}
    for step in range(0,91,3):
        frames[step] = read_step(run,step,first if step==0 else last if step==90 else None)
        print('Downloaded Iceland fields:',step,'/ 90 hours',flush=True)
    root = data/'forecast-iceland-cache';root.mkdir(exist_ok=True)
    cycle = run.strftime('%Y%m%dT%HZ')
    stage = Path(tempfile.mkdtemp(prefix='_staging-',dir=root))
    try:
        palettes = {}
        for kind in FIELDS:
            legend = data.parent/nordic['legends'][kind]
            with Image.open(legend) as im:
                rgba = np.array(im.convert('RGBA'))
                palettes[kind] = rgba[rgba.shape[0]//2,np.linspace(2,253,64).round().astype(int)]
            shutil.copyfile(legend,stage/(kind+'-legend.webp'))
        images = {kind:{} for kind in FIELDS};periods = {};times = []
        for hour in range(3,90):
            valid = run+timedelta(hours=hour);lower=hour//3*3;upper=lower+3
            fields = hourly_fields(frames[lower],frames[upper],(hour-lower)/3)
            gust_step=int(round(hour/3))*3
            fields['gusts']=frames[gust_step]['10fg']
            key = iso(valid);times.append(key)
            periods[key] = {'start':iso(run+timedelta(hours=lower)), 'end':iso(run+timedelta(hours=upper)),
                            'interpolated':hour%3!=0,
                            'gust_start':iso(run+timedelta(hours=frames[gust_step]['gust_start'])),
                            'gust_end':iso(run+timedelta(hours=frames[gust_step]['gust_end'])),
                            'gust_sample_time':iso(run+timedelta(hours=gust_step))}
            for kind,grid in fields.items():
                filename = kind+'-'+valid.strftime('%Y%m%dT%HZ')+'.webp'
                render(grid,frames[lower]['lat'],frames[lower]['lon'],kind,palettes[kind],stage/filename)
                images[kind][key] = f'data/forecast-iceland-cache/{cycle}/{filename}'
            if hour%6==0: print('Rendered hourly Iceland maps:',hour,'/ 90',flush=True)
        size = sum(p.stat().st_size for p in stage.iterdir())
        if size>150*1024*1024: raise ValueError('Iceland cache exceeds 150 MiB')
        target=root/cycle
        if target.exists(): shutil.rmtree(target)
        stage.rename(target)
        manifest = {'delivery':'static-regional-images','asset_root':'forecast-iceland-cache',
                    'source':'ECMWF IFS open data · Iceland','reference_time':run.isoformat(),
                    'generated_at':datetime.now(timezone.utc).isoformat(),'bounds':BOUNDS,'layers':FIELDS,
                    'images':images,'cached_times':times,'periods':periods,'image_size':[SIZE,SIZE],
                    'legends':{k:f'data/forecast-iceland-cache/{cycle}/{k}-legend.webp' for k in FIELDS},
                    'grid_spacing_degrees':.25,'native_step_hours':3,'cache_bytes':size,'licence':'CC BY 4.0',
                    'documentation':'https://www.ecmwf.int/en/forecasts/datasets/open-data',
                    'source_variables':sorted(PARAMS),
                    'processing':'Hourly temperature, wind components and cloud cover are linearly interpolated. Rain is a native three-hour mean rate; gusts use the nearest native forecast and retain its maximum interval.'}
        temp=data/'forecast-iceland.json.tmp';temp.write_text(json.dumps(manifest,indent=2)+'\n');temp.replace(previous_path)
        cycles=sorted(p for p in root.iterdir() if p.is_dir() and p.name.endswith('Z'))
        for old in cycles[:-2]: shutil.rmtree(old)
        print('Published Iceland:',len(times),'hours;',round(size/1024/1024,2),'MiB',flush=True)
    finally:
        if stage.exists(): shutil.rmtree(stage)

if __name__=='__main__': main()
