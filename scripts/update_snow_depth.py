"""Collect official station snow depth, preserving dates and non-numeric states."""
import concurrent.futures as futures
import datetime as dt
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
}


def download(url, as_json=True):
    headers = {'User-Agent': 'NorthernWeather/8.41', 'Accept-Encoding': 'gzip'}
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
    if parsed is None or lat is None or lon is None or not (53 <= lat <= 72 and 10 <= lon <= 33):
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


def main():
    now = dt.datetime.now(dt.timezone.utc)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
    providers, records = {}, []
    loaders = {'EE': load_estonia, 'FI': load_finland, 'SE': load_sweden}
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
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
                providers[country] = {'status': 'unavailable', 'error': str(error), 'count': len(rows)}
            # Never relabel retained readings as newly observed; exclude >72 h.
            records += [s for s in rows if 0 <= now.timestamp()-s['time'] <= 72*3600]
            print(country, 'published snow stations:', sum(s['country'] == country for s in records), flush=True)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({'generatedAt': int(now.timestamp()), 'sources': SOURCES,
                                 'providers': providers, 'stations': latest(records)}, ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
