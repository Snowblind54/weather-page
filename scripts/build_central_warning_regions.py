"""Rebuild Czech/Slovak official warning boundaries (not a scheduled download).

Czech CISORP codes/names and regional membership come from CHMI. Geometry
comes from CUZK/RUIAN ORP polygons, matched by unique official Czech names.
Slovak district geometries/codes come directly from SHMU's warning map.
"""
import datetime as dt
import gzip
import json
import pathlib
import re
import unicodedata
import urllib.parse
from update_latvia_warnings import download
from update_national_warnings import polygons

ROOT=pathlib.Path(__file__).resolve().parents[1]
CHMI='https://vystrahy-cr.chmi.cz/config/global.json'
CUZK='https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer/14/query?'+urllib.parse.urlencode({
    'where':'1=1','outFields':'*','returnGeometry':'true','outSR':4326,
    'geometryPrecision':5,'maxAllowableOffset':0.0007,'f':'geojson'})
SHMU='https://www.shmu.sk/assets/maps/meteo_map.json'
OUTPUT=ROOT/'data/central-warning-regions.json.gz'


def name_key(value):
    return re.sub('[^a-z0-9]','',unicodedata.normalize('NFKD',value).encode('ascii','ignore').decode().lower())


def build(czech, metadata, slovak):
    names={name_key(name):key.split(':')[-1] for key,name in metadata['orp-names'].items()}
    # RUIAN uses Prague's full administrative name, CHMI its short name.
    names[name_key('Hlavní město Praha')]=names[name_key('Praha')]
    regions={'CZ':{},'SK':{}}
    aliases={'CZ':{}}
    for feature in czech['features']:
        code=names[name_key(feature['properties']['nazev'])]
        key='CISORP:'+code
        if key in regions['CZ']:raise ValueError('Duplicate official ORP name')
        shape=polygons(feature['geometry'])
        regions['CZ'][key]=shape
        aliases['CZ']['EMMA_ID:CZ'+code.zfill(5)]=[key]
    for region, codes in metadata['area-mapping']['regions-to-orp'].items():
        aliases['CZ']['NUTS3:'+region.split(':')[-1]]=['CISORP:'+code.split(':')[-1] for code in codes]
    # CHMI's map uses CZ090 internally for Prague; its NUTS3 code is CZ010.
    aliases['CZ']['NUTS3:CZ010']=['CISORP:1100']
    for feature in slovak['features']:
        code='SK'+str(feature['properties']['ID']).zfill(3)
        regions['SK']['EMMA_ID:'+code]=polygons(feature['geometry'])
    if len([k for k in regions['CZ'] if k.startswith('CISORP:')])!=206 or len(regions['SK'])!=72:
        raise ValueError('Incomplete official Czech/Slovak warning boundaries')
    return {'version':1,'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
        'sources':{'CZ_codes':CHMI,'CZ_boundaries':CUZK,'SK':SHMU},
        'attribution':'ČHMÚ; ČÚZK/RÚIAN (ORP administrative boundaries); SHMÚ (warning districts). Boundaries generalised for display; geographic warning areas are not elevation masks.',
        'regions':regions,'aliases':aliases}


def main():
    data=build(json.loads(download(CUZK)),json.loads(download(CHMI)),json.loads(download(SHMU)))
    OUTPUT.write_bytes(gzip.compress(json.dumps(data,ensure_ascii=False,separators=(',',':')).encode(),mtime=0))
    print({c:len(r) for c,r in data['regions'].items()})


if __name__=='__main__':main()
