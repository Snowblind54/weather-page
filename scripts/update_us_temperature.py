"""NOAA/AWC measured US temperatures, collected in bulk, never per visitor."""
import csv
import datetime as dt
import io
import json
import pathlib

import update_official_temperature as core

CACHE_BASE = 'https://aviationweather.gov/data/cache/'
METADATA_CACHE = pathlib.Path(__file__).resolve().parents[1] / 'data/noaa-temperature-stations.json'
US_STATES = set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split())


def station_metadata():
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    cached = {}
    try:
        cached = json.loads(METADATA_CACHE.read_text())
    except (OSError, ValueError):
        pass
    if cached.get('version') == 1 and cached.get('stations') and 0 <= now-cached.get('generatedAt', 0) < 86400:
        return cached['stations']
    try:
        payload = core.download_json(CACHE_BASE+'stations.cache.json.gz', 50)
        if not isinstance(payload, list):
            raise ValueError('Invalid NOAA station metadata')
        stations = {str(s['icaoId']): s for s in payload
                    if s.get('country') == 'US' and s.get('state') in US_STATES and s.get('icaoId')}
        if not stations:
            raise ValueError('No US stations in NOAA metadata')
        METADATA_CACHE.parent.mkdir(parents=True, exist_ok=True)
        METADATA_CACHE.write_text(json.dumps({'version': 1, 'generatedAt': now, 'stations': stations}, separators=(',', ':'))+'\n')
        return stations
    except Exception:
        if cached.get('version') == 1 and cached.get('stations') and 0 <= now-cached.get('generatedAt', 0) < 7*86400:
            return cached['stations']
        raise


def parse_us_metars(raw, metadata, now):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else str(raw)
    lines = text.splitlines()
    # Some NOAA cache editions prepend generation notes before the CSV header.
    header = next((i for i, line in enumerate(lines) if line.startswith('raw_text,station_id,')), None)
    if header is None:
        raise ValueError('NOAA METAR cache header missing')
    grouped = {}
    for row in csv.DictReader(io.StringIO('\n'.join(lines[header:]))):
        code = row.get('station_id')
        meta = metadata.get(code)
        if not meta or meta.get('country') != 'US' or meta.get('state') not in US_STATES:
            continue
        if row.get('metar_type') not in ('METAR', 'SPECI'):
            continue
        observed = core.stamp(row.get('observation_time'))
        temp = core.num(row.get('temp_c'))
        if observed is None or temp is None or not now-3*3600 <= observed <= now+core.FUTURE_TOLERANCE_SEC:
            continue
        # Use NOAA's official station location, not missing/sentinel METAR coords.
        item = core.make_station('US', code, meta.get('site') or code,
                                 meta.get('lat'), meta.get('lon'), [(observed, temp)])
        if item:
            if code not in grouped:
                grouped[code] = item
            else:
                rows = {r[0]: r for r in grouped[code]['rows']+item['rows']}
                grouped[code]['rows'] = [rows[t] for t in sorted(rows)]
    if not grouped:
        raise ValueError('No recent NOAA US temperature observations')
    return list(grouped.values())


def parse_usa():
    metadata = station_metadata()
    raw = core.download(CACHE_BASE+'metars.cache.csv.gz', 50)
    return parse_us_metars(raw, metadata, int(dt.datetime.now(dt.timezone.utc).timestamp()))


core.SOURCES['US'] = 'NOAA / National Weather Service Aviation Weather Center (METAR/SPECI)'
core.COUNTRY_BOUNDS['US'] = (18, 72, -180, 180)
core.LOADERS['US'] = parse_usa
