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

# The official Estonia warning feed names sea areas but does not publish map
# polygons. Keep the two Gulf of Finland display envelopes on the Estonian half
# of the gulf so they do not sprawl into Finland and get shredded by Finnish
# coastline/island cut-outs. Extra offshore vertices make their north edges
# follow the gulf more naturally instead of looking like large rectangles.
DISPLAY_ZONE_OVERRIDES = {
    'soome lahe lääneosa': [
        [59.16, 22.86], [59.36, 22.92], [59.56, 23.15], [59.69, 23.55],
        [59.72, 24.05], [59.73, 24.55], [59.72, 25.05], [59.66, 25.48],
        [59.53, 25.42], [59.42, 25.12], [59.31, 24.58], [59.22, 23.85],
        [59.16, 22.86],
    ],
    'soome lahe idaosa': [
        [59.34, 25.43], [59.55, 25.47], [59.67, 25.85], [59.73, 26.40],
        [59.76, 27.05], [59.76, 27.70], [59.72, 28.30], [59.63, 28.68],
        [59.51, 28.52], [59.43, 27.95], [59.37, 27.15], [59.34, 26.25],
        [59.34, 25.43],
    ],
    'läänemere põhjaosa': [
        [58.05, 20.75], [58.30, 20.62], [58.70, 20.72], [59.05, 20.98],
        [59.28, 21.32], [59.43, 21.70], [59.52, 22.10], [59.50, 22.48],
        [59.35, 22.78], [59.15, 22.98], [58.90, 22.92], [58.62, 22.68],
        [58.35, 22.32], [58.15, 21.82], [58.05, 21.25], [58.05, 20.75],
    ],
}


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
    zones.update(DISPLAY_ZONE_OVERRIDES)
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
