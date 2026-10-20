"""ČHMÚ and SHMÚ measured station wind, preserving quality flags and times."""
import concurrent.futures as futures
import datetime as dt
import json
import re
import urllib.parse
from zoneinfo import ZoneInfo

import update_official_wind as core
from update_central_temperature import chmi_table, chmi_metadata
from official_wind_western import recent

CHMI = 'https://opendata.chmi.cz/meteorology/climate/now/'
SHMU_MAP = 'https://www.shmu.sk/api/v1/meteo/getweathergeojson'
# This public observation archive is published over HTTP by SHMÚ. All browser
# traffic still uses the site's HTTPS shared snapshots; TLS checks stay enabled.
SHMU_OPEN = 'http://opendata.shmu.sk/meteorology/climate/now/'
SHMU_CET = dt.timezone(dt.timedelta(hours=1))


def chmi_wind_elements(payload, metadata):
    out = {}
    for row in chmi_table(payload):
        code, element = row.get('WSI'), row.get('EG_EL_ABBREVIATION')
        if code not in metadata or row.get('OBS_TYPE') != '10M' or element not in ('Fprum', 'Fmax', 'Dprum'):
            continue
        expected = 'stupně' if element == 'Dprum' else 'm/s'
        if str(row.get('UN_DESCRIPTION', '')).strip() != expected:
            raise ValueError('ČHMÚ wind units changed')
        out.setdefault(code, {})[element] = row
    return {code: fields for code, fields in out.items() if 'Fprum' in fields or 'Fmax' in fields}


def chmi_wind_station(payload, code, metadata, elements):
    grouped = {}
    indexes = {'Fprum': 1, 'Fmax': 2, 'Dprum': 3}
    for row in chmi_table(payload):
        element = row.get('ELEMENT')
        # F is a different wind statistic. Use the ten-minute mean Fprum.
        if (row.get('STATION') != code or element not in indexes or element not in elements
                or isinstance(row.get('QUALITY'), bool) or row.get('QUALITY') not in (0, 5)):
            continue
        value = core.number(row.get('VAL'), 360 if element == 'Dprum' else 100)
        if value is None:
            continue
        try:
            stamp = core.timestamp(row.get('DT'))
        except (ValueError, TypeError):
            continue
        grouped.setdefault(stamp, [stamp, None, None, None])[indexes[element]] = value
    item = core.station('CZ', code, metadata['name'], metadata['lat'], metadata['lon'], grouped.values())
    height = (elements.get('Fprum') or elements.get('Fmax') or {}).get('HEIGHT')
    height_text = f' Wind sensor height: {height:g} m above ground.' if isinstance(height, (int, float)) and not isinstance(height, bool) and 0 < height < 100 else ''
    item['period'] = 'Ten-minute mean wind (Fprum), maximum gust (Fmax) over ten minutes and mean wind direction (Dprum).'+height_text+' Published hourly with UTC observation times; provisional. Missing or suspect values stay unavailable.'
    return item


def load_czechia(now):
    date = now.strftime('%Y%m%d')
    metadata = chmi_metadata(core.download_json(CHMI+'metadata/meta1-'+date+'.json'))
    elements = chmi_wind_elements(core.download_json(CHMI+'metadata/meta2-'+date+'.json'), metadata)
    listing = core.download(CHMI+'data/').decode('utf8')
    dates = {date}
    if now.hour < 2:
        dates.add((now-dt.timedelta(days=1)).strftime('%Y%m%d'))
    targets = [(name, code) for name, code, day in re.findall(r'href="(10m-([\w-]+)-(\d{8})\.json)"', listing)
               if day in dates and code in elements]
    if not targets or len(targets) > 1600:
        raise ValueError('No current Czech wind station files')
    def collect(target):
        name, code = target
        try:
            return chmi_wind_station(core.download_json(CHMI+'data/'+name), code, metadata[code], elements[code])
        except Exception as error:
            print('CZ wind', code, 'unavailable:', str(error)[:120], flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        stations = list(pool.map(collect, targets))
    # Midnight can provide two files for one station. Merge exact timestamps.
    return recent(core.merge([], [s for s in stations if s], now), now)


def shmu_station_metadata(payload):
    if payload.get('type') != 'FeatureCollection' or not isinstance(payload.get('features'), list):
        raise ValueError('Invalid SHMÚ station map')
    out = {}
    for f in payload['features']:
        p = f.get('properties') or {}
        geometry = f.get('geometry') or {}
        coords = geometry.get('coordinates') or []
        code = str((p.get('prop_weather') or {}).get('station_id') or '')
        if not code or geometry.get('type') != 'Point' or len(coords) != 2:
            continue
        lon, lat = coords
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not (47.6 <= lat <= 49.7 and 16.7 <= lon <= 22.7):
            continue
        out[code] = {'name': p.get('prop_name') or code, 'lat': lat, 'lon': lon}
    if not out:
        raise ValueError('No Slovak station coordinates')
    return out


def shmu_observation_time(value):
    # Provider metadata explicitly uses SEČ/CET, including during summer.
    # Archive filenames use local publication time and are not observation time.
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SHMU_CET)
    return int(parsed.timestamp())


def shmu_minute_observations(payload, metadata, parameters):
    if payload.get('dataset') != 'Automatic stations' or payload.get('interval') != '1 minute' or not isinstance(payload.get('data'), list):
        raise ValueError('Invalid SHMÚ minute observations')
    units = {p.get('m_column_name'): p.get('unit') for p in parameters.get('data', [])}
    if any(units.get(k) != 'm/s' for k in ('vie_pr_rych', 'vie_max_rych')) or units.get('vie_vp_smer') != 'dg':
        raise ValueError('SHMÚ wind units changed')
    grouped = {}
    for row in payload['data']:
        code = str(row.get('ind_kli', ''))
        if code not in metadata:
            continue
        try:
            stamp = shmu_observation_time(row.get('minuta'))
        except (ValueError, TypeError):
            continue
        grouped.setdefault(code, []).append((stamp, row.get('vie_pr_rych'), row.get('vie_max_rych'), row.get('vie_vp_smer')))
    return [core.station('SK', code, metadata[code]['name'], metadata[code]['lat'], metadata[code]['lon'], rows)
            for code, rows in grouped.items()]


def shmu_archive_files(listing):
    entries = []
    for row in re.findall(r'<tr>(.*?)</tr>', listing, re.S):
        link = re.search(r'href="(aws1min[^"/]+[.]json)"', row)
        modified = re.search(r'\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}', row)
        if link and modified:
            name = link[1]
            if re.fullmatch(r'aws1min - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}[.]json', urllib.parse.unquote(name)):
                entries.append((modified[0], name))
    # Modification order remains correct when the local clock repeats in autumn.
    return [name for _, name in sorted(entries)]


def load_slovakia(now):
    locations = core.download_json(SHMU_MAP)
    metadata = shmu_station_metadata(locations)
    parameters = core.download_json(SHMU_OPEN+'metadata/aws1min_metadata.json')
    date = now.astimezone(ZoneInfo('Europe/Bratislava')).date()
    targets = []
    for day in (date, date-dt.timedelta(days=1)):
        url = SHMU_OPEN+'data/'+day.strftime('%Y%m%d')+'/'
        try:
            names = shmu_archive_files(core.download(url).decode('utf8'))
            targets.extend(url+name for name in reversed(names[-(2-len(targets)):]))
        except Exception:
            if day != date:
                raise
        if len(targets) >= 2:
            break
    if not targets:
        raise ValueError('No current SHMÚ minute archive files')
    stations = []
    for url in reversed(targets):
        stations.extend(shmu_minute_observations(core.download_json(url), metadata, parameters))
    return recent(core.merge([], stations, now), now)
