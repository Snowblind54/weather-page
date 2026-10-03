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


if __name__ == '__main__':
    unittest.main()
