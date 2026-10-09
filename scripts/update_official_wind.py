"""10-minute shared snapshots of official station wind; never substitute models.

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
LATVIA_DATASTORE = 'https://data.gov.lv/dati/api/3/action/datastore_search?'
LATVIA_OBS_RESOURCE = '17460efb-ae99-4d1d-8144-1068f184b05f'
LATVIA_STATIONS_RESOURCE = 'c32c7afd-0d05-44fd-8b24-1de85b4bf11d'
SOURCES = {
    'US': dict(name='NOAA / National Weather Service Aviation Weather Center',
               url='https://aviationweather.gov/data/metar/', timeKind='observation',
               period='Florida METAR/SPECI airport observations: 2-minute mean wind and reported instantaneous gust maximum from the preceding 10 minutes. Missing gust reports remain unavailable.'),
    'CA': dict(name='Environment and Climate Change Canada / MSC',url='https://eccc-msc.github.io/open-data/msc-data/obs_station/readme_obs_insitu_en/',timeKind='observation',period='Quality-checked 10-minute mean wind and measured instantaneous wind maximum over 10 minutes; missing maxima remain unavailable.'),
    'GL': dict(name='Danish Meteorological Institute (DMI)',url='https://www.dmi.dk/friedata/',timeKind='observation',period='10-minute mean wind and highest 3-second mean wind in the latest 10 minutes.'),
    'EE': dict(name='Estonian Environment Agency / Keskkonnaagentuur', url='https://www.ilmateenistus.ee/',
               timeKind='feed', period='Latest reported mean wind and gust; feed updates every 10 minutes.'),
    'FI': dict(name='Finnish Meteorological Institute (FMI)', url='https://en.ilmatieteenlaitos.fi/open-data',
               timeKind='observation', period='10-minute mean wind and reported 10-minute gust maximum.',
               license='CC BY 4.0'),
    'SE': dict(name='Swedish Meteorological and Hydrological Institute (SMHI)',
               url='https://www.smhi.se/data/meteorologi/vind', timeKind='observation',
               period='10-minute mean wind and reported hourly maximum gust from SMHI stations.'),
    'NO': dict(name='MET Norway', url='https://seklima.met.no/', timeKind='observation',
               period='10-minute mean wind and reported hourly maximum gust from MET Norway stations.', license='CC BY 4.0'),
    'IS': dict(name='Icelandic Meteorological Office (IMO)', url='https://api.vedur.is/weather/',
               timeKind='observation', period='10-minute automatic-station mean wind and reported gust.', license='CC BY 4.0'),
    'LV': dict(name='Latvian Environment, Geology and Meteorology Centre (LVĢMC)',
               url='https://data.gov.lv/dati/lv/dataset/hidrometeorologiskie-noverojumi', timeKind='observation',
               period='Observed mean wind, maximum gust and direction from the operational meteorological feed.',
               license='CC0 1.0'),
    'LT': dict(name='Lithuanian Hydrometeorological Service (LHMT)', url='https://api.meteo.lt/',
               timeKind='observation', period='Hourly measured wind speed, maximum hourly gust and direction.'),
    'PL': dict(name='Institute of Meteorology and Water Management (IMGW-PIB)',
               url='https://danepubliczne.imgw.pl/', timeKind='observation',
               period='Measured mean wind and reported 10-minute gust; missing gust reports remain unavailable.'),
    'DK': dict(name='Danish Meteorological Institute (DMI)', url='https://www.dmi.dk/friedata/',
               timeKind='observation', period='10-minute mean wind and highest 3-second mean wind in the latest 10 minutes.'),
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
    south,north,west,east = {'CA':(41,84,-142,-52),'GL':(59,84,-74,-10),'US':(24,31,-88,-79)}.get(country,(48.5,72.5,-26,33))
    if not (south <= lat <= north and west <= lon <= east):
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
        if not (48.5 <= lat <= 72.5 and -26 <= lon <= 33):
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


def parse_latvia(payloads, metadata):
    stations = {str(x.get('STATION_ID')): x for x in metadata if x.get('STATION_ID')}
    grouped = {}
    indexes = {'WNS10': 1, 'WPGST': 2, 'WNDD10': 3}
    for abbreviation, records in payloads.items():
        index = indexes[abbreviation]
        for item in records:
            code = str(item.get('STATION_ID', ''))
            if code not in stations or not item.get('DATETIME'):
                continue
            stamp = timestamp(item['DATETIME'])
            row = grouped.setdefault(code, {}).setdefault(stamp, [stamp, None, None, None])
            row[index] = item.get('VALUE')
    result = []
    for code, rows in grouped.items():
        meta = stations[code]
        if any(number(r[1]) is not None or number(r[2]) is not None for r in rows.values()):
            result.append(station('LV', code, meta.get('NAME') or code, meta['GEOGR2'], meta['GEOGR1'], rows.values()))
    return result


def parse_lithuania(payload):
    meta = payload.get('station') or {}
    coords = meta.get('coordinates') or {}
    rows = [(r.get('observationTimeUtc'), r.get('windSpeed'), r.get('windGust'), r.get('windDirection'))
            for r in payload.get('observations') or []
            if r.get('observationTimeUtc') and
            (number(r.get('windSpeed')) is not None or number(r.get('windGust')) is not None)]
    if not rows:
        return None
    return station('LT', meta.get('code'), meta.get('name') or meta.get('code'),
                   coords.get('latitude'), coords.get('longitude'), rows)


def parse_poland(payload):
    result = []
    for item in payload if isinstance(payload, list) else []:
        if not item.get('kod_stacji') or item.get('lat') is None or item.get('lon') is None:
            continue
        rows = {}
        for value_key, time_key, index in (
            ('wiatr_srednia_predkosc', 'wiatr_srednia_predkosc_data', 1),
            ('wiatr_poryw_10min', 'wiatr_poryw_10min_data', 2),
            ('wiatr_kierunek', 'wiatr_kierunek_data', 3),
        ):
            value, stamp = item.get(value_key), item.get(time_key)
            if value is None or not stamp:
                continue
            stamp = timestamp(stamp)
            row = rows.setdefault(stamp, [stamp, None, None, None])
            row[index] = value
        if any(number(r[1]) is not None or number(r[2]) is not None for r in rows.values()):
            result.append(station('PL', item['kod_stacji'], item.get('nazwa_stacji') or item['kod_stacji'],
                                  item['lat'], item['lon'], rows.values()))
    return result


def parse_denmark(payloads, metadata, country='DK', provider_country='DNK', now=None):
    stations = {}
    for feature in metadata.get('features') or []:
        props = feature.get('properties') or {}
        coords = (feature.get('geometry') or {}).get('coordinates') or []
        if props.get('owner') == 'DMI' and props.get('country') == provider_country and len(coords) >= 2:
            if now is not None:
                end = props.get('validTo'); start = props.get('validFrom')
                if (end and timestamp(end)<=int(now.timestamp())) or (start and timestamp(start)>int(now.timestamp())):continue
            stations[str(props.get('stationId'))] = (props.get('name') or props.get('stationId'), coords[1], coords[0])
    grouped = {}
    indexes = {'wind_speed': 1, 'wind_max': 2, 'wind_dir': 3}
    for parameter, payload in payloads.items():
        index = indexes[parameter]
        for feature in payload.get('features') or []:
            props = feature.get('properties') or {}
            code = str(props.get('stationId', ''))
            if code not in stations or props.get('parameterId') != parameter or not props.get('observed'):
                continue
            stamp = timestamp(props['observed'])
            row = grouped.setdefault(code, {}).setdefault(stamp, [stamp, None, None, None])
            row[index] = props.get('value')
    result = []
    for code, rows in grouped.items():
        name, lat, lon = stations[code]
        if any(number(r[1]) is not None or number(r[2]) is not None for r in rows.values()):
            result.append(station(country, code, name, lat, lon, rows.values()))
    return result


def load_estonia(now):
    return parse_estonia(download('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php'))


def load_finland(now):
    end = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    params = dict(service='WFS', version='2.0.0', request='getFeature',
                  storedquery_id='fmi::observations::weather::multipointcoverage', bbox='19,59,32,71.7',
                  starttime=(end - dt.timedelta(hours=3)).isoformat(), endtime=end.isoformat(), timestep=10,
                  parameters='ws_10min,wg_10min,wd_10min')
    return parse_finland(download('https://opendata.fmi.fi/wfs?' + urllib.parse.urlencode(params)))


def load_sweden(now):
    base = 'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/'
    speed = download_json(base + '4/station-set/all/period/latest-hour/data.json')
    gust = download_json(base + '21/station-set/all/period/latest-hour/data.json')
    return parse_sweden(speed, gust)


def load_norway(now):
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


def load_latvia(now):
    metadata = download_json(LATVIA_DATASTORE + urllib.parse.urlencode({
        'resource_id': LATVIA_STATIONS_RESOURCE, 'limit': 1000
    }))['result']['records']
    payloads = {}
    for abbreviation in ('WNS10', 'WPGST', 'WNDD10'):
        params = {'resource_id': LATVIA_OBS_RESOURCE, 'limit': 5000, 'sort': 'DATETIME desc',
                  'filters': json.dumps({'ABBREVIATION': abbreviation})}
        payloads[abbreviation] = download_json(LATVIA_DATASTORE + urllib.parse.urlencode(params))['result']['records']
    return parse_latvia(payloads, metadata)


def load_lithuania(now):
    stations = download_json('https://api.meteo.lt/v1/stations')

    def collect(meta):
        try:
            url = 'https://api.meteo.lt/v1/stations/' + urllib.parse.quote(meta['code']) + '/observations/latest'
            return parse_lithuania(download_json(url))
        except Exception as error:
            print('LT station unavailable:', meta.get('code'), str(error)[:120], flush=True)
            return None

    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        return [item for item in pool.map(collect, stations) if item is not None]


def load_poland(now):
    return parse_poland(download_json('https://danepubliczne.imgw.pl/api/data/meteo'))


def load_denmark(now):
    base = 'https://opendataapi.dmi.dk/v2/metObs/collections/'
    metadata = download_json(base + 'station/items?' + urllib.parse.urlencode({
        'status': 'Active', 'bbox': '7,54,16,58', 'limit': 1000
    }))

    def observation(parameter):
        params = {'parameterId': parameter, 'period': 'latest-hour', 'bbox': '7,54,16,58', 'limit': 1000}
        return download_json(base + 'observation/items?' + urllib.parse.urlencode(params))

    parameters = ('wind_speed', 'wind_max', 'wind_dir')
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        values = list(pool.map(observation, parameters))
    return parse_denmark(dict(zip(parameters, values)), metadata)


def parse_florida(observations, metadata):
    """Use official state metadata, not a bounding box alone, to select Florida."""
    if not isinstance(observations, list) or not isinstance(metadata, list):
        raise ValueError('Invalid NOAA station response')
    if len(observations) >= 400 or len(metadata) >= 400:
        raise ValueError('NOAA response may be truncated')
    official = {m['icaoId']: m for m in metadata
                if m.get('country') == 'US' and m.get('state') == 'FL' and m.get('icaoId')}
    grouped = {}
    for item in observations:
        code = item.get('icaoId')
        meta = official.get(code)
        if not meta or item.get('metarType') not in ('METAR', 'SPECI'):
            continue
        try:
            stamp = timestamp(item.get('obsTime'))
            # NOAA's decoded METAR speed and gust fields are in knots.
            def speed(key):
                value = number(item.get(key), 200)
                return None if value is None else value * 1852 / 3600
            row = (stamp, speed('wspd'), speed('wgst'), number(item.get('wdir'), 360))
            target = station('US', code, meta.get('site') or code,
                             meta['lat'], meta['lon'], [row])
        except (KeyError, ValueError, TypeError):
            continue
        if not target['rows']:
            continue
        if code in grouped:
            grouped[code]['rows'] += target['rows']
        else:
            grouped[code] = target
    return [station(s['country'], s['code'], s['name'], s['lat'], s['lon'], s['rows'])
            for s in grouped.values()]


def load_florida(now):
    base = 'https://aviationweather.gov/api/data/'
    params = urllib.parse.urlencode({'bbox': '24,-88,31,-79', 'format': 'json'})
    # Two small bulk requests per shared update, never one request per visitor/station.
    metadata = download_json(base + 'stationinfo?' + params)
    observations = download_json(base + 'metar?' + params)
    return parse_florida(observations, metadata)


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
    from official_wind_americas import load_canada, load_greenland
    now = dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads(OUTPUT.read_text())
    except (OSError, ValueError):
        previous = {}
    old = previous.get('stations', [])
    results, sources = [], {}
    loaders = [('EE', load_estonia), ('FI', load_finland), ('SE', load_sweden), ('NO', load_norway),
               ('IS', load_iceland), ('LV', load_latvia), ('LT', load_lithuania), ('PL', load_poland),
               ('DK', load_denmark), ('CA', load_canada), ('GL', load_greenland), ('US', load_florida)]
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
    snapshot = dict(version=1, generatedAt=int(now.timestamp()), refreshMinutes=10, units='m/s',
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
