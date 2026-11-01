"""Build exact-code warning shapes from the Meteoalarm catalogue and district data.

Inputs: --emma the existing public EMMA_ID catalogue mirror, --turkey the
Sakarya University Geography district FeatureCollection (EPSG:4326), --mgm
MGM's coded district names extracted from its 81 public provincial SVG maps.
The warning updaters never download these static boundaries per visitor.
"""
import argparse
import datetime as dt
import gzip
import json
from pathlib import Path
import unicodedata
from update_latvia_warnings import simplify

EMMA='https://saratoga-weather.org/meteoalarm-map/meteoalarm-map-data.js'
TURKEY='https://services5.arcgis.com/26ObnytmBZ58Wbj8/ArcGIS/rest/services/turkiye_ilce_sinirlari/FeatureServer/0'
MGM='https://www.mgm.gov.tr/meteouyari/Scripts/Map/SVG/'
# Explicit spelling differences in MGM's district labels; never fuzzy-match areas.
DISTRICT_SPELLINGS={'90406':'Doğubayazıt','90717':'Döşemealtı','92009':'Bekilli','92505':'Horasan','93524':'Seferihisar','93605':'Akyaka','94006':'Çiçekdağı','94112':'Dilovası','95513':'19.May','96306':'Siverek','97107':'Yahşihan'}
OUTPUT=Path(__file__).resolve().parents[1]/'data/southern-warning-regions.json.gz'


def normalized(s):
    return ''.join(c for c in unicodedata.normalize('NFKD',s.replace('ı','i').replace('İ','I')).casefold() if c.isalnum() and not unicodedata.combining(c))


def shapes(geometry,latlon=False):
    polygons=[geometry['coordinates']] if geometry['type']=='Polygon' else geometry['coordinates'] if geometry['type']=='MultiPolygon' else []
    out=[]
    for polygon in polygons:
        rings=[]
        for ring in polygon:
            points=[[round(float(p[0] if latlon else p[1]),5),round(float(p[1] if latlon else p[0]),5)] for p in ring]
            if len(points)<4 or points[0]!=points[-1] or any(not -90<=p[0]<=90 or not -180<=p[1]<=180 for p in points):raise ValueError('Invalid boundary ring')
            reduced=simplify(points,.002)
            if len(reduced)<4:reduced=points
            rings.append(reduced)
        if rings:out.append(rings)
    return out


def build(emmas,turkey,metadata):
    regions={c:{} for c in ('ES','IT','GR','TR')};names={};missing={}
    for f in emmas:
        p=f['properties'];c=p.get('country');code=p.get('code','')
        if c not in ('ES','IT','GR') or not code.startswith(c) or p.get('type')!='EMMA_ID':continue
        key='EMMA_ID:'+code;geometry=shapes(f['geometry'],True)
        if not geometry or key in regions[c]:raise ValueError('Missing/duplicate Meteoalarm zone '+key)
        regions[c][key]=geometry
    by_name={};ambiguous=set()
    for f in turkey['features']:
        p=f['properties'];key=(normalized(p['il_adi']),normalized(p['ilce_adi']))
        if key in by_name:ambiguous.add(key)
        by_name[key]=f['geometry']
    for code,m in metadata.items():
        key=(normalized(m['province']),normalized(DISTRICT_SPELLINGS.get(code,m['name'])))
        if key not in by_name or key in ambiguous:missing[code]=m;continue
        geometry=shapes(by_name[key])
        if not geometry:missing[code]=m;continue
        regions['TR']['MGM:'+code]=geometry;names[code]=m
    if len(regions['ES'])<200 or len(regions['IT'])!=20 or len(regions['GR'])<16 or len(regions['TR'])<900:raise ValueError('Incomplete warning boundary inputs')
    return dict(version=1,generatedAt=dt.datetime.now(dt.timezone.utc).isoformat(),sources=dict(meteoalarmCatalogueMirror=EMMA,turkeyDistricts=TURKEY,turkeyOfficialDistrictCodes=MGM),
        attribution='Meteoalarm / EUMETNET EMMA_ID warning zones (public catalogue mirror dated 2025-10-06). Turkish district geometry: Sakarya University, Geography Department; district identities: MGM MeteoUYARI. Boundaries generalised for display; unknown codes are never mapped to a larger guessed area.',
        regions=regions,turkeyDistricts=names,unmappedTurkishDistricts=missing)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--emma',required=True);parser.add_argument('--turkey',required=True);parser.add_argument('--mgm',required=True);args=parser.parse_args()
    emmas=json.JSONDecoder().raw_decode(Path(args.emma).read_text().split('var data = ',1)[1])[0]
    result=build(emmas,json.loads(Path(args.turkey).read_text()),json.loads(Path(args.mgm).read_text()))
    OUTPUT.write_bytes(gzip.compress((json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n').encode(),mtime=0))
    print({c:len(r) for c,r in result['regions'].items()},'unmatched Turkish district codes',len(result['unmappedTurkishDistricts']))

if __name__=='__main__':main()
