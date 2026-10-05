"""Hourly shared snapshots of official Nordic station wind; never substitute models.

EE exposes a feed timestamp, not per-station observation timestamps. Keep that
meaning explicit. Other providers supply actual observation times. Native values
and gaps remain intact; readings are not interpolated or treated as equivalent
across providers beyond the provider's published wind/gust definitions.
"""
import concurrent.futures as futures
import datetime as dt
import gzip
import json
import math
import pathlib
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/official-wind.json'
NORWAY_GUST_ELEMENT = 'max(wind_speed_of_gust PT1H)'
ICELAND_LATEST_URL = 'https://api.vedur.is/weather/observations/aws/10min/latest?parameters=basic'
SOURCES = {
    'EE': dict(name='Estonian Environment Agency / Keskkonnaagentuur', url='https://www.ilmateenistus.ee/',
               timeKind='feed', period='Latest reported mean wind and gust; feed updates every 10 minutes.'),
    'FI': dict(name='Finnish Meteorological Institute (FMI)', url='https://en.ilmatieteenlaitos.fi/open-data',
               timeKind='observation', period='10-minute mean wind and reported 10-minute gust maximum, sampled hourly.',
               license='CC BY 4.0'),
    'SE': dict(name='Swedish Meteorological and Hydrological Institute (SMHI)',
               url='https://www.smhi.se/data/meteorologi/vind', timeKind='observation',
               period='10-minute mean wind and reported hourly maximum gust from SMHI stations.'),
    'NO': dict(name='MET Norway', url='https://seklima.met.no/', timeKind='observation',
               period='10-minute mean wind and reported hourly maximum gust from MET Norway stations.', license='CC BY 4.0'),
    'IS': dict(name='Icelandic Meteorological Office (IMO)', url='https://api.vedur.is/weather/',
               timeKind='observation', period='10-minute automatic-station mean wind and reported gust.', license='CC BY 4.0'),
}


def number(value, maximum=100):
    if value is None or isinstance(value, bool) or str(value).strip() == '':
        return None
    try:
        n = float(value)
    except (ValueError, TypeError):
        return None
    return round(n, 2) if math.isfinite(n) and 0 <= n <= maximum else None


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = float(value)
        return int(value / 1000 if value > 1e11 else value)
    text = str(value).strip()
    if not text:
        raise ValueError('Missing observation timestamp')
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def local(el):
    return el.tag.split('}')[-1]


def download(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'NorthernWeather/8.58 (github.com/Snowblind54/weather-page)',
        'Accept-Encoding': 'gzip',
    })
    with urllib.request.urlopen(req, timeout=35) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('Wind response too large')
    return gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw


def download_json(url):
    return json.loads(download(url))


def station(country, code, name, lat, lon, rows):
    lat, lon = float(lat), float(lon)
    if not (53 <= lat <= 72.5 and -26 <= lon <= 33):
        raise ValueError('Station outside Northern Weather bounds')
    readings = {}
    for stamp, speed, gust, direction in rows:
        stamp = timestamp(stamp)
        speed, gust, direction = number(speed), number(gust), number(direction, 360)
        if speed is None and gust is None:
            continue
        readings[stamp] = [stamp, speed, gust, direction]
    return dict(country=country, code=str(code), name=str(name), lat=round(lat, 6), lon=round(lon, 6),
                rows=[readings[t] for t in sorted(readings)])


def parse_estonia(raw):
    root = ET.fromstring(raw)
    stamp = int(root.attrib['timestamp'])
    result = []
    for el in root.findall('station'):
        speed, gust = number(el.findtext('windspeed')), number(el.findtext('windspeedmax'))
        if speed is None and gust is None:
            continue
        name = el.findtext('name') or 'Estonian station'
        result.append(station('EE', el.findtext('wmocode') or name, name, el.findtext('latitude'),
                              el.findtext('longitude'), [(stamp, speed, gust, el.findtext('winddirection'))]))
    return result


def parse_finland(raw):
    root = ET.fromstring(raw)
    errors = [e.text or '' for e in root.iter() if local(e) == 'ExceptionText']
    if errors:
        raise ValueError('FMI: ' + ' '.join(errors))
    points = {}
    for point in root.iter():
        if local(point) != 'Point':
            continue
        ident = next((v for k, v in point.attrib.items() if k.split('}')[-1] == 'id'), '')
        pos = next((e.text or '' for e in point.iter() if local(e) == 'pos'), '').split()
        if ident and len(pos) == 2:
            points[ident] = pos
    metadata = {}
    for el in root.iter():
        if local(el) != 'Location':
            continue
        ident = next((e.text for e in el.iter() if local(e) == 'identifier' and
                      'fmisid' in e.attrib.get('codeSpace', '')), '')
        name = next((e.text for e in el.iter() if local(e) == 'name' and
                     e.attrib.get('codeSpace', '').endswith('/name')), 'FMI station')
        href = next((v for e in el.iter() if local(e) == 'representativePoint'
                     for k, v in e.attrib.items() if k.split('}')[-1] == 'href'), '')
        pos = points.get(href.lstrip('#'))
        if pos:
            metadata[(round(float(pos[0]), 5), round(float(pos[1]), 5))] = (ident, name)
    grouped = {}
    for coverage in root.iter():
        if local(coverage) != 'MultiPointCoverage':
            continue
        fields = [e.attrib.get('name', '').lower() for e in coverage.iter() if local(e) == 'field']
        needed = ['ws_10min', 'wg_10min', 'wd_10min']
        if len(set(fields)) != len(fields) or not all(p in fields for p in needed):
            raise ValueError('FMI wind fields missing/duplicated')
        coords = next((e.text or '' for e in coverage.iter() if local(e) == 'positions'), '').split()
        values = next((e.text or '' for e in coverage.iter() if local(e) == 'doubleOrNilReasonTupleList'), '').split()
        if not fields or len(coords) % 3 or len(values) != len(coords) // 3 * len(fields):
            raise ValueError('FMI wind coordinates and values do not match')
        indices = [fields.index(p) for p in needed]
        for i in range(len(coords) // 3):
            lat, lon, stamp = map(float, coords[i * 3:i * 3 + 3])
            key = (round(lat, 5), round(lon, 5))
            if key not in metadata:
                continue
            code, name = metadata[key]
            speed, gust, direction = [values[i * len(fields) + j] for j in indices]
            grouped.setdefault(key, [code, name, lat, lon, []])[4].append((stamp, speed, gust, direction))
    return [station('FI', *record) for record in grouped.values()]


def parse_sweden(speed_payload, gust_payload):
    payloads = ((speed_payload, '4', 1), (gust_payload, '21', 2))
    merged = {}
    for payload, expected_key, value_index in payloads:
        parameter = payload.get('parameter') or {}
        if str(parameter.get('key')) != expected_key:
            raise ValueError('SMHI wind parameter changed')
        for item in payload.get('station') or []:
            if item.get('owner') and str(item['owner']).upper() != 'SMHI':
                continue
            code = str(item.get('key', ''))
            if not code:
                continue
            target = merged.setdefault(code, {
                'name': item.get('name') or 'SMHI station', 'lat': item.get('latitude'),
                'lon': item.get('longitude'), 'rows': {}
            })
            for value in item.get('value') or []:
                if value.get('quality') not in ('G', 'Y'):
                    continue
                stamp = timestamp(value.get('date'))
                row = target['rows'].setdefault(stamp, [stamp, None, None, None])
                row[value_index] = value.get('value')
    result = []
    for code, item in merged.items():
        result.append(station('SE', code, item['name'], item['lat'], item['lon'], item['rows'].values()))
    return result


def parse_norway(payload, metadata):
    stations = {s['id']: s for s in metadata if 'MET.NO' in s.get('stationHolders', [])}
    grouped = {}
    for row in payload.get('data') or []:
        source = str(row.get('sourceId', '')).split(':')
        code = source[0]
        if code not in stations or (len(source) > 1 and source[1] != '0'):
            continue
        values = {}
        for observation in row.get('observations') or []:
            if observation.get('qualityCode') not in (0, 2, 4) or observation.get('timeSeriesId', 0) != 0:
                continue
            element = observation.get('elementId')
            if element in ('wind_speed', NORWAY_GUST_ELEMENT) and observation.get('unit') == 'm/s':
                values.setdefault(element, observation.get('value'))
            elif element == 'wind_from_direction':
                values.setdefault(element, observation.get('value'))
        if number(values.get('wind_speed')) is None and number(values.get(NORWAY_GUST_ELEMENT)) is None:
            continue
        grouped.setdefault(code, []).append((row['referenceTime'], values.get('wind_speed'),
                                             values.get(NORWAY_GUST_ELEMENT), values.get('wind_from_direction')))
    result = []
    for code, rows in grouped.items():
        meta = stations[code]
        coords = meta.get('geometry', {}).get('coordinates') or []
        if len(coords) < 2:
            continue
        lon, lat = coords[:2]
        if not (53 <= lat <= 72.5 and -26 <= lon <= 33):
            continue
        result.append(station('NO', code, meta.get('shortName') or meta.get('name') or code, lat, lon, rows))
    return result


def parse_iceland(payload, metadata):
    stations = {str(s.get('station')): s for s in metadata if s.get('station') is not None}
    result = []
    for row in payload if isinstance(payload, list) else payload.get('data', []):
        code = str(row.get('station', ''))
        meta = stations.get(code)
        if not meta:
            continue
        speed, gust = row.get('f'), row.get('fg')
        if number(speed) is None and number(gust) is None:
            continue
        result.append(station('IS', code, row.get('name') or meta.get('name') or 'IMO station',
                              meta['lat'], meta['lon'], [(row['time'], speed, gust, None)]))
    return result


def load_estonia(now):
    return parse_estonia(download('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php'))


def load_finland(now):
    end = now.replace(minute=0, second=0, microsecond=0)
    params = dict(service='WFS', version='2.0.0', request='getFeature',
                  storedquery_id='fmi::observations::weather::multipointcoverage', bbox='19,59,32,71.7',
                  starttime=(end - dt.timedelta(hours=3)).isoformat(), endtime=end.isoformat(), timestep=60,
                  parameters='ws_10min,wg_10min,wd_10min')
    return parse_finland(download('https://opendata.fmi.fi/wfs?' + urllib.parse.urlencode(params)))


def load_sweden(now):
    base = 'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/'
    speed = download_json(base + '4/station-set/all/period/latest-hour/data.json')
    gust = download_json(base + '21/station-set/all/period/latest-hour/data.json')
    return parse_sweden(speed, gust)


def load_norway(now):
    # Public backend used by MET Norway's Seklima site; no borrowed API credentials.
    base = 'https://rim.k8s.met.no/api/v1/'
    start = (now - dt.timedelta(days=2)).date().isoformat()
    end = (now + dt.timedelta(days=1)).date().isoformat()
    metadata = {}
    for element in ('wind_speed', NORWAY_GUST_ELEMENT):
        params = dict(sourceName='', weatherElements=element, timeResolution='hours',
                      **{'from': start, 'to': end}, includeRegions='false')
        for item in (download_json(base + 'stations?' + urllib.parse.urlencode(params)).get('data') or []):
            metadata[item['id']] = item
    official = [s for s in metadata.values() if 'MET.NO' in s.get('stationHolders', []) and
                len(s.get('geometry', {}).get('coordinates') or []) >= 2]

    def collect(batch):
        params = dict(sources=','.join(s['id'] for s in batch), referenceTime=start + '/' + end,
                      elements='wind_speed,' + NORWAY_GUST_ELEMENT + ',wind_from_direction', timeResolution='hours')
        try:
            return parse_norway(download_json(base + 'observations?' + urllib.parse.urlencode(params)), official)
        except Exception as error:
            print('NO wind batch unavailable:', str(error)[:200], flush=True)
            return []

    batches = [official[i:i + 40] for i in range(0, len(official), 40)]
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        return [s for records in pool.map(collect, batches) for s in records]


def load_iceland(now):
    metadata = download_json('https://api.vedur.is/weather/stations?active=true&station_type=sj')
    observations = download_json(ICELAND_LATEST_URL)
    return parse_iceland(observations, metadata)


def merge(previous, current, now):
    cutoff = int(now.timestamp()) - 24 * 3600
    limit = int(now.timestamp()) + 60
    stations = {}
    for item in previous + current:
        key = (item['country'], item['code'])
        old = stations.get(key, {}).get('rows', [])
        rows = {r[0]: r for r in old + item['rows'] if cutoff <= r[0] <= limit}
        if rows:
            stations[key] = {**item, 'rows': [rows[t] for t in sorted(rows)]}
    return sorted(stations.values(), key=lambda s: (s['country'], s['code']))


def main():
    now = dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads(OUTPUT.read_text())
    except (OSError, ValueError):
        previous = {}
    old = previous.get('stations', [])
    results, sources = [], {}
    loaders = [('EE', load_estonia), ('FI', load_finland), ('SE', load_sweden),
               ('NO', load_norway), ('IS', load_iceland)]
    with futures.ThreadPoolExecutor(max_workers=len(loaders)) as pool:
        pending = {pool.submit(loader, now): country for country, loader in loaders}
        for task in futures.as_completed(pending):
            country = pending[task]
            try:
                rows = task.result()
                if not any(s['rows'] and s['rows'][-1][0] >= int(now.timestamp()) - 3 * 3600 for s in rows):
                    raise ValueError('No current measured wind observations')
                results += rows
                sources[country] = {**SOURCES[country], 'status': 'ok', 'fetchedAt': int(now.timestamp())}
                print(country, len([s for s in rows if s['rows']]), 'official wind stations', flush=True)
            except Exception as error:
                print(country, 'unavailable:', str(error)[:250], flush=True)
                sources[country] = {**SOURCES[country], 'status': 'unavailable', 'error': str(error)[:200],
                                    'fetchedAt': previous.get('sources', {}).get(country, {}).get('fetchedAt')}
    stations = merge(old, results, now)
    if not results:
        raise ValueError('All official wind feeds unavailable; retaining previous snapshot')
    snapshot = dict(version=1, generatedAt=int(now.timestamp()), refreshMinutes=60, units='m/s',
                    sources=sources, stations=stations)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=OUTPUT.parent, delete=False) as f:
        json.dump(snapshot, f, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        f.write('\n')
        name = f.name
    pathlib.Path(name).replace(OUTPUT)
    print('Published', len(stations), 'stations;', OUTPUT.stat().st_size, 'bytes', flush=True)


if __name__ == '__main__':
    main()
