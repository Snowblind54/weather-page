"""Météo-France's official six-minute national observation package.

Contract: official observation-network documentation, revised 2026-06-30.
Only validity_time dates the measurement. t is Kelvin; ff and raf10 are m/s.
The API key is used only in a server-side header and is never logged or saved.
"""
import csv
import datetime as dt
import io
import json
import math
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://public-api.meteofrance.fr/public/DPPaquetObs/'
STATIONS_URL = 'https://www.data.gouv.fr/api/1/datasets/r/4250e317-1176-425d-880c-ebe9205efc89'
SOURCE = 'Météo-France / official national six-minute observations (provisional)'
SOURCE_URL = 'https://portail-api.meteofrance.fr/web/fr/api/DonneesPubliquesPaquetObservation'
CACHE = Path(__file__).resolve().parents[1] / 'data/meteofrance-stations.csv'
MAX_AGE = 95*60
NETWORK = 'meteofrance-6m'


def number(value, low, high):
    if isinstance(value, bool) or value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and low <= value <= high else None


def read_metadata(raw):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else raw
    reader = csv.DictReader(io.StringIO(text), delimiter=';')
    if not {'Id_station','Nom_usuel','Latitude','Longitude'} <= set(reader.fieldnames or []):
        raise ValueError('Météo-France station metadata schema changed')
    return {r['Id_station']: r['Nom_usuel'] for r in reader if re.fullmatch(r'\d{8}',r['Id_station'])}


def parse(payload, now, metadata=None):
    features = payload.get('features') if isinstance(payload, dict) and payload.get('type') == 'FeatureCollection' else payload
    if not isinstance(features, list) or len(features) > 10000:
        raise ValueError('Invalid Météo-France observation package')
    end = int(now.timestamp()); grouped = {}
    for feature in features:
        if not isinstance(feature, dict) or feature.get('type') != 'Feature':
            continue
        geometry = feature.get('geometry') or {}; p = feature.get('properties') or {}
        coords = geometry.get('coordinates') or []; code = p.get('geo_id_insee')
        if geometry.get('type') != 'Point' or len(coords) != 2 or not isinstance(code,str) or not re.fullmatch(r'\d{8}',code):
            continue
        # Mainland France and Corsica only; overseas and foreign networks are
        # excluded by official department identifier as well as coordinates.
        if not (code[:2] in ('20','2A','2B') or 1 <= int(code[:2]) <= 95):
            continue
        lon,lat = number(coords[0],-5.5,10),number(coords[1],41,51.5)
        if lat is None or lon is None:
            continue
        validity = p.get('validity_time')
        if not isinstance(validity,str) or not validity.endswith(('Z','+00:00')):
            continue
        try:
            stamp = int(dt.datetime.fromisoformat(validity.replace('Z','+00:00')).timestamp())
        except ValueError:
            continue
        if not end-MAX_AGE <= stamp <= end+60:
            continue
        kelvin = number(p.get('t'),183.15,328.15)
        temperature = round(kelvin-273.15,2) if kelvin is not None else None
        speed = number(p.get('ff'),0,100)
        # raf10 is the current 2026 field. fxi10 was its earlier API name.
        # Never substitute fx (maximum mean wind) or hourly/daily maxima.
        gust = number(p.get('raf10') if 'raf10' in p else p.get('fxi10'),0,100)
        direction = number(p.get('dd'),0,360)
        if temperature is None and speed is None and gust is None:
            continue
        item = grouped.setdefault(code,dict(code=code,name=(metadata or {}).get(code) or 'Météo-France '+code,lat=lat,lon=lon,rows={}))
        item['rows'][stamp] = [stamp,temperature,speed,gust,direction]
    result = [{**s,'rows':[s['rows'][t] for t in sorted(s['rows'])]} for s in grouped.values()]
    if not result:
        raise ValueError('No recent usable Météo-France national observations')
    return result


def request_json(url, key):
    req = urllib.request.Request(url,headers={'apikey':key,'Accept':'application/geo+json, application/json','User-Agent':'NorthernWeather (github.com/Snowblind54/weather-page)'})
    try:
        with urllib.request.urlopen(req,timeout=35) as response:
            raw = response.read(12*1024*1024+1)
    except urllib.error.HTTPError as error:
        # Discard response bodies/headers so credentials cannot leak into logs.
        raise ValueError('Météo-France national API HTTP '+str(error.code)) from None
    except (OSError,TimeoutError):
        raise ValueError('Météo-France national API connection unavailable') from None
    if len(raw)>12*1024*1024:
        raise ValueError('Météo-France national response too large')
    try:
        return json.loads(raw)
    except (ValueError,UnicodeError):
        raise ValueError('Météo-France national API did not return JSON') from None


def load(now, download, fetch=request_json):
    key = os.environ.get('METEOFRANCE_API_KEY','').strip()
    if not key:
        raise ValueError('METEOFRANCE_API_KEY is not configured; national API activation is pending')
    if any(ord(c)<33 or ord(c)>126 for c in key):
        raise ValueError('METEOFRANCE_API_KEY contains invalid header characters')
    # Allow the provider's documented delivery latency (up to nine minutes).
    stamp = int(now.timestamp()-12*60)//360*360
    date = dt.datetime.fromtimestamp(stamp,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    url = BASE+'paquet/stations/infrahoraire-6m?'+urllib.parse.urlencode({'date':date,'format':'geojson'})
    payload = fetch(url,key)
    names = {}
    try:
        if CACHE.exists() and now.timestamp()-CACHE.stat().st_mtime < 24*3600:
            raw = CACHE.read_bytes()
        else:
            raw = download(STATIONS_URL); read_metadata(raw)
            CACHE.parent.mkdir(parents=True,exist_ok=True)
            CACHE.write_bytes(raw)
        names = read_metadata(raw)
    except (OSError,ValueError):
        # The authenticated GeoJSON still identifies and geolocates official
        # stations if the optional human-readable name catalogue is unavailable.
        print('Météo-France station names unavailable; using official station identifiers',flush=True)
    return parse(payload,now,names)


def load_temperature(now,download):
    import update_official_temperature as core
    results = []
    for s in load(now,download):
        item = core.make_station('FR','MF-'+s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[1]) for r in s['rows']])
        if item:
            item.update(source=SOURCE,observationNetwork=NETWORK); results.append(item)
    if not results:
        raise ValueError('No current Météo-France national temperatures')
    return results


def load_wind(now,download):
    import update_official_wind as core
    results = []
    for s in load(now,download):
        item = core.station('FR','MF-'+s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[2],r[3],r[4]) for r in s['rows']])
        if item['rows']:
            item.update(sourceName=SOURCE,sourceUrl=SOURCE_URL,observationNetwork=NETWORK,
                        gustLabel='Gust max · 10 min',
                        period='Official mean wind at 10 m and maximum gust over the preceding 10 minutes (raf10). Six-minute observations; actual UTC measurement time; provisional. Missing gusts remain unavailable.')
            results.append(item)
    if not results:
        raise ValueError('No current Météo-France national wind observations')
    return results
