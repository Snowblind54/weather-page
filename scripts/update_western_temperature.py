"""DWD, KNMI and RMI measured temperatures for the shared station snapshot.

Use the providers' observation times, never collection time. Near-real-time
values are provisional. Each national feed can fail independently, with the
core collector retaining that country's previous observations and their dates.
"""
import concurrent.futures as futures
import csv
import datetime as dt
from html.parser import HTMLParser
import io
import json
import math
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import zipfile
from zoneinfo import ZoneInfo

import update_official_temperature as core

DWD = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/'
KNMI = 'https://www.knmi.nl/nederland-nu/weer/waarnemingen/'
KNMI_METADATA = 'https://www.daggegevens.knmi.nl/klimatologie/uurgegevens?'
RMI = 'https://opendata.meteo.be/service/aws/ows?'


def download(url, timeout=40, attempts=3):
    for attempt in range(attempts):
        try:
            return core.download(url, timeout)
        except urllib.error.HTTPError as error:
            if attempt == attempts-1 or error.code not in (408, 429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == attempts-1:
                raise
        time.sleep(3 * (attempt + 1))


def temperature(value):
    if value is None or isinstance(value, bool) or str(value).strip() in ('', '-', '---'):
        return None
    try:
        value = float(str(value).replace(',', '.'))
    except (TypeError, ValueError):
        return None
    return round(value, 2) if math.isfinite(value) and -90 < value < 55 else None


def recent_stations(stations, now=None):
    now = int(time.time()) if now is None else now
    out = []
    for station in stations:
        if not station:
            continue
        station['rows'] = [r for r in station['rows'] if now-24*3600 <= r[0] <= now]
        if station['rows'] and station['rows'][-1][0] >= now-95*60:
            out.append(station)
    if not out:
        raise ValueError('No recent measured temperatures from this national feed')
    latest = max(s['rows'][-1][0] for s in out)
    print(out[0]['country'], len(out), 'recent official temperature stations; newest observation',
          dt.datetime.fromtimestamp(latest, dt.timezone.utc).isoformat(), flush=True)
    return out


def dwd_metadata(raw):
    text = raw.decode('latin-1') if isinstance(raw, bytes) else raw
    out = {}
    for line in text.splitlines():
        parts = line.split(None, 6)
        if len(parts) != 7 or not re.fullmatch(r'\d{5}', parts[0]):
            continue
        try:
            lat, lon = float(parts[4]), float(parts[5])
        except ValueError:
            continue
        name = re.split(r'\s{2,}', parts[6].strip())[0]
        if 47 <= lat <= 55.2 and 5.5 <= lon <= 15.6:
            out[parts[0]] = {'name': name, 'lat': lat, 'lon': lon}
    if not out:
        raise ValueError('DWD station catalogue missing')
    return out


def dwd_station(raw, code, metadata):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        files = [f for f in archive.infolist() if f.filename.startswith('produkt_zehn_now_tu_') and f.filename.endswith('.txt')]
        if len(files) != 1 or files[0].file_size > 2*1024*1024:
            raise ValueError('Unexpected DWD temperature archive')
        lines = archive.read(files[0]).decode('latin-1').splitlines()
    if not lines:
        raise ValueError('Empty DWD archive')
    header = [x.strip() for x in lines[0].split(';')]
    if not {'STATIONS_ID', 'MESS_DATUM', 'TT_10'} <= set(header):
        raise ValueError('DWD temperature columns changed')
    rows = []
    for row in csv.DictReader(lines[1:], fieldnames=header, delimiter=';'):
        if str(row.get('STATIONS_ID', '')).strip().zfill(5) != code:
            continue
        value = temperature(row.get('TT_10'))
        if value is None:
            continue
        try:
            stamp = dt.datetime.strptime(row['MESS_DATUM'].strip(), '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        rows.append((int(stamp.timestamp()), value))
    return core.make_station('DE', code, metadata['name'], metadata['lat'], metadata['lon'], rows)


def parse_germany():
    metadata = dwd_metadata(download(DWD+'recent/zehn_min_tu_Beschreibung_Stationen.txt'))
    listing = download(DWD+'now/').decode('utf-8')
    files = dict(re.findall(r'href="(10minutenwerte_TU_(\d{5})_now\.zip)"', listing))
    targets = [(name, code) for name, code in files.items() if code in metadata]
    if not targets or len(targets) > 1000:
        raise ValueError('Unexpected DWD current-station directory')
    def station(target):
        name, code = target
        try:
            return dwd_station(download(DWD+'now/'+name, timeout=12, attempts=2), code, metadata[code])
        except Exception as error:
            print('DWD station', code, 'unavailable:', str(error)[:120], flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        return recent_stations(list(pool.map(station, targets)))


def normalized_name(name):
    return ''.join(c for c in unicodedata.normalize('NFKD', name).upper() if c.isascii() and c.isalnum())


def knmi_metadata(raw):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else raw
    out = {}
    for line in text.splitlines():
        match = re.match(r'^#\s*(\d+):?\s+([\d.]+)\s+([\d.]+)\s+([-\d.]+)\s+(.+?)\s*$', line)
        if match:
            code, lon, lat, height, name = match.groups()
            if 50.5 <= float(lat) <= 54 and 2 <= float(lon) <= 8:
                meta = {'code': code, 'name': name, 'lat': float(lat), 'lon': float(lon)}
                out[normalized_name(name)] = meta
                # KNMI's current-weather table uses shorter display names
                # than the hourly station catalogue for these same sites.
                out[normalized_name(re.sub(r'\s+Airport$', '', name, flags=re.I))] = meta
                aliases = {'235': 'Den Helder', '242': 'Vlieland', '251': 'Terschelling', '280': 'Eelde',
                           '380': 'Maastricht-Aachen Airport'}
                if code in aliases:
                    out[normalized_name(aliases[code])] = meta
    if not out:
        raise ValueError('KNMI station coordinates missing')
    return out


class ObservationTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.text, self.row, self.cell = [], [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.row = []
        if tag in ('td', 'th') and self.row is not None:
            self.cell = []

    def handle_data(self, text):
        self.text.append(text)
        if self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            self.row.append(' '.join(' '.join(self.cell).split()))
            self.cell = None
        if tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def knmi_observations(raw, metadata):
    parser = ObservationTable()
    parser.feed(raw.decode('utf-8') if isinstance(raw, bytes) else raw)
    text = ' '.join(parser.text)
    match = re.search(r'Waarnemingen\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+uur', text, re.I)
    months = dict(zip(('januari februari maart april mei juni juli augustus september oktober november december').split(), range(1, 13)))
    if not match or match[2].lower() not in months:
        raise ValueError('KNMI observation table timestamp missing')
    observed = dt.datetime(int(match[3]), months[match[2].lower()], int(match[1]), int(match[4]), int(match[5]),
                           tzinfo=ZoneInfo('Europe/Amsterdam'))
    column = None
    out = []
    for row in parser.rows:
        if row and row[0].lower().startswith('station'):
            column = next((i for i, v in enumerate(row) if 'temp' in v.lower() and 'wbgt' not in v.lower()), None)
            continue
        if column is None or len(row) <= column:
            continue
        meta = metadata.get(normalized_name(row[0]))
        value = temperature(row[column])
        if meta and value is not None:
            out.append(core.make_station('NL', meta['code'], row[0], meta['lat'], meta['lon'],
                                         [(int(observed.timestamp()), value)]))
    return out


def parse_netherlands():
    yesterday = (dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=1)).strftime('%Y%m%d')
    params = {'start': yesterday+'01', 'end': yesterday+'24', 'vars': 'T', 'stns': 'ALL'}
    metadata = knmi_metadata(download(KNMI_METADATA+urllib.parse.urlencode(params)))
    return recent_stations(knmi_observations(download(KNMI), metadata))


def rmi_features(kind, **params):
    query = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'aws:'+kind,
             'outputFormat': 'application/json', 'srsName': 'EPSG:4326', 'count': 5000, **params}
    payload = json.loads(download(RMI+urllib.parse.urlencode(query)))
    rows = payload.get('features')
    if not isinstance(rows, list) or len(rows) >= 5000:
        raise ValueError('Incomplete RMI feature collection')
    return rows


def rmi_observations(observations, metadata, now=None):
    now = int(time.time()) if now is None else now
    stations = {}
    for feature in metadata:
        p = feature.get('properties') or {}
        code = str(p.get('code', ''))
        end, start = core.stamp(p.get('date_end')), core.stamp(p.get('date_begin'))
        coords = (feature.get('geometry') or {}).get('coordinates') or []
        if code and len(coords) >= 2 and (end is None or end > now) and (start is None or start <= now):
            stations[code] = (p.get('name') or code, coords)
    grouped = {}
    for feature in observations:
        p = feature.get('properties') or {}
        code, value = str(p.get('code', '')), temperature(p.get('temp_dry_shelter_avg'))
        if code in stations and value is not None:
            grouped.setdefault(code, []).append((p.get('timestamp'), value))
    return [core.make_station('BE', code, stations[code][0], stations[code][1][1], stations[code][1][0], rows)
            for code, rows in grouped.items()]


def parse_belgium():
    now = dt.datetime.now(dt.timezone.utc)
    start = (now-dt.timedelta(hours=3)).strftime('%Y-%m-%dT%H:%M:%SZ')
    end = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    metadata = rmi_features('aws_station')
    observations = rmi_features('aws_10min', CQL_FILTER=f"timestamp >= '{start}' AND timestamp <= '{end}'")
    return recent_stations(rmi_observations(observations, metadata))


core.SOURCES.update({'DE': 'DWD Climate Data Center / ten-minute air temperature (provisional)',
    'NL': 'KNMI / official ten-minute observation table (table timestamp; provisional)',
    'BE': 'Royal Meteorological Institute of Belgium (RMI/KMI) / ten-minute shelter temperature (provisional)'})
core.COUNTRY_BOUNDS.update({'DE': (47, 55.2, 5.5, 15.6), 'NL': (50.5, 54, 2, 8), 'BE': (49.4, 51.6, 2.4, 6.5)})
core.LOADERS.update({'DE': parse_germany, 'NL': parse_netherlands, 'BE': parse_belgium})
