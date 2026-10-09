"""Collect official station snow depth, preserving dates and non-numeric states."""
import concurrent.futures as futures
import datetime as dt
import csv
import io
import gzip
import json
import math
import pathlib
import re
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/official-snow-depth.json'
SOURCES = {
    'EE': {'name': 'Keskkonnaagentuur', 'url': 'https://www.ilmateenistus.ee/'},
    'FI': {'name': 'Finnish Meteorological Institute (FMI)', 'url': 'https://en.ilmatieteenlaitos.fi/open-data'},
    'SE': {'name': 'SMHI', 'url': 'https://www.smhi.se/data/meteorologi/sno'},
    'LV': {'name': 'LVĢMC', 'url': 'https://data.gov.lv/dati/dataset/hidrometeorologiskie-noverojumi', 'license': 'CC0-1.0'},
    'LT': {'name': 'Lithuanian Hydrometeorological Service (LHMT)', 'url': 'https://api.meteo.lt/', 'license': 'CC BY-SA 4.0'},
    'NO': {'name': 'MET Norway', 'url': 'https://seklima.met.no/', 'license': 'CC BY 3.0 NO'},
    'IS': {'name': 'Icelandic Meteorological Office', 'url': 'https://www.vedur.is/vedur/athuganir/urkoma/'},
    'CA': {'name': 'Environment and Climate Change Canada / MSC', 'url': 'https://eccc-msc.github.io/open-data/msc-data/obs_station/readme_obs_insitu_en/'},
    'GL': {'name': 'Danish Meteorological Institute (DMI)', 'url': 'https://www.dmi.dk/friedata/dokumentation/meteorological-observations-data'},
}


def download(url, as_json=True):
    headers = {'User-Agent': 'NorthernWeather/8.43 (Snowblind54/weather-page)', 'Accept-Encoding': 'gzip'}
    if 'keskkonnaandmed.envir.ee' in url:
        headers.update({'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=40) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read(2500).decode('utf-8', errors='replace')
        raise ValueError(f'HTTP {error.code}: {detail}') from error
    if raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    return json.loads(raw) if as_json else raw


def number(value):
    if value is None or isinstance(value, bool) or str(value).strip() == '':
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def timestamp(value):
    if isinstance(value, (int, float)):
        return int(value / 1000 if value > 1e11 else value)
    return int(dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp())


def depth(value, country):
    n = number(value)
    if n is None:
        return None
    if country == 'FI':
        if n == -1:
            return 0, 'bare', 'No snow'
        if n == 0:
            return 0, 'nearby', 'Station ground bare; snow observed nearby'
    if country == 'GL' and n == -1:
        return None, 'trace', 'Less than 0.5 cm (official DMI code)'
    if country == 'NO':
        if n == 0:
            return None, 'trace', 'Less than 0.5 cm (official zero code)'
        if n == -1:
            return None, 'patchy', 'Zero snow depth or partial snow cover (official code)'
    if country == 'SE':
        if math.isclose(n, -0.01):
            return None, 'trace', 'Less than 0.5 cm'
        if math.isclose(n, -0.02):
            return None, 'patchy', 'Patchy snow'
        n *= 100
    if not 0 <= n <= 1500:
        return None
    return round(n, 1), 'bare' if n == 0 else 'depth', ''


def record(country, code, name, lat, lon, time, value, quality='', precision='day'):
    parsed = depth(value, country)
    lat, lon = number(lat), number(lon)
    south, north, west, east = {'CA': (41, 85, -142, -52), 'GL': (59, 85, -74, -10)}.get(country, (53, 81, -25, 33))
    if parsed is None or lat is None or lon is None or not (south <= lat <= north and west <= lon <= east):
        return None
    cm, state, note = parsed
    return {'country': country, 'code': str(code), 'name': str(name), 'lat': lat, 'lon': lon,
            'time': timestamp(time), 'timePrecision': precision, 'depthCm': cm,
            'state': state, 'note': note, 'quality': quality}


def latest(records):
    selected = {}
    for s in records:
        if s is None:
            continue
        key = s['country'], s['code']
        if key not in selected or s['time'] > selected[key]['time']:
            selected[key] = s
    return list(selected.values())


def normal_name(value):
    return re.sub(r'[^a-z0-9õäöü]', '', str(value).lower().replace('tallinn-harku', 'harku'))


def parse_estonia(rows, metadata):
    by_code = {str(s.get('jaam_kood')): s for s in metadata if s.get('jaam_kood')}
    by_name = {normal_name(s.get('jaam_nimi', s.get('name', ''))): s for s in metadata}
    out = []
    for row in rows:
        if row.get('element_yhik', row.get('element_yhik_eng')) not in ('cm', 'sentimeeter'):
            continue
        meta = by_code.get(str(row.get('jaam_kood'))) or by_name.get(normal_name(row.get('jaam_nimi', '')))
        if not meta:
            continue
        lat = next((meta[k] for k in ['latitude', 'laiuskraad', 'laius', 'lat'] if k in meta), None)
        lon = next((meta[k] for k in ['longitude', 'pikkuskraad', 'pikkus', 'lon'] if k in meta), None)
        # Daily dataset dates are observation dates, not its publication timestamp.
        day = dt.datetime(int(row['aasta']), int(row['kuu']), int(row['paev']), tzinfo=dt.timezone.utc)
        out.append(record('EE', row['jaam_kood'], row['jaam_nimi'], lat, lon, day.timestamp(), row.get('vaartus')))
    return latest(out)


def load_estonia(now):
    base = 'https://keskkonnaandmed.envir.ee'
    elements = download(base + '/f_kliima_element')
    candidates = []
    for e in elements:
        name = str(e.get('element_nimi', '')).lower()
        code = str(e.get('element_kood', ''))
        if ('snow depth' in name or 'lumikatte paks' in name) and code.startswith('D'):
            candidates.append(e)
    print('EE snow elements:', json.dumps(candidates, ensure_ascii=False), flush=True)
    if not candidates:
        raise ValueError('Official daily snow-depth element not found')
    # Coordinates from the official current observation station metadata.
    root = ET.fromstring(download('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php', False))
    metadata = [{'name': s.findtext('name'), 'latitude': s.findtext('latitude'),
                 'longitude': s.findtext('longitude')} for s in root.findall('station')]
    try:
        climate_meta = download(base + '/f_kliima_jaam_vaatlus')
        print('EE station metadata sample:', json.dumps(climate_meta[:1], ensure_ascii=False), flush=True)
        # Keep XML coordinates as fallback when the climate API has no coordinates.
        for m in climate_meta:
            fallback = next((s for s in metadata if normal_name(s['name']) == normal_name(m.get('jaam_nimi', ''))), {})
            metadata.append({**fallback, **m})
    except Exception as error:
        print('EE climate station metadata:', error, flush=True)
    months = {(now.year, now.month), ((now-dt.timedelta(days=4)).year, (now-dt.timedelta(days=4)).month)}
    rows = []
    for year, month in sorted(months):
        params = {'aasta': 'eq.' + str(year), 'kuu': 'eq.' + str(month),
                  'element_kood': 'in.(' + ','.join(e['element_kood'] for e in candidates) + ')',
                  'order': 'paev.desc', 'limit': '20000'}
        if year == now.year and month == now.month:
            params['paev'] = 'gte.' + str(max(1, now.day-4))
        rows += download(base + '/f_kliima_paev?' + urllib.parse.urlencode(params))
    print('EE snow row sample:', json.dumps(rows[:1], ensure_ascii=False), flush=True)
    return parse_estonia(rows, metadata)


def local(el):
    return el.tag.split('}')[-1]


def parse_finland(raw):
    root = ET.fromstring(raw)
    if any(local(e) == 'ExceptionText' for e in root.iter()):
        raise ValueError('FMI: ' + ' '.join(e.text or '' for e in root.iter() if local(e) == 'ExceptionText'))
    names = {}
    points = {}
    for point in root.iter():
        if local(point) != 'Point':
            continue
        ident = next((value for key, value in point.attrib.items() if key.split('}')[-1] == 'id'), '')
        pos = next((e.text or '' for e in point.iter() if local(e) == 'pos'), '').split()
        if ident and len(pos) >= 2:
            points[ident] = pos
    for location in root.iter():
        if local(location) != 'Location':
            continue
        fields = {local(e): (e.text or '').strip() for e in location.iter()}
        pos = fields.get('pos', '').split()
        if len(pos) < 2:
            for e in location.iter():
                if local(e) == 'representativePoint':
                    href = next((v for k, v in e.attrib.items() if k.split('}')[-1] == 'href'), '')
                    pos = points.get(href.lstrip('#'), [])
        station_name = next((e.text.strip() for e in location.iter() if local(e) == 'name' and e.text
                             and not any(word in e.attrib.get('codeSpace', '').lower() for word in ('region', 'country'))),
                            fields.get('name') or 'FMI station')
        if len(pos) >= 2:
            names[(round(float(pos[0]), 5), round(float(pos[1]), 5))] = (
                fields.get('identifier') or ','.join(pos), station_name)
    records = []
    for coverage in root.iter():
        if local(coverage) != 'MultiPointCoverage':
            continue
        positions = next((e for e in coverage.iter() if local(e) == 'positions'), None)
        values = next((e for e in coverage.iter() if local(e) == 'doubleOrNilReasonTupleList'), None)
        if positions is None or values is None:
            continue
        coords = (positions.text or '').split()
        readings = (values.text or '').split()
        if len(coords) != len(readings)*3:
            raise ValueError('FMI snow coordinates and single-parameter readings do not match')
        for i, value in enumerate(readings):
            lat, lon, time = map(float, coords[3*i:3*i+3])
            code, name = names.get((round(lat, 5), round(lon, 5)), (f'{lat:.5f},{lon:.5f}', f'FMI station {lat:.2f}, {lon:.2f}'))
            records.append(record('FI', code, name, lat, lon, time, value))
    return latest(records)


def load_finland(now):
    params = dict(service='WFS', version='2.0.0', request='getFeature',
                  storedquery_id='fmi::observations::weather::daily::multipointcoverage',
                  bbox='19,59,32,71.7', starttime=(now-dt.timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                  endtime=now.strftime('%Y-%m-%dT%H:%M:%SZ'), parameters='snow')
    return parse_finland(download('https://opendata.fmi.fi/wfs?' + urllib.parse.urlencode(params), False))


def parse_sweden(payload):
    if str(payload['parameter']['key']) != '8' or payload['parameter']['unit'] != 'meter':
        raise ValueError('SMHI snow-depth units or parameter changed')
    out = []
    for s in payload.get('station', []):
        if s.get('owner') and str(s['owner']).upper() != 'SMHI':
            continue
        for v in s.get('value', []):
            quality = v.get('quality')
            if quality not in ('G', 'Y'):
                continue
            out.append(record('SE', s['key'], s['name'], s['latitude'], s['longitude'],
                              v['date'], v.get('value'), 'approved' if quality == 'G' else 'provisional', 'instant'))
    return latest(out)


def load_sweden(now):
    base = 'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/8'
    meta = download(base + '.json')
    print('SE metadata sample:', json.dumps(meta.get('station', [])[:1], ensure_ascii=False), flush=True)
    print('SE parameter:', json.dumps({k: meta.get(k) for k in ('key', 'title', 'summary', 'unit')}, ensure_ascii=False), flush=True)
    stations = [s for s in meta.get('station', []) if s.get('active') and (not s.get('owner') or s['owner'].upper() == 'SMHI')]
    def get(s):
        try:
            values = download(base + '/station/' + str(s['key']) + '/period/latest-months/data.json')
            return {**s, 'value': values.get('value', [])}
        except Exception as error:
            print('SE station unavailable:', s['key'], str(error)[:200], flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        rows = [s for s in pool.map(get, stations) if s]
    return parse_sweden({'parameter': {'key': meta['key'], 'unit': meta['unit']}, 'station': rows})


def csv_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def parse_latvia(rows, metadata, parameters):
    stations = {s['STATION_ID']: s for s in metadata}
    snow_parameters = {p['ABBREVIATION'] for p in parameters
                       if p['ABBREVIATION'] in ('HSNOW', 'SNOWA') and p['MEASUREMENT_UNIT'] == 'cm'}
    out = []
    # Operational CSV timestamps use UTC (same feed as the rainfall collector).
    for row in rows:
        meta = stations.get(row['STATION_ID'])
        if not meta or row['ABBREVIATION'] not in snow_parameters:
            continue
        observed = dt.datetime.strptime(row['DATETIME'], '%Y.%m.%d %H:%M:%S').replace(tzinfo=dt.timezone.utc)
        out.append(record('LV', row['STATION_ID'], meta['NAME'], meta['GEOGR2'], meta['GEOGR1'],
                          observed.timestamp(), row['VALUE'], precision='instant'))
    return latest(out)


def load_latvia(now):
    catalog = download('https://data.gov.lv/dati/api/3/action/package_show?id=hidrometeorologiskie-noverojumi')
    resources = {r['name']: r['url'] for r in catalog['result']['resources']}
    keys = ['Meteoroloģiskie operatīvie dati', 'Meteoroloģiskās stacijas', 'Meteoroloģiskie parametri']
    return parse_latvia(*(csv_rows(download(resources[key], False)) for key in keys))


def parse_lithuania(payload):
    s = payload['station']
    return latest(record('LT', s['code'], s['name'], s['coordinates']['latitude'], s['coordinates']['longitude'],
                         v['observationTimeUtc'].replace(' ', 'T')+'Z', v.get('snowDepth'), precision='instant')
                  for v in payload.get('observations', []))


def load_lithuania(now):
    base = 'https://api.meteo.lt/v1/stations'
    stations = download(base)
    def get(s):
        try:
            return parse_lithuania(download(base+'/'+s['code']+'/observations/latest'))
        except Exception as error:
            print('LT station unavailable:', s['code'], str(error)[:200], flush=True)
            return []
    # At most 180 requests/minute; four concurrent requests for the ~50 stations.
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        return latest(r for rows in pool.map(get, stations) for r in rows)


def parse_norway(payload, metadata):
    stations = {s['id']: s for s in metadata if 'MET.NO' in s.get('stationHolders', [])}
    out = []
    for row in payload.get('data') or []:
        code = row['sourceId'].split(':')[0]
        s = stations.get(code)
        if not s:
            continue
        for v in row.get('observations', []):
            # Exclude corrected/interpolated and unreliable readings; retain measured values.
            if v.get('elementId') != 'surface_snow_thickness' or v.get('unit') != 'cm' or v.get('qualityCode') not in (0, 2, 4):
                continue
            offset = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', v.get('timeOffset', 'PT0H'))
            if not offset:
                continue
            hours, minutes, seconds = (float(n or 0) for n in offset.groups())
            observed = timestamp(row['referenceTime']) + hours*3600 + minutes*60 + seconds
            lon, lat = s['geometry']['coordinates'][:2]
            out.append(record('NO', code, s.get('shortName') or s['name'], lat, lon, observed, v.get('value'),
                              'approved' if v['qualityCode'] == 0 else 'provisional', 'instant'))
    return latest(out)


def load_norway(now):
    # Public backend used by MET Norway's Seklima site; no borrowed API credentials.
    base = 'https://rim.k8s.met.no/api/v1/'
    start = (now-dt.timedelta(days=7)).strftime('%Y-%m-%d')
    end = (now+dt.timedelta(days=1)).strftime('%Y-%m-%d')
    params = dict(sourceName='', weatherElements='surface_snow_thickness', timeResolution='days',
                  **{'from': start, 'to': end}, includeRegions='false')
    metadata = download(base+'stations?'+urllib.parse.urlencode(params)).get('data') or []
    official = [s for s in metadata if 'MET.NO' in s.get('stationHolders', [])]
    out = []
    for i in range(0, len(official), 40):
        params = dict(sources=','.join(s['id'] for s in official[i:i+40]), referenceTime=start+'/'+end,
                      elements='surface_snow_thickness', timeResolution='days')
        try:
            out += parse_norway(download(base+'observations?'+urllib.parse.urlencode(params)), official)
        except Exception as error:
            print('NO station batch unavailable:', str(error)[:200], flush=True)
    return latest(out)


def parse_iceland(raw, metadata):
    out = []
    for line in raw.decode('latin-1').splitlines():
        fields = line.split(maxsplit=7)
        if len(fields) != 8 or fields[0] not in ('sk', 'ur'):
            continue
        _, code, day, clock, value, cover, mountains, name = fields
        s = metadata.get(code)
        if not s:
            continue
        observed = day+'T'+clock+'Z'  # Iceland uses UTC throughout the year.
        r = record('IS', code, name.strip(), s['lat'], s['lon'], observed, value, 'provisional', 'instant')
        if r:
            if cover in ('1', '2', '3'):
                r['note'] = 'Patchy ground cover; depth measured at station'
            out.append(r)
    return latest(out)


def load_iceland(now):
    raw = download('https://brunnur.vedur.is/athuganir/urkoma/snj0a.txt', False)
    cache_path = OUTPUT.parent/'iceland-snow-stations.json'
    metadata = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    codes = {fields[1] for line in raw.decode('latin-1').splitlines()
             if len(fields := line.split(maxsplit=7)) == 8 and number(fields[4]) is not None}
    def get(code):
        saved = metadata.get(code)
        if saved and now.timestamp()-saved.get('fetchedAt', 0) < 30*24*3600:
            return code, saved
        try:
            html = download('https://www.vedur.is/gogn/athuganir/stod/vst'+code+'.html', False).decode('latin-1')
            # Official station page gives north latitude and west longitude in decimal degrees.
            match = re.search(r'Staðsetning.*?\((\d+\.\d+),\s*(\d+\.\d+)\)', html, re.S)
            if not match:
                raise ValueError('Official station coordinates missing')
            return code, dict(lat=float(match[1]), lon=-float(match[2]), fetchedAt=int(now.timestamp()))
        except Exception as error:
            print('IS station metadata unavailable:', code, str(error)[:200], flush=True)
            return code, saved
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        for code, s in pool.map(get, sorted(codes)):
            if s:
                metadata[code] = s
    cache_path.parent.mkdir(exist_ok=True)
    cache_path.write_text(json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))+'\n')
    return parse_iceland(raw, metadata)


class NoRecentSnowData(ValueError):
    """A reachable official service has no current measurements for this region."""


def snow_features(base, params):
    url = base+'?'+urllib.parse.urlencode(params)
    for _ in range(12):
        payload = download(url)
        yield from payload.get('features') or []
        next_url = next((link.get('href') for link in payload.get('links', []) if link.get('rel') == 'next'), None)
        if not next_url:
            return
        if not next_url.startswith(base.split('/collections/')[0]+'/collections/'):
            raise ValueError('Unexpected snow-depth pagination host')
        url = next_url
    raise ValueError('Snow-depth pagination exceeded bounded observation window')


def parse_canada_snow(features, metadata):
    records = []
    for feature in features:
        props = feature.get('properties') or {}
        code = str(props.get('msc_id-value') or '')
        coords = (feature.get('geometry') or {}).get('coordinates') or []
        if code not in metadata or len(coords) < 2:
            continue
        for field in ('snw_dpth', 'avg_snw_dpth_pst5mts'):
            if props.get(field+'-qa') != 100 or props.get(field+'-uom') != 'cm':
                continue
            value = number(props.get(field))
            if value is None or not 0 <= value <= 1500:
                continue
            try:
                item = record('CA', code, metadata[code].get('name') or props.get('stn_nam-value') or code,
                              coords[1], coords[0], props['obs_date_tm'], value,
                              'approved', 'instant')
            except (ValueError, TypeError, KeyError):
                continue
            if item:
                records.append(item)
                break
    return latest(records)


def load_canada(now):
    base = 'https://api.weather.gc.ca/collections/'
    metadata = {}
    for feature in snow_features(base+'swob-stations/items', {'f': 'json', 'limit': 10000}):
        props = feature.get('properties') or {}
        if props.get('data_provider') == 'MSC':
            metadata[str(props.get('msc_id') or feature.get('id') or '')] = props
    fields = ['msc_id-value', 'stn_nam-value', 'obs_date_tm']
    for field in ('snw_dpth', 'avg_snw_dpth_pst5mts'):
        fields.extend([field, field+'-qa', field+'-uom'])
    params = {'f': 'json', 'limit': 10000, '_is-minutely_obs-value': 'false',
              'datetime': (now-dt.timedelta(days=1)).isoformat()+'/'+now.isoformat(),
              'sortby': '-obs_date_tm', 'properties': ','.join(fields)}
    return parse_canada_snow(snow_features(base+'swob-realtime/items', params), metadata)


def parse_greenland_snow(features, metadata):
    records = []
    for feature in features:
        props = feature.get('properties') or {}
        code = str(props.get('stationId') or '')
        station = metadata.get(code)
        if not station or props.get('parameterId') != 'snow_depth_man':
            continue
        coords = (feature.get('geometry') or {}).get('coordinates') or station['coords']
        if len(coords) < 2:
            continue
        try:
            item = record('GL', code, station['name'], coords[1], coords[0],
                          props['observed'], props.get('value'), 'provisional', 'instant')
        except (ValueError, TypeError, KeyError):
            continue
        if item:
            records.append(item)
    return latest(records)


def load_greenland(now):
    base = 'https://opendataapi.dmi.dk/v2/metObs/collections/'
    metadata = {}
    for feature in snow_features(base+'station/items', {'bbox': '-74,59,-10,85', 'limit': 1000, 'status': 'Active'}):
        props = feature.get('properties') or {}
        if props.get('country') != 'GRL' or props.get('validTo') or props.get('operationTo'):
            continue
        code = str(props.get('stationId') or '')
        metadata[code] = {'name': props.get('name') or code,
                          'coords': (feature.get('geometry') or {}).get('coordinates') or []}
    params = {'parameterId': 'snow_depth_man', 'bbox': '-74,59,-10,85', 'limit': 10000,
              'datetime': (now-dt.timedelta(days=7)).isoformat()+'/'+now.isoformat()}
    rows = parse_greenland_snow(snow_features(base+'observation/items', params), metadata)
    if not rows:
        raise NoRecentSnowData('DMI publishes no recent Greenland snow-depth measurements; missing data is not zero snow.')
    return rows


def main():
    now = dt.datetime.now(dt.timezone.utc)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
    providers, records = {}, []
    loaders = {'EE': load_estonia, 'FI': load_finland, 'SE': load_sweden,
               'LV': load_latvia, 'LT': load_lithuania, 'NO': load_norway, 'IS': load_iceland, 'CA': load_canada, 'GL': load_greenland}
    with futures.ThreadPoolExecutor(max_workers=7) as pool:
        jobs = {country: pool.submit(load, now) for country, load in loaders.items()}
        for country, job in jobs.items():
            try:
                rows = job.result()
                if not rows:
                    raise ValueError('No valid recent official snow-depth records')
                providers[country] = {'status': 'ok', 'fetchedAt': int(now.timestamp()), 'count': len(rows)}
            except Exception as error:
                print(country, 'snow depth unavailable:', error, flush=True)
                rows = [r for r in previous.get('stations', []) if r['country'] == country]
                providers[country] = {'status': 'no-data' if isinstance(error, NoRecentSnowData) else 'unavailable', 'error': str(error), 'count': len(rows)}
            # Never relabel retained readings as newly observed; exclude >7 days.
            records += [s for s in rows if 0 <= now.timestamp()-s['time'] <= 7*24*3600]
            print(country, 'published snow stations:', sum(s['country'] == country for s in records), flush=True)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({'generatedAt': int(now.timestamp()), 'sources': SOURCES,
                                 'providers': providers, 'stations': latest(records)}, ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
