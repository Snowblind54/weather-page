"""Build immutable, compact DEM context for station interpolation (not weather).

Mapzen / Tilezen Terrarium source tiles: https://registry.opendata.aws/terrain-tiles/
Run manually; output is committed with the app, never rebuilt per visitor/update.
Sampling is deliberately regional, not a claim to resolve individual slopes.
"""
import concurrent.futures as futures
import gzip
import io
import json
import math
from pathlib import Path
import struct
import urllib.request
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
CACHE=Path('/tmp/northern-terrain-tiles')
PACKS=[('global',-60,84,-180,180,.25,3),('europe',32,73,-27,43,.05,6)]

def pixel(lat,lon,z):
    n=256*2**z
    return (lon+180)/360*n,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n

def tile(key):
    z,x,y=key;p=CACHE/f'{z}-{x}-{y}.png';CACHE.mkdir(exist_ok=True)
    if not p.exists():
        url=f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
        p.write_bytes(urllib.request.urlopen(url,timeout=45).read())
    a=np.asarray(Image.open(p).convert('RGB'),dtype=np.float32)
    return key,a[:,:,0]*256+a[:,:,1]+a[:,:,2]/256-32768

def build(spec):
    name,s,n,w,e,step,z=spec
    rows=round((n-s)/step)+1;cols=round((e-w)/step)+1
    xs=np.array([pixel(s,w+i*step,z)[0] for i in range(cols)])
    ys=np.array([pixel(s+j*step,w,z)[1] for j in range(rows)])
    xi=np.floor(xs).astype(int).clip(0,256*2**z-1);yi=np.floor(ys).astype(int).clip(0,256*2**z-1)
    keys=[(z,int(x),int(y)) for x in np.unique(xi//256) for y in np.unique(yi//256)]
    result=np.empty((rows,cols),dtype='<i2')
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        for (_,x,y),a in pool.map(tile,keys):
            ix=np.where(xi//256==x)[0];iy=np.where(yi//256==y)[0]
            # Quantize terrain heights to 10 m. Negative ocean depths are not
            # used for weather interpolation, but below-sea-level land is kept.
            samples=a[np.ix_(yi[iy]%256,xi[ix]%256)]
            result[np.ix_(iy,ix)]=np.rint(samples/10).clip(-100,1000).astype('<i2')
    header=json.dumps(dict(version=1,name=name,south=s,north=n,west=w,east=e,step=step,rows=rows,cols=cols,scale=10),separators=(',',':')).encode()
    output=ROOT/'assets'/f'terrain-{name}-v1.bin.gz';output.parent.mkdir(exist_ok=True)
    output.write_bytes(gzip.compress(struct.pack('<I',len(header))+header+result.tobytes(),mtime=0))
    print(name,'tiles',len(keys),'bytes',output.stat().st_size,'grid',rows,cols,flush=True)

if __name__=='__main__':
    for spec in PACKS:build(spec)
