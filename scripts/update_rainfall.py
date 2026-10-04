"""Collect official hourly precipitation; missing hours are never recorded as zero.

National precipitation gauges include the water equivalent of snow. The browser
labels that separately from Open-Meteo's rain + showers fallback. Retain 72 hours
so all three rolling periods can follow the two-hour map timeline.
"""
import concurrent.futures as futures
import datetime as dt
import gzip
import json
import math
import pathlib
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/official-rainfall.json'
SOURCES = {
    'EE': ('Estonian Environment Agency', 'https://www.ilmateenistus.ee/teenused/ilmainfo/eesti-vaatlusandmed-xml/'),
    'LT': ('Meteo.lt / LHMT', 'https://api.meteo.lt/'),
    'FI': ('Finnish Meteorological Institute', 'https://en.ilmatieteenlaitos.fi/open-data-manual-fmi-wfs-services'),
    'SE': ('SMHI', 'https://opendata.smhi.se/'),
    'DK': ('Danish Meteorological Institute', 'https://www.dmi.dk/friedata/dokumentation/meteorological-observations-data'),
}


def download(url, json_data=True):
    req = urllib.request.Request(url, headers={'User-Agent': 'BalticWeatherMap/8.15', 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=35) as response:
        raw = response.read()
    if raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    return json.loads(raw) if json_data else raw


def unix(value):
    if isinstance(value, (int, float)):
        return int(value / 1000 if value > 1e11 else value)
    date = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return int(date.replace(tzinfo=dt.timezone.utc).timestamp() if date.tzinfo is None else date.timestamp())


def amount(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) and 0 <= n <= 1000 else None
    except (TypeError, ValueError):
        return None


def station(country, code, name, lat, lon, rows):
    lat, lon = float(lat), float(lon)
    if not (48 <= lat <= 72.5 and -26 <= lon <= 33):
        raise ValueError('Invalid precipitation station coordinates')
    readings, traces = {}, set()
    for time, value, trace in rows:
        time = unix(time)
        n = amount(value)
        if time % 3600 or n is None:
            continue
        readings[time] = n
        if trace:
            traces.add(time)
    return {'country': country, 'code': str(code), 'name': str(name), 'lat': lat, 'lon': lon,
            'times': sorted(readings), 'amounts': [readings[t] for t in sorted(readings)], 'traces': sorted(traces)}


def parse_estonia(raw):
    root = ET.fromstring(raw)
    # This is a snapshot timestamp: the hourly precipitation is published at :10.
    # Floor it to the completed hour, never infer the hour from collection time.
    time = (unix(float(root.attrib['timestamp'])) - 600) // 3600 * 3600
    records = []
    for s in root.findall('station'):
        if amount(s.findtext('precipitations')) is None:
            continue
        records.append(station('EE', s.findtext('wmocode') or s.findtext('name'), s.findtext('name'),
                               s.findtext('latitude'), s.findtext('longitude'),
                               [(time, s.findtext('precipitations'), False)]))
    return records


def load_estonia(now, previous):
    return parse_estonia(download('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php', False))


def parse_lithuania(payload):
    s = payload['station']
    return station('LT', s['code'], s['name'], s['coordinates']['latitude'], s['coordinates']['longitude'],
                   [(o['observationTimeUtc'], o.get('precipitation'), False) for o in payload['observations']])


def lithuania_jobs(stations,now,previous):
    prior={s['code']:s for s in previous if s['country']=='LT'}
    start=now-dt.timedelta(hours=56)
    dates=[(start.date()+dt.timedelta(days=i)).isoformat() for i in range((now.date()-start.date()).days+1)]
    jobs=[]
    for s in stations:
        old=prior.get(s['code'])
        # The latest endpoint supplies the previous 24 hours. Reuse the archive
        # for earlier hours instead of repeatedly downloading every station/day.
        recent=old and len(old['times'])>=48 and old['times'][-1]>=int(now.timestamp())-24*3600
        jobs.extend([(s['code'],'latest')] if recent else [(s['code'],date) for date in dates])
    return jobs


def load_lithuania(now, previous):
    base = 'https://api.meteo.lt/v1'
    lock,next_request=threading.Lock(),[0.0]
    def get_data(url):
        # LHMT permits 180 requests/minute; leave headroom for other clients.
        with lock:
            time.sleep(max(0,next_request[0]-time.monotonic()))
            next_request[0]=time.monotonic()+0.5
        return download(url)
    stations = get_data(base + '/stations')
    jobs = lithuania_jobs(stations,now,previous)
    records = []
    def get(job):
        code, date = job
        try:
            return parse_lithuania(get_data(base + '/stations/' + code + '/observations/' + date))
        except Exception as error:
            print('LT station skipped', code, date, error, flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        records = [s for s in pool.map(get, jobs) if s and s['times']]
    return records


def parse_finland(raw):
    root = ET.fromstring(raw)
    grouped = {}
    for el in root.iter():
        if el.tag.split('}')[-1] != 'BsWfsElement':
            continue
        fields = {child.tag.split('}')[-1]: (child.text or '').strip() for child in el.iter()}
        if fields.get('ParameterName', '').lower() != 'r_1h':
            continue
        lat, lon = map(float, fields['pos'].split())
        code = f'{lat:.5f},{lon:.5f}'
        grouped.setdefault(code, [lat, lon, []])[2].append((fields['Time'], fields['ParameterValue'], False))
    return [station('FI', code, 'FMI gauge ' + code, lat, lon, rows) for code, (lat, lon, rows) in grouped.items()]


def load_finland(now, previous):
    params = dict(service='WFS', version='2.0.0', request='getFeature',
                  storedquery_id='fmi::observations::weather::hourly::simple', bbox='19,59,32,71.7',
                  starttime=(now-dt.timedelta(hours=56)).isoformat(), endtime=now.isoformat(),
                  timestep='60', parameters='r_1h')
    return parse_finland(download('https://opendata.fmi.fi/wfs?' + urllib.parse.urlencode(params), False))


def parse_sweden(s, values):
    return station('SE', s['key'], s['name'], s['latitude'], s['longitude'],
                   [(v['date'], v.get('value') if v.get('quality') == 'G' else None, False) for v in values])


def load_sweden(now, previous):
    base = 'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/7'
    payload = download(base + '/station-set/all/period/latest-hour/data.json')
    if str(payload['parameter']['key']) != '7' or payload['parameter']['unit'] not in ('millimeter', 'millimetre'):
        raise ValueError('SMHI hourly precipitation parameter missing')
    prior = {s['code']: s for s in previous if s['country'] == 'SE'}
    def get(s):
        rows = s.get('value', [])
        # Bootstrap once from station history, thereafter only last-day records.
        old = prior.get(str(s['key']))
        period = 'latest-day' if old and len(old['times']) >= 48 and old['times'][-1]>=int(now.timestamp())-24*3600 else 'latest-months'
        try:
            data = download(base + '/station/' + str(s['key']) + '/period/' + period + '/data.json')
            rows = data['value']
        except Exception as error:
            print('SE history skipped', s['key'], error, flush=True)
        return parse_sweden(s, rows)
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(get, payload['station']))


def parse_denmark(payload, metadata=None):
    grouped = {}
    for f in payload.get('features', []):
        o = f['properties']
        if o.get('parameterId') != 'precip_past1h':
            continue
        code = o['stationId']
        lon, lat = f['geometry']['coordinates'][:2]
        trace = o.get('value') == -0.1
        grouped.setdefault(code, [lat, lon, []])[2].append((o['observed'], 0 if trace else o.get('value'), trace))
    names = metadata or {}
    return [station('DK', code, names.get(code, 'DMI ' + code), lat, lon, rows)
            for code, (lat, lon, rows) in grouped.items()]


def load_denmark(now, previous):
    base = 'https://opendataapi.dmi.dk/v2/metObs/collections/'
    names = {}
    try:
        meta = download(base + 'station/items?bbox=7.5,54.4,15.6,58&limit=1000')
        for f in meta['features']:
            p = f['properties']
            if p.get('country') == 'DNK' and p.get('status') == 'Active':
                names[p['stationId']] = p['name']
    except Exception as error:
        print('DMI metadata unavailable', error, flush=True)
    params = dict(parameterId='precip_past1h', bbox='7.5,54.4,15.6,58',
                  datetime=(now-dt.timedelta(hours=56)).isoformat()+'/'+now.isoformat(), limit='10000')
    url = base + 'observation/items?' + urllib.parse.urlencode(params)
    rows = []
    for _ in range(6):
        data = download(url)
        if not data.get('features'):
            break
        rows.extend(parse_denmark(data, names))
        next_url = next((l['href'] for l in data.get('links', []) if l.get('rel') == 'next'), None)
        if not next_url or not next_url.startswith(base):
            break
        url = next_url
    else:
        raise ValueError('DMI pagination exceeded limit')
    return rows


def merge(previous, incoming, now):
    cutoff = int(now.timestamp()) - 72 * 3600
    end = int(now.timestamp()) // 3600 * 3600
    merged = {}
    for s in previous + incoming:
        key = s['country'] + '|' + s['code']
        target = merged.setdefault(key, {**s, '_hours': {}, '_traces': set()})
        # New metadata wins; revising a reading replaces it rather than adding it.
        target.update({k: s[k] for k in ('name', 'lat', 'lon')})
        for t, n in zip(s['times'], s['amounts']):
            if cutoff <= t <= end and t % 3600 == 0 and amount(n) is not None:
                target['_hours'][t] = n
                target['_traces'].discard(t)
                if t in s.get('traces', []):
                    target['_traces'].add(t)
    result = []
    for s in merged.values():
        hours, traces = s.pop('_hours'), s.pop('_traces')
        if not hours:
            continue
        s['times'] = sorted(hours)
        s['amounts'] = [hours[t] for t in s['times']]
        s['traces'] = sorted(traces.intersection(hours))
        result.append(s)
    return sorted(result, key=lambda s: (s['country'], s['code']))


LOADERS = {'EE': load_estonia, 'LT': load_lithuania, 'FI': load_finland, 'SE': load_sweden, 'DK': load_denmark}


def main():
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    try:
        old = json.loads(OUTPUT.read_text())
        previous = old['stations'] if old.get('version') == 1 else []
    except (OSError, ValueError, KeyError):
        previous = []
    incoming, states = [], {}
    def collect(item):
        code, loader = item
        try:
            records = loader(now, previous)
            if not any(s['times'] for s in records):
                raise ValueError('No measured hourly precipitation returned')
            return code, records, None
        except Exception as error:
            return code, [], str(error)
    with futures.ThreadPoolExecutor(max_workers=5) as pool:
        for code, records, error in pool.map(collect, LOADERS.items()):
            incoming.extend(records)
            states[code] = {'name': SOURCES[code][0], 'url': SOURCES[code][1], 'status': 'error' if error else 'ok',
                            'checkedAt': int(dt.datetime.now(dt.timezone.utc).timestamp()), 'error': error}
            print(code, len(records), error or 'ok', flush=True)
    stations = merge(previous, incoming, now)
    result = dict(version=1, generatedAt=int(dt.datetime.now(dt.timezone.utc).timestamp()), sources=states, stations=stations)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    print('Published', len(stations), 'gauges', flush=True)


if __name__ == '__main__':
    main()
