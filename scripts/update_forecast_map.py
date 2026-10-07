"""Small MET Nordic WMS manifest; raster images are requested only by map viewers."""
import json
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

def main():
    paths = discover(get(ROOT + 'catalog/metpplatest/catalog.xml'))
    errors = []
    for path in paths[:3]:
        try:
            caps = parse_capabilities(get(ROOT + 'wms/' + path + '?service=WMS&version=1.3.0&request=GetCapabilities'))
            manifest = build_manifest(path, caps, get(ROOT + 'dodsC/' + path + '.das'))
            dest = Path(__file__).resolve().parents[1] / 'data/forecast-map.json'
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(manifest, indent=2) + '\n')
            print('MET Nordic forecast maps:', path, manifest['time_dimension'])
            return
        except Exception as error:
            errors.append(str(error))
    raise RuntimeError('No usable MET Nordic forecast; previous manifest retained: ' + '; '.join(errors))

if __name__ == '__main__':
    main()
