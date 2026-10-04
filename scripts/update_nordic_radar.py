"""Cache official DMI/IMO radar as transparent Mercator PNGs for static hosting.

These providers do not allow browser CORS. Keep 2.5 hours, preserve successful
old observations on partial failure, and never invent a frame for a missing scan.
"""
import concurrent.futures
import datetime as dt
import hashlib
import io
import json
import pathlib
import re
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/nordic-radar-cache.json'
IMAGE_DIR = ROOT / 'data/radar-cache'
KEEP_SECONDS = 9000
ALLOWED = {'opendataapi.dmi.dk', 'brunnur.vedur.is'}


def download(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED:
        raise ValueError('Unexpected official radar URL')
    request = urllib.request.Request(url, headers={'User-Agent': 'NorthernWeather/8.33'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if urllib.parse.urlparse(response.url).hostname not in ALLOWED:
            raise ValueError('Unexpected radar redirect')
        return response.read()


def parse_dmi(payload, first, last):
    records = []
    for feature in payload.get('features', []):
        asset = feature.get('asset', feature.get('assets', {})).get('data', {})
        url = asset.get('href', '')
        time = int(dt.datetime.fromisoformat(feature['properties']['datetime'].replace('Z', '+00:00')).timestamp())
        if first <= time <= last and urllib.parse.urlparse(url).hostname == 'opendataapi.dmi.dk':
            records.append({'source': 'dk', 'station': 'dk', 'time': time, 'source_url': url})
    return records


def parse_imo(html, day, station, first, last):
    records = []
    for filename, date in re.findall(r'href="(T_PAGZ\d+_C_BIRK_(\d{14})\.h5)"', html):
        time = int(dt.datetime.strptime(date[:12], '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        if first <= time <= last:
            records.append({'source': 'is', 'station': station, 'time': time,
                            'source_url': f'https://brunnur.vedur.is/radar/data/{day}/{station}/{filename}'})
    return records


def colour_rates(values, what, how):
    import numpy as np
    measured = values.astype(np.float32) * float(what.get('gain', 1)) + float(what.get('offset', 0))
    rates = 10 ** (measured / 10)
    rates = (rates / float(how.get('zr-a', 200))) ** (1 / float(how.get('zr-b', 1.6)))
    valid = (values != what.get('nodata')) & (values != what.get('undetect')) & np.isfinite(rates) & (rates >= .05)
    rates[~valid] = np.nan
    return colour_rate_field(rates)


def colour_rate_field(rates):
    import numpy as np
    valid = np.isfinite(rates) & (rates >= .05)
    stops = [.1, .3, .5, 1, 2, 4, 8, 16, 50, float('inf')]
    colours = np.array([[156,221,255,210],[54,170,255,210],[0,216,154,210],[232,247,0,210],
                        [255,196,0,210],[255,123,0,210],[255,42,42,210],[211,0,215,210],
                        [150,0,190,210],[90,0,145,210]], dtype=np.uint8)
    pixels = colours[np.minimum(np.searchsorted(stops, rates, side='right'), len(colours)-1)]
    pixels[~valid] = 0
    return pixels


def polar_rates(values, what, how, starts, stops, azimuth, ranges):
    """Bilinear linear-Z sampling; undetect is zero, unknown data stays unknown."""
    import numpy as np
    spans = (np.asarray(stops)-np.asarray(starts))%360
    centres = (np.asarray(starts)+spans/2)%360
    order = np.argsort(centres); centres = centres[order]
    position = (np.searchsorted(centres, azimuth, side='right')-1)%len(centres)
    following = (position+1)%len(centres)
    distance = (centres[following]-centres[position])%360
    angular = np.clip(((azimuth-centres[position])%360)/np.maximum(distance,.00001),0,1)
    # Match the worker's compact interpolation weights.
    angular = np.round(angular*255)/255
    centred = np.clip(ranges-.5,0,values.shape[1]-1)
    col = np.floor(centred).astype(int); right = np.minimum(col+1,values.shape[1]-1)
    radial = np.round((centred-col)*255)/255
    row = order[position]; next_row = order[following]
    z = np.zeros(azimuth.shape, dtype=np.float32)
    valid = (ranges>=0)&(ranges<values.shape[1])&(distance<=2*np.maximum(spans[row],spans[next_row]))
    for r,c,weight in ((row,col,(1-angular)*(1-radial)),(row,right,(1-angular)*radial),
                       (next_row,col,angular*(1-radial)),(next_row,right,angular*radial)):
        sample = values[r,c]
        valid &= (weight==0)|(sample!=what.get('nodata'))
        reflectivity = 10**((sample.astype(np.float32)*float(what.get('gain',1))+float(what.get('offset',0)))/10)
        reflectivity[sample==what.get('undetect')] = 0
        z += weight*reflectivity
    rates = (z/float(how.get('zr-a',200)))**(1/float(how.get('zr-b',1.6)))
    rates[~valid] = np.nan
    return rates


def scalar(value):
    if hasattr(value, 'shape') and value.shape:
        value = value.flat[0]
    return value.decode() if isinstance(value, bytes) else value


def attrs(group):
    return {key: scalar(value) for key, value in group.attrs.items()} if group is not None else {}


def project(raw, edge=2000):
    import h5py
    import numpy as np
    from PIL import Image
    from pyproj import Transformer
    with h5py.File(io.BytesIO(raw), 'r') as file:
        root, where, how = attrs(file.get('what')), attrs(file.get('where')), attrs(file.get('how'))
        polar = root.get('object') == 'PVOL'
        name = min((n for n in file if re.fullmatch(r'dataset\d+', n)),
                   key=lambda n: float(file[n]['where'].attrs['elangle'])) if polar else 'dataset1'
        group = file[name]
        what = {**root, **attrs(group.get('what')), **attrs(group.get('data1')), **attrs(group.get('data1/what'))}
        if what.get('quantity', what.get('product')) not in ('DBZH', 'DBZ'):
            raise ValueError('Unexpected reflectivity quantity')
        values = group['data1/data'][...]
        rows, cols = values.shape
        if polar:
            w, h = attrs(group['where']), group.get('how')
            projection = f"+proj=aeqd +lat_0={where['lat']} +lon_0={where['lon']} +datum=WGS84 +units=m +x_0=0 +y_0=0"
            rscale, rstart, elevation = float(w['rscale']), float(w['rstart'])*1000, float(w['elangle'])
            radius = cols*rscale
            left, top, dx, dy = -radius, radius, radius*2/cols, radius*2/rows
            if h is None or 'startazA' not in h.attrs or 'stopazA' not in h.attrs:
                raise ValueError('Missing polar azimuth coordinates')
        else:
            projection = where['projdef']
            forward = Transformer.from_crs('EPSG:4326', projection, always_xy=True)
            left, top = forward.transform(where['UL_lon'], where['UL_lat'])
            dx, dy = where['xscale'], where['yscale']
        inverse = Transformer.from_crs(projection, 'EPSG:4326', always_xy=True)
        forward = Transformer.from_crs('EPSG:4326', projection, always_xy=True)
        t = np.linspace(0, 1, 33)
        xs = np.concatenate([left+dx*cols*t, left+dx*cols*t, np.full(33,left), np.full(33,left+dx*cols)])
        ys = np.concatenate([np.full(33,top), np.full(33,top-dy*rows), top-dy*rows*t, top-dy*rows*t])
        lons, lats = inverse.transform(xs, ys)
        west, east, south, north = float(min(lons)), float(max(lons)), float(min(lats)), float(max(lats))
        mtop, mbottom = np.log(np.tan(np.pi/4+np.radians([north,south])/2))
        aspect = np.radians(east-west)/(mtop-mbottom)
        width, height = (edge, round(edge/aspect)) if aspect>1 else (round(edge*aspect), edge)
        lon = west+(np.arange(width)+.5)/width*(east-west)
        lat = np.degrees(2*np.arctan(np.exp(mtop-(np.arange(height)+.5)/height*(mtop-mbottom)))-np.pi/2)
        x, y = forward.transform(*np.meshgrid(lon,lat))
        if polar:
            ranges = (np.hypot(x,y)/np.cos(np.radians(elevation))-rstart)/rscale
            azimuth = (np.degrees(np.arctan2(x,y))+360)%360
            rates = polar_rates(values,what,how,h.attrs['startazA'],h.attrs['stopazA'],azimuth,ranges)
            pixels = colour_rate_field(rates)
        else:
            col = np.floor((x-left)/dx).astype(int); row = np.floor((top-y)/dy).astype(int)
            valid = (col>=0)&(col<cols)&(row>=0)&(row<rows)
            sampled = values[np.clip(row,0,rows-1),np.clip(col,0,cols-1)]
            pixels = colour_rates(sampled,what,how); pixels[~valid] = 0
        output = io.BytesIO(); Image.fromarray(pixels).save(output,format='PNG',optimize=True)
        return output.getvalue(), [[south,west],[north,east]]


def main():
    now = int(dt.datetime.now(dt.timezone.utc).timestamp()); first = now-KEEP_SECONDS
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {'frames': []}
    existing = {f['source_url']: f for f in previous['frames'] if first<=f['time']<=now and (ROOT/f['url']).exists()}
    records, errors = [], []
    params = urllib.parse.urlencode({'limit':100,'sortorder':'datetime,DESC',
             'datetime': dt.datetime.fromtimestamp(first,dt.timezone.utc).isoformat()+'/'+dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat()})
    try:
        records += parse_dmi(json.loads(download('https://opendataapi.dmi.dk/v1/radardata/collections/composite/items?'+params)),first,now)
    except Exception as error:
        errors.append('DMI: '+str(error))
    days = sorted({dt.datetime.fromtimestamp(t,dt.timezone.utc).date().isoformat() for t in (first,now)})
    def station_list(item):
        day, station = item
        raw = download(f'https://brunnur.vedur.is/radar/data/{day}/{station}/').decode()
        return parse_imo(raw,day,station,first,now)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for item, future in zip([(d,s) for d in days for s in ('iskef','isska','isx2')],
                               [pool.submit(station_list,(d,s)) for d in days for s in ('iskef','isska','isx2')]):
            try: records += future.result()
            except Exception as error: errors.append('/'.join(item)+': '+str(error))
    pending = [r for r in records if r['source_url'] not in existing]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [(record,pool.submit(download,record['source_url'])) for record in pending]
        for record, future in futures:
            try:
                png,bounds = project(future.result())
                filename = record['station']+'-'+str(record['time'])+'-'+hashlib.sha256(png).hexdigest()[:12]+'.png'
                (IMAGE_DIR/filename).write_bytes(png)
                existing[record['source_url']] = {**record,'format':'png','bounds':bounds,'url':'data/radar-cache/'+filename}
            except Exception as error: errors.append(record['station']+' '+str(record['time'])+': '+str(error))
    frames = sorted(existing.values(),key=lambda frame:frame['time'])
    if not frames: raise RuntimeError('No successful official radar frames: '+'; '.join(errors))
    OUTPUT.write_text(json.dumps({'generated_at':now,'sources':{'dk':'DMI','is':'Icelandic Meteorological Office'},
                                 'frames':frames,'errors':errors},separators=(',',':'))+'\n')
    keep = {pathlib.Path(frame['url']).name for frame in frames}
    for path in IMAGE_DIR.glob('*.png'):
        if path.name not in keep: path.unlink()
    print(f'Cached {len(frames)} official radar frames; {len(errors)} failed requests',flush=True)
    for error in errors: print(error,flush=True)


if __name__ == '__main__': main()
