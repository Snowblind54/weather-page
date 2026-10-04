"""Collect official hourly precipitation; missing hours are never recorded as zero.

National precipitation gauges include the water equivalent of snow. The browser
labels that separately from Open-Meteo's rain + showers fallback. Retain 72 hours
so all three rolling periods can follow the two-hour map timeline.
"""
import concurrent.futures as futures
import csv
import datetime as dt
import gzip
from html.parser import HTMLParser
import io
import json
import math
import pathlib
import re
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
    'LV': ('LVĢMC', 'https://data.gov.lv/dati/dataset/hidrometeorologiskie-noverojumi'),
    'IS': ('Icelandic Meteorological Office (IMO)', 'https://www.vedur.is/gogn/athuganir/urkoma.html'),
    'NO': ('MET Norway / Seklima', 'https://seklima.met.no/observations/'),
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


def csv_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def parse_latvia(rows, metadata):
    names = {s['STATION_ID']: s for s in metadata}
    grouped = {}
    for row in rows:
        code = row['STATION_ID']
        if row.get('ABBREVIATION') != 'HPRAB' or code not in names:
            continue
        # LVĢMC HPRAB is the preceding hour in mm; timestamps are UTC.
        value = amount(row.get('VALUE'))
        if value is None or value > 250:
            continue
        date = str(row['DATETIME'])
        if re.match(r'^\d{4}\.\d{2}\.\d{2} ', date):
            date = dt.datetime.strptime(date, '%Y.%m.%d %H:%M:%S').isoformat()
        grouped.setdefault(code, []).append((date, value, False))
    # GEOGR1/2 are decimal longitude/latitude; LATITUDE/LONGITUDE are DMS.
    return [station('LV', code, names[code]['NAME'], names[code]['GEOGR2'], names[code]['GEOGR1'], values)
            for code, values in grouped.items()]


def load_latvia(now, previous):
    base = 'https://data.gov.lv/dati/'
    package = base + 'dataset/40d80be5-0c09-47c4-80f3-fad4bec19f33/resource/'
    metadata = csv_rows(download(package + 'c32c7afd-0d05-44fd-8b24-1de85b4bf11d/download/meteo_stacijas.csv', False))
    recent = csv_rows(download(package + '17460efb-ae99-4d1d-8144-1068f184b05f/download/meteo_operativie_dati.csv', False))
    archive = []
    try:
        start = (now-dt.timedelta(hours=56)).strftime('%Y-%m-%dT%H:%M:%S')
        end = now.strftime('%Y-%m-%dT%H:%M:%S')
        sql = ('SELECT "STATION_ID", "ABBREVIATION", "DATETIME", "VALUE" '
               'FROM "ecc62e27-2071-483c-bca9-5e53d979faa8" '
               'WHERE "ABBREVIATION" = \'HPRAB\' '
               f'AND "DATETIME" BETWEEN \'{start}\' AND \'{end}\' ORDER BY "DATETIME" LIMIT 5000')
        data = download(base + 'api/3/action/datastore_search_sql?' + urllib.parse.urlencode({'sql': sql}))
        if not data.get('success'):
            raise ValueError('LVĢMC archive query failed')
        archive = data['result']['records']
        if len(archive) >= 5000:
            raise ValueError('LVĢMC archive query exceeded limit')
    except Exception as error:
        # The recent file and retained histories still supply valid windows.
        print('LV archive unavailable', error, flush=True)
        archive = []
    return parse_latvia(archive + recent, metadata)


class IcelandRainTable(HTMLParser):
    """Read the official table structurally, preserving paired interval columns."""
    def __init__(self):
        super().__init__()
        self.rows, self.cells, self.text, self.code = [], [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.cells, self.code = [], None
        elif tag in ('td', 'th'):
            self.text = []
        elif tag == 'a':
            match = re.search(r'[?&]sid=(\d+)', dict(attrs).get('href', ''))
            if match:
                self.code = match[1]

    def handle_data(self, data):
        if self.text is not None:
            self.text.append(data)

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.text is not None:
            self.cells.append(''.join(self.text).strip())
            self.text = None
        elif tag == 'tr' and self.cells:
            self.rows.append((self.code, self.cells))


def parse_iceland(raw, metadata):
    text = raw.decode('utf-8') if isinstance(raw, bytes) else raw
    match = re.search(r'Uppsöfnuð úrkoma \(mm\) til (\d{4}-\d{2}-\d{2}) kl\. (\d{1,2}):', text)
    if not match:
        raise ValueError('IMO accumulation timestamp missing')
    # Iceland uses UTC throughout the year.
    end = unix(match[1] + 'T' + match[2].zfill(2) + ':00:00Z')
    table = IcelandRainTable()
    table.feed(text)
    expected = ['Nafn:', '1 klst', '6 klst', '6/12 klst', '12/24 klst', '24/48 klst']
    if not any(cells[:6] == expected for code, cells in table.rows if code is None):
        raise ValueError('IMO accumulation columns changed')
    stations = {str(s['station']): s for s in metadata}
    records = []
    for code, cells in table.rows:
        if code not in stations or len(cells) < 6:
            continue
        totals = []
        for hours, column in ((1, 1), (24, 4), (48, 5)):
            parts = cells[column].split('/')
            if len(parts) != (1 if hours == 1 else 2):
                continue
            values = [amount(part) for part in parts]
            # 9999 and negative corrections/missing values must not become rain.
            if any(value is None for value in values):
                continue
            totals.append({'end': end, 'hours': hours, 'value': values[-1]})
        if not totals:
            continue
        meta = stations[code]
        rows = [(end, t['value'], False) for t in totals if t['hours'] == 1]
        s = station('IS', code, cells[0], meta['lat'], meta['lon'], rows)
        # Store published long totals separately: never manufacture hourly data.
        s['accumulations'] = [t for t in totals if t['hours'] != 1]
        records.append(s)
    return records


def load_iceland(now, previous):
    metadata = download('https://api.vedur.is/weather/stations?active=true&station_type=sj')
    return parse_iceland(download(SOURCES['IS'][1], False), metadata)


def parse_norway(payload, metadata):
    """Measured hourly sums, with Frost referenceTime as the period's end.

    Hourly timestamps already contain the observation time: unlike some daily
    observations, timeOffset must not be added. Keep the primary sensor/series
    and measured quality codes, excluding corrected or interpolated values.
    """
    stations = {s['id']: s for s in metadata if 'MET.NO' in s.get('stationHolders', [])}
    grouped = {}
    for row in payload.get('data') or []:
        source = row['sourceId'].split(':')
        code = source[0]
        if code not in stations or (len(source) > 1 and source[1] != '0'):
            continue
        for observation in row.get('observations') or []:
            if (observation.get('elementId') != 'sum(precipitation_amount PT1H)' or
                    observation.get('unit') != 'mm' or observation.get('timeResolution') != 'PT1H' or
                    observation.get('qualityCode') not in (0, 2, 4) or
                    observation.get('timeSeriesId', 0) != 0):
                continue
            value = amount(observation.get('value'))
            if value is None:
                continue
            grouped.setdefault(code, []).append((row['referenceTime'], value, False))
    records = []
    for code, rows in grouped.items():
        s = stations[code]
        lon, lat = s['geometry']['coordinates'][:2]
        if not (48 <= lat <= 72.5 and -26 <= lon <= 33):
            continue
        records.append(station('NO', code, s.get('shortName') or s['name'], lat, lon, rows))
    return records


def load_norway(now, previous):
    # Public backend used by Seklima; no borrowed credentials or browser proxy.
    base = 'https://rim.k8s.met.no/api/v1/'
    old = [s for s in previous if s['country'] == 'NO']
    complete = old and all(len(s['times']) >= 48 and s['times'][-1] >= unix(now)-24*3600 for s in old)
    start = (now-dt.timedelta(hours=24 if complete else 72)).date().isoformat()
    end = (now+dt.timedelta(days=1)).date().isoformat()
    params = dict(sourceName='', weatherElements='sum(precipitation_amount PT1H)',
                  timeResolution='hours', **{'from': start, 'to': end}, includeRegions='false')
    metadata = download(base+'stations?'+urllib.parse.urlencode(params)).get('data') or []
    official = [s for s in metadata if 'MET.NO' in s.get('stationHolders', []) and
                s.get('geometry', {}).get('coordinates') and
                48 <= s['geometry']['coordinates'][1] <= 72.5 and
                -26 <= s['geometry']['coordinates'][0] <= 33]
    def collect(batch):
        params = dict(sources=','.join(s['id'] for s in batch), referenceTime=start+'/'+end,
                      elements='sum(precipitation_amount PT1H)', timeResolution='hours')
        try:
            return parse_norway(download(base+'observations?'+urllib.parse.urlencode(params)), batch)
        except Exception as error:
            print('NO rainfall batch unavailable:', str(error)[:200], flush=True)
            return []
    batches = [official[i:i+40] for i in range(0, len(official), 40)]
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        return [s for records in pool.map(collect, batches) for s in records]


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
        target = merged.setdefault(key, {**s, '_hours': {}, '_traces': set(), '_totals': {}})
        # New metadata wins; revising a reading replaces it rather than adding it.
        target.update({k: s[k] for k in ('name', 'lat', 'lon')})
        for t, n in zip(s['times'], s['amounts']):
            if cutoff <= t <= end and t % 3600 == 0 and amount(n) is not None:
                target['_hours'][t] = n
                target['_traces'].discard(t)
                if t in s.get('traces', []):
                    target['_traces'].add(t)
        for total in s.get('accumulations', []):
            t, hours, value = total['end'], total['hours'], amount(total['value'])
            if cutoff <= t <= end and t % 3600 == 0 and hours in (24, 48) and value is not None:
                target['_totals'][(t, hours)] = {'end': t, 'hours': hours, 'value': value}
    result = []
    for s in merged.values():
        hours, traces, totals = s.pop('_hours'), s.pop('_traces'), s.pop('_totals')
        if not hours and not totals:
            continue
        s['times'] = sorted(hours)
        s['amounts'] = [hours[t] for t in s['times']]
        s['traces'] = sorted(traces.intersection(hours))
        if 'accumulations' in s or totals:
            s['accumulations'] = [totals[key] for key in sorted(totals)]
        result.append(s)
    return sorted(result, key=lambda s: (s['country'], s['code']))


LOADERS = {'EE': load_estonia, 'LT': load_lithuania, 'FI': load_finland, 'SE': load_sweden, 'DK': load_denmark,
           'LV': load_latvia, 'IS': load_iceland, 'NO': load_norway}


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
            if not any(s['times'] or s.get('accumulations') for s in records):
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
