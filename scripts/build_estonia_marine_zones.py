"""Build static water-only Estonian warning zones (requires shapely).

Natural Earth 1:10 million land and lake geometry removes coastline/island
overlap from the named forecast zones. The outer forecast-zone limits remain
the map's approximations; this is not an official maritime-boundary dataset.
Run: python3 scripts/build_estonia_marine_zones.py [--land FILE --lakes FILE]
"""
import argparse
import ast
import hashlib
import json
import re
import urllib.request
from pathlib import Path

from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'


def source_data(kind, path):
    url = SOURCE + f'ne_10m_{kind}.geojson'
    data = Path(path).read_bytes() if path else urllib.request.urlopen(url, timeout=60).read()
    return json.loads(data), {'url': url, 'sha256': hashlib.sha256(data).hexdigest()}


def build(land, lakes):
    source = (ROOT / 'js/warnings.js').read_text()
    match = re.search(r'const ESTONIA_MARINE_WARNING_ZONES=(\{.*?\n\});', source, re.S)
    if not match:
        raise ValueError('Named marine warning zones not found')
    zones = ast.literal_eval(match[1])
    region = box(19, 56, 30, 62)
    land_mask = unary_union([shape(f['geometry']).intersection(region) for f in land['features']
                             if shape(f['geometry']).intersects(region)])
    lake_mask = unary_union([shape(f['geometry']).intersection(region) for f in lakes['features']
                             if shape(f['geometry']).intersects(region)])
    features = []
    for name, latlon in zones.items():
        original = Polygon([(lon, lat) for lat, lon in latlon])
        water = original.intersection(lake_mask) if name == 'peipsi järv' else original.difference(land_mask)
        if water.is_empty or not water.is_valid or water.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError(f'Invalid water geometry for {name}')
        if name != 'peipsi järv' and water.intersection(land_mask).area > 1e-10:
            raise ValueError(f'Land overlap in {name}')
        features.append({'type': 'Feature', 'properties': {'area': name, 'water': 'lake' if name == 'peipsi järv' else 'sea'},
                         'geometry': mapping(water)})
    return features


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--land')
    parser.add_argument('--lakes')
    args = parser.parse_args()
    land, land_source = source_data('land', args.land)
    lakes, lake_source = source_data('lakes', args.lakes)
    collection = {'type': 'FeatureCollection', 'sources': {'land': land_source, 'lakes': lake_source},
                  'attribution': 'Natural Earth, public domain; 1:10 million land and lakes. Named forecast-zone limits are approximate.',
                  'features': build(land, lakes)}
    output = ROOT / 'data/estonia-marine-warning-zones.geojson'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(collection, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{len(collection["features"])} water-only warning zones, {output.stat().st_size} bytes')


if __name__ == '__main__':
    main()
