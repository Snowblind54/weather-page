#!/usr/bin/env python3
"""Cache a rolling 14-day official IMS 4 km archive as compressed web-map tiles.

IMS v1.3 projection uses the published ims_wkt2_2018.txt ellipsoid. ASCII
rows start at the lower left; filenames give the valid 00 UTC analysis date.
Categorical nearest-neighbour sampling never interpolates snow/ice classes.
"""
import argparse, base64, datetime as dt, gzip, hashlib, io, json, re, sys
from pathlib import Path
from urllib.request import Request, urlopen
import numpy as np
from PIL import Image
from pyproj import Transformer
ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = 'https://noaadata.apps.nsidc.org/NOAA/G02156/4km/'
PROJECTION = '+proj=stere +lat_0=90 +lat_ts=60 +lon_0=-80 +a=6378137 +rf=291.505347349177 +units=m +no_defs'
SIZE, CELL, EDGE, MAX_ZOOM = 6144, 4000, 12288000, 5

def read_grid(compressed, size=SIZE):
    rows = [line.strip() for line in gzip.decompress(compressed).splitlines()
            if len(line.strip()) == size and re.fullmatch(rb'[0-4]+', line.strip())]
    if len(rows) != size:
        raise ValueError(f'Invalid IMS grid: {len(rows)} rows, expected {size}')
    return (np.frombuffer(b''.join(rows), dtype=np.uint8).reshape(size, size)-48)[::-1]

def pixel_indices(zoom):
    width = 256 * 2**zoom
    # z0 contains the equator in the middle of its one world tile.
    height = max(256, width//2)
    lon = (np.arange(width)+.5)/width*360-180
    lat = np.degrees(np.arctan(np.sinh(np.pi*(1-2*(np.arange(height)+.5)/width))))
    x, y = Transformer.from_crs('EPSG:4326', PROJECTION, always_xy=True).transform(*np.meshgrid(lon, lat))
    col = np.floor((x+EDGE)/CELL).astype(np.int32)
    row = np.floor((EDGE-y)/CELL).astype(np.int32)
    valid = (row>=0)&(row<SIZE)&(col>=0)&(col<SIZE)&(lat[:,None]>=0)
    return np.clip(row,0,SIZE-1), np.clip(col,0,SIZE-1), valid

def encode_tiles(grid, mappings):
    palette = [0,0,0,77,205,245,245,250,255]+[0]*759
    tiles = {}
    for z, (row,col,valid) in enumerate(mappings):
        source = grid[row,col]
        pixels = np.where(valid & (source==3),1,np.where(valid & (source==4),2,0)).astype(np.uint8)
        for y in range(pixels.shape[0]//256):
            for x in range(pixels.shape[1]//256):
                tile = pixels[y*256:(y+1)*256,x*256:(x+1)*256]
                if not tile.any():
                    continue
                image = Image.fromarray(tile, mode='P'); image.putpalette(palette)
                out = io.BytesIO(); image.save(out, format='PNG', transparency=0, optimize=True)
                tiles[f'{z}/{x}/{y}'] = base64.b64encode(out.getvalue()).decode('ascii')
    return tiles

def download(url):
    with urlopen(Request(url,headers={'User-Agent':'NorthernWeather/1.0 snow-history-cache'}),timeout=60) as r:
        return r.read()

def window(today):
    return [today-dt.timedelta(days=i) for i in range(13,-1,-1)]

def update(today, directory=ROOT/'data'):
    target=directory/'snow-history'; target.mkdir(parents=True,exist_ok=True)
    manifest_path=directory/'snow-history.json'
    old=json.loads(manifest_path.read_text()) if manifest_path.exists() else {'frames':[]}
    existing={f['date']:f for f in old['frames']}
    frames=[]; mappings=None; failures=[]
    for day in window(today):
        date=day.isoformat()
        if date in existing and (directory/Path(existing[date]['url']).relative_to('data')).exists():
            frames.append(existing[date]); continue
        name=f'ims{day.year}{day.timetuple().tm_yday:03d}_00UTC_4km_v1.3.asc.gz'
        url=f'{ARCHIVE}{day.year}/{name}'
        try:
            grid=read_grid(download(url))
            if mappings is None: mappings=[pixel_indices(z) for z in range(MAX_ZOOM+1)]
            bundle={'date':date,'maxZoom':MAX_ZOOM,'resolutionKm':4,'tiles':encode_tiles(grid,mappings)}
            raw=gzip.compress(json.dumps(bundle,separators=(',',':')).encode(),mtime=0)
            digest=hashlib.sha256(raw).hexdigest()[:12]
            filename=f'{date}-{digest}.json.gz'
            path=target/filename; temporary=path.with_suffix('.tmp'); temporary.write_bytes(raw);temporary.replace(path)
            frames.append({'date':date,'url':f'data/snow-history/{filename}','bytes':len(raw),'source':url})
            print(f'{date}: {len(bundle["tiles"])} tiles, {len(raw)} bytes',flush=True)
        except Exception as error:
            failures.append(date);print(f'{date}: unavailable ({error})',file=sys.stderr,flush=True)
    if not frames: raise RuntimeError('No official daily analyses available; preserving previous archive')
    # Never move an existing archive backwards during a full upstream outage.
    if not any(f['date'] in {d.isoformat() for d in window(today)} for f in frames):
        raise RuntimeError('No recent analyses available')
    manifest={'version':1,'resolutionKm':4,'maxZoom':MAX_ZOOM,'windowStart':window(today)[0].isoformat(),
              'windowEnd':today.isoformat(),'source':'NOAA / USNIC IMS, archived by NSIDC',
              'sourceUrl':'https://nsidc.org/data/g02156/versions/1','frames':frames,'missingDates':failures}
    temporary=manifest_path.with_suffix('.tmp');temporary.write_text(json.dumps(manifest,indent=2)+'\n');temporary.replace(manifest_path)
    retained={Path(f['url']).name for f in frames}
    for path in target.glob('*.json.gz'):
        if path.name not in retained: path.unlink()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--date',type=dt.date.fromisoformat,default=dt.datetime.now(dt.timezone.utc).date())
    update(parser.parse_args().date)
