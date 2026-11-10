"""Build IPMA warning areas from the public Meteoalarm boundary catalogue.

Usage: python3 scripts/build_portugal_warning_regions.py /path/to/meteoalarm-map-data.js
The district, island group and Madeira codes are matched to published area names.
"""
import gzip
import json
from pathlib import Path
import sys

from build_southern_warning_regions import EMMA, shapes

OUTPUT = Path(__file__).resolve().parents[1] / 'data/portugal-warning-regions.json.gz'
# IPMA idAreaAviso -> (Meteoalarm EMMA_ID suffix, display name)
AREAS = {
    'AOC': (1, 'Azores – Western Group'), 'ACE': (2, 'Azores – Central Group'),
    'AOR': (3, 'Azores – Eastern Group'), 'BJA': (5, 'Beja'),
    'VCT': (6, 'Viana do Castelo'), 'VRL': (7, 'Vila Real'), 'BGC': (8, 'Bragança'),
    'PTO': (9, 'Porto'), 'AVR': (10, 'Aveiro'), 'VIS': (11, 'Viseu'), 'GDA': (12, 'Guarda'),
    'CBR': (13, 'Coimbra'), 'CBO': (14, 'Castelo Branco'), 'LRA': (15, 'Leiria'),
    'LSB': (16, 'Lisboa'), 'STM': (17, 'Santarém'), 'PTG': (18, 'Portalegre'),
    'EVR': (19, 'Évora'), 'STB': (20, 'Setúbal'), 'FAR': (21, 'Faro'), 'BRG': (22, 'Braga'),
    'MRM': (23, 'Madeira – Mountain Regions'), 'MCS': (24, 'Madeira – South Coast'),
    'MCN': (25, 'Madeira – North Coast'), 'MPS': (26, 'Madeira – Porto Santo'),
}


def build(features):
    zones = {}
    for feature in features:
        props = feature['properties']
        if props.get('country') != 'PT' or props.get('type') != 'EMMA_ID':
            continue
        code = props['code']
        if code in zones:
            raise ValueError(f'Duplicate Meteoalarm zone {code}')
        zones[code] = shapes(feature['geometry'], latlon=True)
    regions = {}
    for area, (number, name) in AREAS.items():
        code = f'PT{number:03d}'
        if not zones.get(code):
            raise ValueError(f'Missing Meteoalarm zone {code}')
        regions[area] = dict(name=name, emmaId=code, polygons=zones[code])
    return dict(version=1, source=EMMA,
                attribution='Meteoalarm / EUMETNET EMMA_ID warning zones, generalised for display.',
                regions=regions)


if __name__ == '__main__':
    catalogue = Path(sys.argv[1]).read_text()
    features = json.JSONDecoder().raw_decode(catalogue.split('var data = ', 1)[1].lstrip())[0]
    data = (json.dumps(build(features), ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    OUTPUT.write_bytes(gzip.compress(data, mtime=0))
