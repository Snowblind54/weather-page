"""Rebuild exact-code warning boundaries; run only when boundary data changes.

DWD WFS and Eurostat GISCO are primary boundary datasets. BE801 is the
Meteoalarm coastal warning polygon, retained in the public EMMA_ID catalogue
mirror (the legacy Meteoalarm geometry download has been retired).
"""
import datetime as dt
import gzip
import json
import pathlib
import urllib.parse
from update_latvia_warnings import download
from update_national_warnings import polygons

ROOT = pathlib.Path(__file__).resolve().parents[1]
DWD = 'https://maps.dwd.de/geoserver/dwd/ows?' + urllib.parse.urlencode({
    'service':'WFS','version':'2.0.0','request':'GetFeature',
    'typeNames':'dwd:Warngebiete_Kreise','outputFormat':'application/json','srsName':'EPSG:4326'})
GISCO = 'https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2024_4326_LEVL_2.geojson'
EMMA = 'https://saratoga-weather.org/meteoalarm-map/meteoalarm-map-data.js'


def build(dwd, gisco, emma):
    regions={'DE':{},'BE':{}}
    for feature in dwd['features']:
        p=feature['properties']
        regions['DE']['WARNCELLID:'+str(p['WARNCELLID'])]=polygons(feature['geometry'])
    for feature in gisco['features']:
        p=feature['properties']
        if p.get('CNTR_CODE')=='BE':
            regions['BE']['NUTS2:'+p['NUTS_ID']]=polygons(feature['geometry'])
    # This catalogue's coordinates have already been converted to Leaflet lat/lon.
    coastal=[f for f in emma if f['properties'].get('country')=='BE' and f['properties'].get('code')=='BE801']
    if len(coastal)!=1 or coastal[0]['geometry']['type']!='Polygon':
        raise ValueError('Official BE801 catalogue polygon missing')
    regions['BE']['EMMA_ID:BE801']=[coastal[0]['geometry']['coordinates']]
    if len(regions['DE'])<390 or len(regions['BE'])!=12:
        raise ValueError('Incomplete official region catalogue')
    return {'version':1,'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
            'sources':{'DE':DWD,'BE_provinces':GISCO,'BE_coastal_catalogue':EMMA},
            'attribution':'DWD; © GeoBasis-DE / BKG 2021 (Daten modifiziert); © EuroGeographics for the administrative boundaries; Eurostat/GISCO; RMI/KMI via Meteoalarm / EUMETNET (BE801 catalogue 2025-10-06). Boundaries generalised for display.',
            'regions':regions}


def main():
    catalogue=download(EMMA).decode()
    emma=json.JSONDecoder().raw_decode(catalogue.split('var data = ',1)[1])[0]
    result=build(json.loads(download(DWD)),json.loads(download(GISCO)),emma)
    output=ROOT/'data/western-warning-regions.json.gz'
    output.write_bytes(gzip.compress((json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n').encode(),mtime=0))
    print({code:len(items) for code,items in result['regions'].items()})


if __name__=='__main__':
    main()
