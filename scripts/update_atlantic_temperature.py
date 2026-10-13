"""Measured Faroe, UK and Irish temperatures for the shared snapshot."""
import csv
import datetime as dt
import io
import urllib.parse

import update_official_temperature as core
from update_north_america_temperature import features, DMI, recent_interval

IRELAND = 'https://opendata2.met.ie/edr/collections/observations-swob-nrt-60min/'
NOAA = 'https://aviationweather.gov/data/cache/'


def parse_faroes():
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    metadata = {}
    for feature in features(DMI+'station/items', {'bbox':'-8,61,-6,63','limit':1000}):
        p = feature.get('properties') or {}
        start, end = core.stamp(p.get('validFrom')), core.stamp(p.get('validTo'))
        if (p.get('country') != 'FRO' or p.get('status') != 'Active'
                or (start is not None and start > now) or (end is not None and end <= now)):
            continue
        code = str(p.get('stationId') or '')
        if code and (code not in metadata or (core.stamp(metadata[code].get('validFrom')) or 0) < (start or 0)):
            metadata[code] = p
    grouped = {}
    for feature in features(DMI+'observation/items', {'bbox':'-8,61,-6,63',
            'parameterId':'temp_dry','datetime':recent_interval(),'limit':10000}):
        p = feature.get('properties') or {}
        code = str(p.get('stationId') or '')
        coords = (feature.get('geometry') or {}).get('coordinates') or []
        if code in metadata and p.get('parameterId') == 'temp_dry' and len(coords) >= 2:
            grouped.setdefault(code, [coords, []])[1].append((p.get('observed'), p.get('value')))
    out = [core.make_station('FO', code, metadata[code].get('name'), coords[1], coords[0], rows)
           for code, (coords, rows) in grouped.items()]
    return require_stations(out, 'DMI Faroe Islands')


def parse_british_metars(raw, metadata, now):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else str(raw)
    lines = text.splitlines()
    header = next((i for i, line in enumerate(lines) if line.startswith('raw_text,station_id,')), None)
    if header is None:
        raise ValueError('NOAA METAR cache header missing')
    grouped = {}
    for row in csv.DictReader(io.StringIO('\n'.join(lines[header:]))):
        code = row.get('station_id')
        meta = metadata.get(code) or {}
        observed = core.stamp(row.get('observation_time'))
        if (meta.get('country') != 'GB' or row.get('metar_type') not in ('METAR', 'SPECI')
                or observed is None or not now-3*3600 <= observed <= now+core.FUTURE_TOLERANCE_SEC):
            continue
        grouped.setdefault(code, []).append((observed, row.get('temp_c')))
    out = [core.make_station('GB', code, metadata[code].get('site'), metadata[code].get('lat'),
                            metadata[code].get('lon'), rows) for code, rows in grouped.items()]
    return require_stations(out, 'UK METAR')


def parse_britain():
    metadata = core.download_json(NOAA+'stations.cache.json.gz', 50)
    if not isinstance(metadata, list):
        raise ValueError('Invalid NOAA station metadata')
    stations = {s['icaoId']: s for s in metadata if s.get('icaoId') and s.get('country') == 'GB'}
    raw = core.download(NOAA+'metars.cache.csv.gz', 50)
    return parse_british_metars(raw, stations, int(dt.datetime.now(dt.timezone.utc).timestamp()))


def parse_irish_features(observations, metadata):
    grouped = {}
    for f in observations:
        p = f.get('properties') or {}
        code = str(p.get('station_id') or '')
        if code in metadata and p.get('parameter_name') == 'air_temperature':
            grouped.setdefault(code, []).append((p.get('observed_at'), p.get('value_num')))
    out = []
    for code, rows in grouped.items():
        f = metadata[code]
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if len(coords) >= 2:
            out.append(core.make_station('IE', code, f['properties'].get('station_name'), coords[1], coords[0], rows))
    return require_stations(out, 'Met Éireann')


def parse_ireland():
    locations = core.download_json(IRELAND+'locations?f=json', 40)
    metadata = {str(f['properties']['station_id']): f for f in locations.get('features', [])
                if (f.get('properties') or {}).get('station_id') is not None}
    params = {'datetime':recent_interval(), 'parameter-name':'air_temperature', 'f':'geojson', 'limit':10000}
    observations = []
    for page in range(4):
        payload = core.download_json(IRELAND+'items?'+urllib.parse.urlencode(params | {'offset':page*10000}), 40)
        batch = payload.get('features') or []
        observations.extend(batch)
        if len(batch) < 10000:
            return parse_irish_features(observations, metadata)
    raise ValueError('Irish temperature pagination exceeded recent window')


def require_stations(rows, source):
    rows = [s for s in rows if s]
    if not rows:
        raise ValueError('No recent '+source+' temperature observations')
    return rows


core.SOURCES.update({'FO':'Danish Meteorological Institute (DMI)',
    'GB':'Official UK airport METAR/SPECI observations via NOAA Aviation Weather Center',
    'IE':'Met Éireann – Irish Meteorological Service'})
core.COUNTRY_BOUNDS.update({'FO':(61,63,-8,-6), 'GB':(49,61,-9,3), 'IE':(51,56,-11,-5)})
core.LOADERS.update({'FO':parse_faroes, 'GB':parse_britain, 'IE':parse_ireland})
