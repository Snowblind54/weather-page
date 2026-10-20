"""Measured DWD, KNMI, RMI/KMI and MeteoLux wind; preserve native gaps/times."""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib
import re
import urllib.parse
import zipfile
from zoneinfo import ZoneInfo

import update_official_wind as core
from update_western_temperature import dwd_metadata, knmi_metadata, normalized_name, ObservationTable

DWD = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/'
KNMI = 'https://www.knmi.nl/nederland-nu/weer/waarnemingen/'
KNMI_METADATA = 'https://www.daggegevens.knmi.nl/klimatologie/uurgegevens?'
RMI = 'https://opendata.meteo.be/service/aws/ows?'
METEOLUX = 'https://metapi.ana.lu/api/v1/hvd/'
MONTHS = dict(zip('januari februari maart april mei juni juli augustus september oktober november december'.split(), range(1, 13)))


def recent(stations, now):
    end = int(now.timestamp())
    out = []
    for item in stations:
        if item:
            item['rows'] = [r for r in item['rows'] if end-24*3600 <= r[0] <= end+60]
            if item['rows'] and item['rows'][-1][0] >= end-3*3600:
                out.append(item)
    if not out:
        raise ValueError('No recent official wind measurements in this feed')
    return out


def dwd_values(raw, code, kind):
    """Only join mean wind and gust at the same UTC ten-minute timestamp."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        files = [f for f in archive.infolist() if f.filename.startswith('produkt_zehn_now_') and f.filename.endswith('.txt')]
        if len(files) != 1 or files[0].file_size > 2*1024*1024:
            raise ValueError('Unexpected DWD wind archive')
        lines = archive.read(files[0]).decode('latin1').splitlines()
    header = [p.strip() for p in lines[0].split(';')]
    required = {'STATIONS_ID', 'MESS_DATUM', 'FF_10', 'DD_10'} if kind == 'wind' else {'STATIONS_ID', 'MESS_DATUM', 'FX_10'}
    if not required <= set(header):
        raise ValueError('DWD wind columns changed')
    out = {}
    for row in csv.DictReader(lines[1:], fieldnames=header, delimiter=';'):
        if row['STATIONS_ID'].strip().zfill(5) != code:
            continue
        try:
            stamp = int(dt.datetime.strptime(row['MESS_DATUM'].strip(), '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except (ValueError, TypeError):
            continue
        values = [None, None, None]
        if kind == 'wind':
            values[0], values[2] = core.number(row['FF_10']), core.number(row['DD_10'], 360)
        else:
            values[1] = core.number(row['FX_10'])
        out[stamp] = values
    return out


def merge_dwd(code, metadata, mean, gust):
    rows = []
    for stamp in sorted(mean.keys() | gust.keys()):
        a, b = mean.get(stamp, [None]*3), gust.get(stamp, [None]*3)
        rows.append((stamp, a[0], b[1], a[2]))
    return core.station('DE', code, metadata['name'], metadata['lat'], metadata['lon'], rows)


def load_germany(now):
    metadata = dwd_metadata(core.download(DWD+'wind/recent/zehn_min_ff_Beschreibung_Stationen.txt'))
    targets = []
    for kind, product in [('wind', 'wind'), ('extreme_wind', 'extrema_wind')]:
        listing = core.download(DWD+kind+'/now/').decode('utf8')
        files = re.findall(r'href="(10minutenwerte_'+product+r'_(\d{5})_now\.zip)"', listing)
        if not files or len(files) > 1000:
            raise ValueError('Unexpected DWD wind station directory')
        targets.extend((code, kind, DWD+kind+'/now/'+name) for name, code in files if code in metadata)
    collected = {}
    def collect(target):
        code, kind, url = target
        try:
            return code, kind, dwd_values(core.download(url), code, kind)
        except Exception as error:
            print('DE wind', code, kind, 'unavailable:', str(error)[:120], flush=True)
            return code, kind, {}
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        for code, kind, rows in pool.map(collect, targets):
            collected.setdefault(code, {})[kind] = rows
    return recent([merge_dwd(code, metadata[code], parts.get('wind', {}), parts.get('extreme_wind', {}))
                   for code, parts in collected.items()], now)


def knmi_observations(raw, metadata):
    parser = ObservationTable()
    parser.feed(raw.decode('utf8') if isinstance(raw, bytes) else raw)
    match = re.search(r'Waarnemingen\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+uur', ' '.join(parser.text), re.I)
    if not match or match[2].lower() not in MONTHS:
        raise ValueError('KNMI observation timestamp missing')
    observed = dt.datetime(int(match[3]), MONTHS[match[2].lower()], int(match[1]), int(match[4]), int(match[5]), tzinfo=ZoneInfo('Europe/Amsterdam'))
    columns, out = None, []
    for row in parser.rows:
        if row and row[0].lower().startswith('station'):
            speed = next((i for i, v in enumerate(row) if 'wind' in v.lower() and '(m/s)' in v.lower()), None)
            gust = next((i for i, v in enumerate(row) if 'windstoot' in v.lower() and '(km/uur)' in v.lower()), None)
            if speed is None or gust is None:
                raise ValueError('KNMI wind units or columns changed')
            columns = speed, gust
            continue
        if columns is None or len(row) <= max(columns):
            continue
        meta = metadata.get(normalized_name(row[0]))
        if not meta:
            continue
        speed, gust = core.number(row[columns[0]]), core.number(row[columns[1]], 360)
        item = core.station('NL', meta['code'], row[0], meta['lat'], meta['lon'],
                            [(int(observed.timestamp()), speed, None if gust is None else gust/3.6, None)])
        if item['rows']:
            out.append(item)
    return out


def load_netherlands(now):
    yesterday = (now-dt.timedelta(days=1)).strftime('%Y%m%d')
    params = {'start': yesterday+'01', 'end': yesterday+'24', 'vars': 'FH', 'stns': 'ALL'}
    metadata = knmi_metadata(core.download(KNMI_METADATA+urllib.parse.urlencode(params)))
    return recent(knmi_observations(core.download(KNMI), metadata), now)


def rmi_features(kind, **params):
    query = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'aws:'+kind,
             'outputFormat': 'application/json', 'srsName': 'EPSG:4326', 'count': 5000, **params}
    payload = core.download_json(RMI+urllib.parse.urlencode(query))
    rows = payload.get('features')
    if not isinstance(rows, list) or len(rows) >= 5000:
        raise ValueError('Incomplete RMI feature collection')
    return rows


def rmi_observations(observations, metadata, now):
    end = int(now.timestamp())
    stations = {}
    for f in metadata:
        p = f.get('properties') or {}
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if p.get('code') is None or len(coords) != 2:
            continue
        begin = core.timestamp(p['date_begin']) if p.get('date_begin') else None
        finish = core.timestamp(p['date_end']) if p.get('date_end') else None
        if (begin is None or begin <= end) and (finish is None or finish > end):
            stations[str(p['code'])] = p.get('name') or str(p['code']), coords
    grouped = {}
    for f in observations:
        p = f.get('properties') or {}
        code = str(p.get('code', ''))
        if code not in stations or not p.get('timestamp'):
            continue
        # The 30 m average is a different measurement and must not replace 10 m.
        grouped.setdefault(code, []).append((p['timestamp'], p.get('wind_speed_10m'), p.get('wind_gusts_speed'), p.get('wind_direction')))
    return [core.station('BE', code, stations[code][0], stations[code][1][1], stations[code][1][0], rows)
            for code, rows in grouped.items()]


def load_belgium(now):
    start, end = [(now-dt.timedelta(hours=hours)).strftime('%Y-%m-%dT%H:%M:%SZ') for hours in (3, 0)]
    metadata = rmi_features('aws_station')
    rows = rmi_features('aws_10min', CQL_FILTER=f"timestamp >= '{start}' AND timestamp <= '{end}'")
    return recent(rmi_observations(rows, metadata, now), now)


def meteolux_observations(observations, metadata, parameters):
    station = metadata.get('data') or {}
    if station.get('id') != 'LUX0000001' or len(station.get('location') or []) != 2:
        raise ValueError('Unexpected MeteoLux observation station')
    definitions = {p['id']: p for p in parameters.get('data', [])}
    values = {p['id']: p.get('value') for p in observations.get('data', [])}
    sensor = 'rwymd0'
    keys = ['s2ff_'+sensor, 's2ffgust_'+sensor, 's2dd_'+sensor]
    if any(k not in definitions for k in keys) or [definitions[k]['unit'] for k in keys] != ['m/s', 'm/s', 'degrees']:
        raise ValueError('MeteoLux wind sensor or units changed')
    lon, lat = station['location']
    return core.station('LU', station['id'], station.get('shortName') or station['name'], lat, lon,
                        [(observations.get('timestamp'), *(values.get(k) for k in keys))])


def load_luxembourg(now):
    metadata = core.download_json(METEOLUX+'stations/LUX0000001')
    parameters = core.download_json(METEOLUX+'observations/metadata')
    observations = core.download_json(METEOLUX+'observations')
    return recent([meteolux_observations(observations, metadata, parameters)], now)
