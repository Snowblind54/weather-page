"""Official gauge parsing, missing hours, traces and history replacement."""
import datetime as dt
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import update_rainfall as rain

NOW = dt.datetime(2026, 10, 3, 10, tzinfo=dt.timezone.utc)
END = int(NOW.timestamp())


class Rainfall(unittest.TestCase):
    def test_norway_measured_primary_hourly_sums_keep_reference_time_and_gaps(self):
        meta = [{'id': 'SN18700', 'name': 'Oslo', 'stationHolders': ['MET.NO'],
                 'geometry': {'coordinates': [10.7, 59.9]}},
                {'id': 'PRIVATE', 'name': 'Private', 'stationHolders': ['Other'],
                 'geometry': {'coordinates': [10.7, 59.9]}}]
        def row(time, value, **overrides):
            observation = dict(elementId='sum(precipitation_amount PT1H)', value=value,
                               unit='mm', timeResolution='PT1H', timeOffset='PT1H',
                               qualityCode=0, timeSeriesId=0)
            observation.update(overrides)
            return dict(sourceId='SN18700:0', referenceTime=time, observations=[observation])
        rows = [row('2026-10-03T10:00:00Z', 1.2), row('2026-10-03T09:00:00Z', 0),
                row('2026-10-03T08:00:00Z', None), row('2026-10-03T07:00:00Z', -1),
                row('2026-10-03T06:00:00Z', 99, qualityCode=1),
                row('2026-10-03T05:00:00Z', 99, timeSeriesId=1),
                row('2026-10-03T04:00:00Z', 99, elementId='sum(precipitation_amount P1D)')]
        alternate = row('2026-10-03T10:00:00Z', 99); alternate['sourceId'] = 'SN18700:1'; rows.append(alternate)
        private = row('2026-10-03T10:00:00Z', 99); private['sourceId'] = 'PRIVATE:0'; rows.append(private)
        s = rain.parse_norway({'data': rows}, meta)[0]
        self.assertEqual((s['country'], s['lat'], s['lon']), ('NO', 59.9, 10.7))
        self.assertEqual(s['times'], [END-3600, END])
        self.assertEqual(s['amounts'], [0, 1.2])

    def test_norway_loader_batches_public_requests_without_credentials(self):
        from unittest.mock import patch
        from urllib.parse import parse_qs, urlsplit
        requests = []
        def download(url):
            requests.append(url)
            if '/stations?' in url:
                return {'data': [{'id': 'SN18700', 'name': 'Oslo', 'stationHolders': ['MET.NO'],
                                  'geometry': {'coordinates': [10.7, 59.9]}}]}
            return {'data': []}
        with patch.object(rain, 'download', download):
            self.assertEqual(rain.load_norway(NOW, []), [])
        self.assertEqual(len(requests), 2)
        query = parse_qs(urlsplit(requests[-1]).query)
        self.assertEqual(query['elements'], ['sum(precipitation_amount PT1H)'])
        self.assertEqual(query['referenceTime'], ['2026-09-30/2026-10-04'])
        self.assertNotIn('client', requests[-1])

    def test_latvia_hourly_utc_decimal_coordinates_and_missing_values(self):
        meta = [{'STATION_ID': 'a', 'NAME': 'Rīga', 'GEOGR1': '24.1', 'GEOGR2': '56.9',
                 'LATITUDE': '565400', 'LONGITUDE': '0240600'}]
        def row(date, value, param='HPRAB'):
            return dict(STATION_ID='a', ABBREVIATION=param, DATETIME=date, VALUE=value)
        records = rain.parse_latvia([row('2026.10.03 09:00:00', '0'), row('2026-10-03T10:00:00', 2.3),
                                    row('2026.10.03 08:00:00', ''), row('2026.10.03 07:00:00', '-999'),
                                    row('2026.10.03 06:00:00', '9999'), row('2026.10.03 05:00:00', 5, 'HTDRY')], meta)
        s = records[0]
        self.assertEqual((s['lat'], s['lon']), (56.9, 24.1))
        self.assertEqual(s['times'], [END-3600, END])
        self.assertEqual(s['amounts'], [0, 2.3])

    def test_iceland_published_totals_are_not_synthetic_hours(self):
        raw = '''<h4>Uppsöfnuð úrkoma (mm) til 2026-10-03 kl. 10:</h4><table>
          <tr><th>Nafn:</th><th>1 klst</th><th>6 klst</th><th>6/12 klst</th><th>12/24 klst</th><th>24/48 klst</th></tr>
          <tr><td><a href="https://vedur.is/?sid=1">Bláfjöll</a></td><td>0.6</td><td>5</td><td>4.8/9.8</td><td>55.4/65.2</td><td>12.8/78.0</td></tr>
          <tr><td><a href="https://vedur.is/?sid=2">Missing</a></td><td>9999</td><td>5</td><td>4.8/9.8</td><td>9999/65.2</td><td>1/3</td></tr>
          <tr><td><a href="https://vedur.is/?sid=3">Correction</a></td><td>-0.1</td><td>5</td><td>4.8/9.8</td><td>-0.1/1</td><td>-0.1/2</td></tr></table>'''
        meta = [dict(station=i, lat=64, lon=-21) for i in (1, 2, 3)]
        a, b = rain.parse_iceland(raw, meta)
        self.assertEqual(a['times'], [END])
        self.assertEqual(a['amounts'], [0.6])
        self.assertEqual(a['accumulations'], [{'end': END, 'hours': 24, 'value': 65.2},
                                             {'end': END, 'hours': 48, 'value': 78.0}])
        self.assertEqual(b['times'], [])
        self.assertEqual(b['accumulations'], [{'end': END, 'hours': 48, 'value': 3}])
        self.assertRaises(ValueError, rain.parse_iceland, raw.replace('24/48 klst', 'changed'), meta)
        self.assertRaises(ValueError, rain.parse_iceland, raw.replace('til 2026', 'til xxxx'), meta)

    def test_iceland_total_only_history_merge_replacement_and_expiry(self):
        old = rain.station('IS', '1', 'A', 64, -21, [])
        old['accumulations'] = [{'end': END, 'hours': 48, 'value': 3},
                                {'end': END-73*3600, 'hours': 24, 'value': 10}]
        new = {**old, 'accumulations': [{'end': END, 'hours': 48, 'value': 4},
                                       {'end': END+3600, 'hours': 24, 'value': 50}]}
        s = rain.merge([old], [new], NOW)[0]
        self.assertEqual(s['times'], [])
        self.assertEqual(s['accumulations'], [{'end': END, 'hours': 48, 'value': 4}])

    def test_lithuania_hourly_null_and_utc(self):
        payload = {'station': {'code': 'a', 'name': 'A', 'coordinates': {'latitude': 55, 'longitude': 24}},
                   'observations': [{'observationTimeUtc': '2026-10-03 09:00:00', 'precipitation': 0},
                                    {'observationTimeUtc': '2026-10-03 10:00:00', 'precipitation': None}]}
        s = rain.parse_lithuania(payload)
        self.assertEqual(s['times'], [END-3600])
        self.assertEqual(s['amounts'], [0])

    def test_denmark_trace_is_not_negative_rain(self):
        def feature(t, value):
            return {'properties': {'parameterId': 'precip_past1h', 'stationId': '05001', 'observed': t, 'value': value},
                    'geometry': {'coordinates': [10, 56]}}
        s = rain.parse_denmark({'features': [feature(END, -0.1), feature(END-3600, None), feature(END-7200, -1)]})[0]
        self.assertEqual(s['times'], [END]); self.assertEqual(s['amounts'], [0]); self.assertEqual(s['traces'], [END])

    def test_finland_nan_hour_is_absent(self):
        raw = '<root><BsWfsElement><pos>61 25</pos><Time>2026-10-03T10:00:00Z</Time><ParameterName>r_1h</ParameterName><ParameterValue>NaN</ParameterValue></BsWfsElement></root>'
        s = rain.parse_finland(raw)[0]
        self.assertEqual(s['times'], [])

    def test_sweden_suspect_quality_not_used(self):
        s = rain.parse_sweden({'key': '1', 'name': 'A', 'latitude': 60, 'longitude': 18},
                             [{'date': END*1000, 'value': '3.2', 'quality': 'G'},
                              {'date': (END-3600)*1000, 'value': '50', 'quality': 'Y'}])
        self.assertEqual(s['amounts'], [3.2]); self.assertEqual(s['times'], [END])

    def test_merge_replaces_duplicates_keeps_gaps_prunes_future_and_old(self):
        old = rain.station('EE', '1', 'A', 59, 25, [(END-3600, 1, False), (END-73*3600, 2, False)])
        new = rain.station('EE', '1', 'A', 59, 25, [(END-3600, 3, False), (END+3600, 100, False)])
        s = rain.merge([old], [new], NOW)[0]
        self.assertEqual(s['times'], [END-3600]); self.assertEqual(s['amounts'], [3])

    def test_estonia_snapshot_hour_and_empty_readings(self):
        raw = f'<observations timestamp="{END+1200}"><station><name>A</name><latitude>59</latitude><longitude>25</longitude><precipitations>0.2</precipitations></station><station><precipitations/></station></observations>'
        s = rain.parse_estonia(raw)[0]
        self.assertEqual(s['times'], [END]); self.assertEqual(s['amounts'], [0.2])
        before_update = raw.replace(str(END+1200), str(END+300))
        self.assertEqual(rain.parse_estonia(before_update)[0]['times'], [END-3600])

    def test_lithuania_uses_latest_for_recent_archived_histories(self):
        recent=rain.station('LT','a','A',55,24,[(END-i*3600,0,False) for i in range(54)])
        jobs=rain.lithuania_jobs([{'code':'a'},{'code':'new'}],NOW,[recent])
        self.assertEqual([j for j in jobs if j[0]=='a'],[('a','latest')])
        self.assertGreaterEqual(len([j for j in jobs if j[0]=='new']),3)
        jobs=rain.lithuania_jobs([{'code':'a'}],NOW+dt.timedelta(hours=25),[recent])
        self.assertNotIn(('a','latest'),jobs,'long gaps require historical backfill')


if __name__ == '__main__':
    unittest.main()
