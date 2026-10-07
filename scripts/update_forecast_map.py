"""Publish shared, fixed-region MET Nordic forecast images to GitHub Pages."""
import json
import io
import math
import shutil
import tempfile
import time
from threading import Event
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import urlencode
from PIL import Image
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = 'https://thredds.met.no/thredds/'
VARIABLES = {'temperature': ('air_temperature_2m', 'K'), 'rain': ('precipitation_amount', 'kg/m^2'),
             'wind': ('wind_speed_10m', 'm/s'), 'gusts': ('wind_speed_of_gust', 'm/s'),
             'clouds': ('cloud_area_fraction', '1')}
PATTERN = re.compile(r'^metpplatest/met_forecast_1_0km_nordic_(\d{8}T\d{2}Z)\.nc$')

def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page'})
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read().decode('utf-8')

def discover(xml):
    root = ET.fromstring(xml)
    return sorted({d.get('urlPath') for d in root.iter() if d.tag.split('}')[-1] == 'dataset'
                   and PATTERN.match(d.get('urlPath', ''))}, reverse=True)

def parse_capabilities(xml):
    root = ET.fromstring(xml)
    result = {}
    for layer in root.iter():
        if layer.tag.split('}')[-1] != 'Layer':
            continue
        children = {c.tag.split('}')[-1]: c for c in layer}
        name = children.get('Name')
        if name is None:
            continue
        dims = [c for c in layer if c.tag.split('}')[-1] == 'Dimension' and c.get('name') == 'time']
        bbox = children.get('EX_GeographicBoundingBox')
        if dims and bbox is not None:
            coords = {c.tag.split('}')[-1]: float(c.text) for c in bbox}
            result[name.text] = {'dimension': dims[0].text.strip(), 'bounds': [coords['westBoundLongitude'], coords['southBoundLatitude'], coords['eastBoundLongitude'], coords['northBoundLatitude']]}
    return result

def build_manifest(path, capabilities, das, now=None):
    now = now or datetime.now(timezone.utc)
    match = PATTERN.match(path)
    if not match:
        raise ValueError('Invalid MET Nordic path')
    layers = {}
    for key, (name, unit) in VARIABLES.items():
        attr = re.search(r'\b' + re.escape(name) + r'\s*\{([^}]+)\}', das)
        actual = re.search(r'String units "([^"]+)"', attr.group(1)) if attr else None
        if name in capabilities and actual and actual.group(1) == unit:
            layers[key] = name
    if not all(key in layers for key in ['temperature', 'rain', 'wind']):
        raise ValueError('Required forecast map variables or units unavailable')
    meta = capabilities[layers['temperature']]
    parts = meta['dimension'].split('/')
    if len(parts) != 3 or parts[2] != 'PT1H':
        raise ValueError('Expected hourly forecast grid')
    end = datetime.fromisoformat(parts[1].replace('Z', '+00:00'))
    if (end - now).total_seconds() < 7200:
        raise ValueError('No useful future map times')
    for name in layers.values():
        if capabilities[name]['dimension'] != meta['dimension']:
            raise ValueError('Forecast layer times differ')
    reference = datetime.strptime(match.group(1), '%Y%m%dT%HZ').replace(tzinfo=timezone.utc)
    return {'source': 'MET Norway · MET Nordic (MEPS post-processed)', 'generated_at': now.isoformat(),
            'reference_time': reference.isoformat(), 'endpoint': ROOT + 'wms/' + path,
            'time_dimension': meta['dimension'], 'bounds': meta['bounds'], 'layers': layers,
            'grid_spacing_km': 1, 'precipitation_period': 'one hour ending at source timestamp',
            'licence': 'CC BY 4.0', 'documentation': 'https://github.com/metno/NWPdocs/wiki/MET-Nordic-dataset'}

# Keep colour scales aligned with js/forecast-map-data.js. Rain ends one hour
# after the displayed selection; all other variables are instantaneous.
STYLES = {
    'temperature': ('metnoredblue', '253.15,303.15'),
    'rain': ('metnoprecipitation', '0.1,10'),
    'wind': ('rainbow', '0,30'),
    'gusts': ('rainbow', '0,40'),
    'clouds': ('greyscale', '0,1'),
}
WIDTH, HEIGHT = 2048, 2048

def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def forecast_times(manifest):
    start, end, _ = manifest['time_dimension'].split('/')
    first = datetime.fromisoformat(start.replace('Z', '+00:00'))
    last = datetime.fromisoformat(end.replace('Z', '+00:00')) - timedelta(hours=1)
    return [first + timedelta(hours=i) for i in range(int((last-first).total_seconds()//3600)+1)]

def projected_bbox(bounds):
    def project(lon, lat):
        return 6378137 * math.radians(lon), 6378137 * math.log(math.tan(math.pi/4 + math.radians(lat)/2))
    return (*project(bounds[0], bounds[1]), *project(bounds[2], bounds[3]))

def image_url(manifest, kind, valid=None):
    palette, scale = STYLES[kind]
    params = {'service':'WMS', 'version':'1.1.1', 'colorscalerange':scale,
              'numcolorbands':64, 'logscale':'false'}
    if valid is None:
        params.update(request='GetLegendGraphic', layer=manifest['layers'][kind],
                      palette=palette, colorbaronly='true', vertical='false', width=256, height=18)
    else:
        source_time = valid + timedelta(hours=1) if kind == 'rain' else valid
        params.update(request='GetMap', format='image/png', transparent='true', srs='EPSG:3857',
                      bbox=','.join(map(str, projected_bbox(manifest['bounds']))), width=WIDTH, height=HEIGHT,
                      layers=manifest['layers'][kind], styles='raster/'+palette, time=iso(source_time),
                      belowmincolor='transparent' if kind=='rain' else 'extend',
                      abovemaxcolor='extend', nodatacolor='transparent')
    return manifest['endpoint'] + '?' + urlencode(params)

def download_image(url, dest, expected_size):
    request = urllib.request.Request(url, headers={'User-Agent':'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page'})
    # Only two workers; no immediate retries or retries after rate limiting.
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(12 * 1024 * 1024)
    with Image.open(io.BytesIO(data)) as image:
        if image.size != expected_size:
            raise ValueError('Unexpected forecast image dimensions')
        image.load()
        image.convert('RGBA').save(dest, format='WEBP', lossless=True, method=4)
    time.sleep(0.4)

def publish_cache(manifest, data_dir, downloader=download_image):
    cycle = datetime.fromisoformat(manifest['reference_time']).strftime('%Y%m%dT%HZ')
    root = data_dir / 'forecast-cache'
    root.mkdir(parents=True, exist_ok=True)
    times = forecast_times(manifest)
    tasks = []
    frames = {key:{} for key in manifest['layers']}
    legends = {}
    for key in manifest['layers']:
        for valid in times:
            filename = key + '-' + valid.strftime('%Y%m%dT%HZ') + '.webp'
            frames[key][iso(valid)] = 'data/forecast-cache/' + cycle + '/' + filename
            tasks.append((image_url(manifest,key,valid), filename, (WIDTH,HEIGHT)))
        filename = key + '-legend.webp'
        legends[key] = 'data/forecast-cache/' + cycle + '/' + filename
        tasks.append((image_url(manifest,key), filename, (256,18)))
    stage = Path(tempfile.mkdtemp(prefix='_staging-', dir=root))
    try:
        # map() is deliberately bounded to two concurrent source requests.
        stopped = Event()
        with ThreadPoolExecutor(max_workers=2) as pool:
            def work(task):
                if stopped.is_set(): return
                url, filename, size = task
                try: downloader(url,stage/filename,size)
                except Exception:
                    stopped.set()
                    raise
            for i, _ in enumerate(pool.map(work,tasks), 1):
                if i % 25 == 0: print('Saved',i,'/',len(tasks),'forecast images',flush=True)
        size = sum(p.stat().st_size for p in stage.iterdir())
        if size > 200*1024*1024:
            raise ValueError('Forecast cache exceeds 200 MiB publishing budget')
        destination = root / cycle
        if destination.exists(): shutil.rmtree(destination)
        stage.rename(destination)
        cached = {**manifest, 'delivery':'static-regional-images', 'images':frames,
                  'legends':legends, 'image_size':[WIDTH,HEIGHT], 'cache_bytes':size,
                  'cached_times':[iso(t) for t in times], 'refresh_interval_hours':6}
        # Images are complete before the new manifest becomes visible.
        temp = data_dir/'forecast-map.json.tmp'
        temp.write_text(json.dumps(cached,indent=2)+'\n')
        temp.replace(data_dir/'forecast-map.json')
        # Retain this and the preceding cycle so open tabs can finish loading.
        cycles = sorted(p for p in root.iterdir() if p.is_dir() and re.fullmatch(r'\d{8}T\d{2}Z',p.name))
        for old in cycles[:-2]: shutil.rmtree(old)
        print('Published',len(tasks),'shared forecast images;',round(size/1024/1024,2),'MiB')
        return cached
    finally:
        if stage.exists(): shutil.rmtree(stage)

def cache_complete(previous, data_dir):
    if previous.get('delivery') != 'static-regional-images': return False
    files = [p for frames in previous.get('images',{}).values() for p in frames.values()]
    files += list(previous.get('legends',{}).values())
    return bool(files) and all((data_dir.parent / p).is_file() for p in files)

def main():
    dest = Path(__file__).resolve().parents[1] / 'data'
    previous = json.loads((dest/'forecast-map.json').read_text()) if (dest/'forecast-map.json').exists() else {}
    # MET Nordic publishes hourly; sample one model cycle every six hours.
    # Check twice an hour, but never download the same complete cycle again.
    paths = [p for p in discover(get(ROOT+'catalog/metpplatest/catalog.xml'))
             if datetime.strptime(PATTERN.match(p).group(1),'%Y%m%dT%HZ').hour % 6 == 0]
    errors = []
    for path in paths[:3]:
        reference = datetime.strptime(PATTERN.match(path).group(1),'%Y%m%dT%HZ').replace(tzinfo=timezone.utc).isoformat()
        if reference == previous.get('reference_time') and cache_complete(previous,dest):
            print('Shared forecast images already current; no image requests.')
            return
        try:
            caps = parse_capabilities(get(ROOT+'wms/'+path+'?service=WMS&version=1.3.0&request=GetCapabilities'))
            manifest = build_manifest(path,caps,get(ROOT+'dodsC/'+path+'.das'))
        except Exception as error:
            errors.append(str(error))
            continue
        # A failed image download must preserve the preceding complete snapshot.
        publish_cache(manifest,dest)
        return
    raise RuntimeError('No usable MET Nordic forecast; previous images retained: '+'; '.join(errors))

if __name__ == '__main__':
    main()
