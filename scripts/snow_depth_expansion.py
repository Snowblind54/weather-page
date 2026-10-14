"""Additional official snow-depth sources; no inferred snow-free readings."""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib
import urllib.parse


class SnowDepthExpansion:
    def __init__(self, download, record, latest, no_data, previous=None):
        self.download, self.record, self.latest, self.no_data = download, record, latest, no_data
        self.previous = previous or []

    def parse_dwd(self, raw, code, station):
        rows = list(csv.reader(io.StringIO(raw.decode('latin1')), delimiter=';'))
        if len(rows) < 3 or 'total_snow_depth' not in rows[0]:
            raise ValueError('DWD snow-depth column missing')
        index = rows[0].index('total_snow_depth')
        if len(rows[1]) <= index or rows[1][index] != 'cm' or rows[1][0] != code:
            raise ValueError('DWD station or snow-depth unit mismatch')
        records = []
        for row in rows[3:]:
            if len(row) <= index or row[index].strip() in ('', '---'):
                continue
            try:
                time = dt.datetime.strptime(row[0]+' '+row[1], '%d.%m.%y %H:%M').replace(tzinfo=dt.timezone.utc)
                value = float(row[index].replace(',', '.'))
                # DWD's special/non-numeric states must not become large depths.
                if value >= 997:
                    continue
                item = self.record(station['country'], code, station['name'], station['lat'], station['lon'],
                                   time.isoformat(), value, 'provisional', 'instant')
                if item:
                    item['note'] = 'Official station observation distributed by DWD; reporting coverage varies.'
                    records.append(item)
            except (ValueError, TypeError):
                continue
        return self.latest(records)

    def load_dwd(self, country, now):
        meta = json.loads((pathlib.Path(__file__).parents[1]/'data/snow-dwd-stations.json').read_text())['stations']
        stations = {k: v for k, v in meta.items() if v['country'] == country}
        rows, failed = [], []
        def load(code):
            return self.parse_dwd(self.download('https://opendata.dwd.de/weather/weather_reports/poi/'+code+'-BEOB.csv', False), code, stations[code])
        with futures.ThreadPoolExecutor(max_workers=5) as pool:
            jobs = {code: pool.submit(load, code) for code in stations}
            for code, job in jobs.items():
                try:
                    rows.extend(job.result())
                except Exception:
                    failed.append(code)
                    rows.extend(s for s in self.previous if s['country'] == country and s['code'] == code)
        if not rows:
            if failed:
                raise ValueError('Some DWD station files unavailable; last successful readings retained')
            raise self.no_data('No recent reported snow depths in the DWD official station subset; omitted values are not zero.')
        return self.latest(rows)

    def load_poland(self, now):
        return self.load_dwd('PL', now)

    def load_uk(self, now):
        return self.load_dwd('UK', now)

    def parse_denmark(self, features, metadata):
        rows = []
        for feature in features:
            p = feature.get('properties') or {}
            code = str(p.get('stationId') or '')
            station = metadata.get(code)
            if not station or p.get('parameterId') != 'snow_depth_man':
                continue
            coords = (feature.get('geometry') or {}).get('coordinates') or station['coords']
            if len(coords) < 2:
                continue
            try:
                item = self.record('DK', code, station['name'], coords[1], coords[0], p['observed'], p.get('value'), 'provisional', 'instant')
                if item:
                    rows.append(item)
            except (ValueError, TypeError, KeyError):
                continue
        return self.latest(rows)

    def load_denmark(self, now):
        base = 'https://opendataapi.dmi.dk/v2/metObs/collections/'
        def features(endpoint, params):
            url = base+endpoint+'?'+urllib.parse.urlencode(params)
            for _ in range(12):
                data = self.download(url)
                yield from data.get('features', [])
                url = next((l.get('href') for l in data.get('links', []) if l.get('rel') == 'next'), None)
                if not url:
                    return
                if not url.startswith(base):
                    raise ValueError('Unexpected DMI pagination host')
            raise ValueError('DMI pagination exceeded bounded window')
        meta = {}
        for feature in features('station/items', {'bbox': '7,54,16,58', 'limit': 10000, 'status': 'Active'}):
            p = feature.get('properties') or {}
            if p.get('country') == 'DNK' and not p.get('operationTo') and not p.get('validTo'):
                meta[str(p['stationId'])] = {'name': p.get('name') or p['stationId'], 'coords': feature['geometry']['coordinates']}
        params = {'parameterId': 'snow_depth_man', 'bbox': '7,54,16,58', 'limit': 10000,
                  'datetime': (now-dt.timedelta(days=7)).isoformat()+'/'+now.isoformat()}
        rows = self.parse_denmark(features('observation/items', params), meta)
        if not rows:
            raise self.no_data('DMI has no recent Danish manual snow-depth readings.')
        return rows

    def parse_ireland(self, features, metadata):
        rows = []
        for feature in features:
            p = feature.get('properties') or {}
            code = str(p.get('station_id') or '')
            station = metadata.get(code)
            if not station or p.get('parameter_name') != 'snow_depth' or p.get('value_num') is None:
                continue
            try:
                # The official EDR parameter is metres. Negative sensor readings
                # and missing values are excluded, not clamped to zero.
                value = float(p['value_num'])
                if value < 0:
                    continue
                coords = station['coords']
                item = self.record('IE', code, station['name'], coords[1], coords[0], p['observed_at'], value*100, 'provisional', 'instant')
                if item:
                    rows.append(item)
            except (ValueError, TypeError, KeyError):
                continue
        return self.latest(rows)

    def load_ireland(self, now):
        base = 'https://opendata2.met.ie/edr/collections/observations-swob-nrt-60min/'
        meta = {str(f['properties']['station_id']): {'name': f['properties']['station_name'], 'coords': f['geometry']['coordinates']}
                for f in self.download(base+'locations?f=json')['features']}
        params = {'bbox': '-11,51,-5,56', 'z': '0/1000', 'parameter-name': 'snow_depth',
                  'datetime': (now-dt.timedelta(hours=24)).isoformat()+'/'+now.isoformat(), 'limit': 10000}
        data = self.download(base+'cube?'+urllib.parse.urlencode(params))
        if any(l.get('rel') == 'next' for l in data.get('links', [])):
            raise ValueError('Irish snow-depth response truncated')
        rows = self.parse_ireland(data.get('features', []), meta)
        if not rows:
            raise self.no_data('Met Éireann has no recent reported snow depths.')
        return rows

    def parse_usa(self, payload, metadata):
        rows = []
        for station_data in payload:
            code = station_data.get('stationTriplet')
            station = metadata.get(code)
            if not station or station.get('networkCode') not in ('SNTL', 'SCAN') or station.get('operator') != 'NRCS':
                continue
            for series in station_data.get('data', []):
                element = series.get('stationElement') or {}
                if element.get('elementCode') != 'SNWD' or element.get('storedUnitCode') != 'in' or element.get('durationName') != 'DAILY' or element.get('derivedData') or element.get('ordinal') != 1:
                    continue
                for value in series.get('values', []):
                    # Reject suspect, missing, and estimated values. E means
                    # a minor edit for sensor noise, C a corrected calibration.
                    if value.get('qcFlag') not in ('V', 'N', 'E', 'C') or value.get('qaFlag') not in ('R', 'P', 'A') or value.get('value') is None:
                        continue
                    try:
                        time = dt.datetime.fromisoformat(value['date']).replace(tzinfo=dt.timezone(dt.timedelta(hours=float(station['dataTimeZone']))))
                        item = self.record('US', code, station['name'], station['latitude'], station['longitude'],
                                           time.isoformat(), float(value['value'])*2.54, 'approved' if value['qaFlag'] == 'A' else 'provisional', 'instant')
                        if item:
                            item['note'] = 'NRCS '+station['networkCode']+' daily snow depth at start of day in the station’s fixed reporting time zone. Coverage includes western USA, Alaska and selected SCAN sites elsewhere.'
                            rows.append(item)
                    except (ValueError, TypeError, KeyError):
                        continue
        return self.latest(rows)

    def load_usa(self, now):
        base = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/'
        params = {'stationTriplets': '*:*:SNTL,*:*:SCAN', 'elements': 'SNWD', 'activeOnly': 'true'}
        meta = {s['stationTriplet']: s for s in self.download(base+'stations?'+urllib.parse.urlencode(params))}
        params = {'stationTriplets': '*:*:SNTL,*:*:SCAN', 'elements': 'SNWD', 'duration': 'DAILY', 'periodRef': 'START',
                  'beginDate': (now-dt.timedelta(days=3)).date().isoformat(), 'endDate': now.date().isoformat(),
                  'returnFlags': 'true', 'returnSuspectData': 'false'}
        rows = self.parse_usa(self.download(base+'data?'+urllib.parse.urlencode(params)), meta)
        if not rows:
            raise self.no_data('NRCS has no recent accepted SNOTEL snow depths.')
        return rows
