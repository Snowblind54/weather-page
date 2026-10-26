"""Official ten-minute GeoSphere Austria and MeteoSwiss station measurements.

One national observation request per refresh (plus station metadata), never per
visitor. Preserve UTC times and missing channels; do not use tower wind sensors.
"""
import csv
import datetime as dt
import io
import json
import math
import urllib.parse

AUSTRIA = 'https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min'
SWISS = 'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv'
SWISS_META = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv'
BOUNDS = {'AT': (46.3, 49.1, 9.4, 17.2), 'CH': (45.7, 47.9, 5.9, 10.6)}
SOURCES = {'AT': 'GeoSphere Austria / TAWES ten-minute observations (provisional)',
           'CH': 'Source: MeteoSwiss / SwissMetNet ten-minute observations (provisional)'}
URLS = {'AT': 'https://data.hub.geosphere.at/',
        'CH': 'https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations'}
PERIODS = {'AT': 'Ten-minute mean wind and maximum gust over the same ten-minute period, in m/s. Native UTC observation time; provisional. Source: GeoSphere Austria.',
           'CH': 'Ten-minute mean wind and maximum one-second gust over the same ten-minute period; km/h converted to m/s. Native UTC observation time; provisional. Source: MeteoSwiss.'}


def value(raw, low, high):
    if raw is None or isinstance(raw, bool):
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and low <= v <= high else None


def text(raw):
    if isinstance(raw, str):
        return raw
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('latin1')


def valid_location(country, lat, lon):
    s, n, w, e = BOUNDS[country]
    return value(lat, s, n) is not None and value(lon, w, e) is not None


def timestamp(raw, now, fmt=None):
    try:
        t = dt.datetime.strptime(raw, fmt).replace(tzinfo=dt.timezone.utc) if fmt else dt.datetime.fromisoformat(raw)
        if t.tzinfo is None:
            return None
        stamp = int(t.timestamp())
        return stamp if int(now.timestamp())-95*60 <= stamp <= int(now.timestamp())+60 else None
    except (TypeError, ValueError):
        return None


def parse_austria(payload, metadata, now):
    times = [timestamp(t, now) for t in payload.get('timestamps', [])]
    stations = {str(s['id']): s for s in metadata.get('stations', []) if s.get('is_active') is True}
    out = []
    expected = {'TL': '°C', 'FF': 'm/s', 'FFX': 'm/s', 'DD': '°'}
    for feature in payload.get('features', []):
        p = feature.get('properties') or {}
        code = str(p.get('station', ''))
        meta = stations.get(code)
        if not meta or not valid_location('AT', meta.get('lat'), meta.get('lon')):
            continue
        parameters = p.get('parameters') or {}
        for key, unit in expected.items():
            if key not in parameters or parameters[key].get('unit') != unit or len(parameters[key].get('data', [])) != len(times):
                raise ValueError('GeoSphere parameter units or time axis changed: '+key)
        rows = []
        for i, stamp in enumerate(times):
            if stamp is None:
                continue
            temp, speed, gust, direction = [value(parameters[k]['data'][i], *limits) for k, limits in
                [('TL', (-90, 55)), ('FF', (0, 150)), ('FFX', (0, 150)), ('DD', (0, 360))]]
            if temp is not None or speed is not None or gust is not None:
                rows.append([stamp, temp, speed, gust, None if direction is None else direction % 360])
        if rows:
            out.append(dict(code=code, name=meta['name'], lat=float(meta['lat']), lon=float(meta['lon']), rows=rows))
    return out


def parse_switzerland(raw, metadata, now):
    catalogue = {}
    for m in csv.DictReader(io.StringIO(text(metadata)), delimiter=';'):
        # Vaduz is a SwissMetNet station in Liechtenstein, not Switzerland.
        if m.get('station_canton') == 'FL':
            continue
        lat, lon = m.get('station_coordinates_wgs84_lat'), m.get('station_coordinates_wgs84_lon')
        if valid_location('CH', lat, lon):
            catalogue[m['station_abbr']] = dict(name=m['station_name'], lat=float(lat), lon=float(lon))
    reader = csv.DictReader(io.StringIO(text(raw)), delimiter=';')
    if not {'Station/Location', 'Date', 'tre200s0', 'fu3010z0', 'fu3010z1', 'dkl010z0'} <= set(reader.fieldnames or []):
        raise ValueError('SwissMetNet snapshot columns changed')
    grouped = {}
    for r in reader:
        code = r['Station/Location']
        if code not in catalogue:
            continue
        stamp = timestamp(r['Date'], now, '%Y%m%d%H%M')
        if stamp is None:
            continue
        temp = value(r['tre200s0'], -90, 55)
        speed, gust = [value(r[k], 0, 540) for k in ('fu3010z0', 'fu3010z1')]
        direction = value(r['dkl010z0'], 0, 360)
        if temp is not None or speed is not None or gust is not None:
            grouped.setdefault(code, {})[stamp] = [stamp, temp, None if speed is None else speed/3.6,
                None if gust is None else gust/3.6, None if direction is None else direction % 360]
    return [dict(code=code, **catalogue[code], rows=[rows[t] for t in sorted(rows)]) for code, rows in grouped.items()]


def load(country, now, download):
    if country == 'AT':
        metadata = json.loads(download(AUSTRIA+'/metadata'))
        ids = [str(s['id']) for s in metadata['stations'] if s.get('is_active') is True and valid_location('AT', s.get('lat'), s.get('lon'))]
        if not ids or len(ids) > 600:
            raise ValueError('Unexpected GeoSphere station catalogue')
        query = urllib.parse.urlencode({'parameters': 'TL,FF,FFX,DD', 'station_ids': ','.join(ids)})
        rows = parse_austria(json.loads(download(AUSTRIA+'?'+query)), metadata, now)
    elif country == 'CH':
        rows = parse_switzerland(download(SWISS), download(SWISS_META), now)
    else:
        raise ValueError('Unsupported Alpine country')
    if not rows:
        raise ValueError('No recent official Alpine observations')
    return rows


def load_temperature(country, now, download):
    import update_official_temperature as core
    out = []
    for s in load(country, now, download):
        item = core.make_station(country, s['code'], s['name'], s['lat'], s['lon'], [(r[0], r[1]) for r in s['rows']])
        if item:
            out.append(item)
    if not out:
        raise ValueError('No recent official Alpine temperatures')
    return out


def load_wind(country, now, download):
    import update_official_wind as core
    out = []
    for s in load(country, now, download):
        item = core.station(country, s['code'], s['name'], s['lat'], s['lon'], [(r[0], r[2], r[3], r[4]) for r in s['rows']])
        if item['rows']:
            out.append(item)
    if not out:
        raise ValueError('No recent official Alpine winds')
    return out
