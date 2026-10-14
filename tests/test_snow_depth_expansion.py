import datetime as dt
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

snow = module('snow_base', ROOT/'scripts/update_snow_depth.py')
extra = module('snow_extra', ROOT/'scripts/snow_depth_expansion.py')


class ExpansionTests(unittest.TestCase):
    def setUp(self):
        self.adapter = extra.SnowDepthExpansion(None, snow.record, snow.latest, snow.NoRecentSnowData)

    def test_danish_trace_missing_latest_and_station_country(self):
        meta = {'A': {'name': 'Danish station', 'coords': [10, 56]}}
        def feature(value, time='2026-10-14T07:00:00Z'):
            return {'properties': {'stationId': 'A', 'parameterId': 'snow_depth_man', 'value': value, 'observed': time}}
        row = self.adapter.parse_denmark([feature(-1), feature(None)], meta)[0]
        self.assertEqual((row['country'], row['state'], row['depthCm']), ('DK', 'trace', None))
        row = self.adapter.parse_denmark([feature(12, '2026-10-13T07:00:00Z'), feature(0)], meta)[0]
        self.assertEqual((row['depthCm'], row['state']), (0, 'bare'))
        self.assertEqual(self.adapter.parse_denmark([feature(0)], {}), [])

    def test_irish_metres_negative_missing_and_latest(self):
        meta = {'1': {'name': 'Irish station', 'coords': [-8, 52]}}
        def feature(value, parameter='snow_depth', time='2026-10-14T07:00:00Z'):
            return {'properties': {'station_id': 1, 'parameter_name': parameter, 'value_num': value, 'observed_at': time}}
        row = self.adapter.parse_ireland([feature(.12), feature(-.02), feature(None)], meta)[0]
        self.assertEqual(row['depthCm'], 12)
        self.assertEqual(row['country'], 'IE')
        self.assertEqual(self.adapter.parse_ireland([feature(.5, 'precipitation_snow_amount_cumulative')], meta), [])
        row = self.adapter.parse_ireland([feature(.12, time='2026-10-13T07:00:00Z'), feature(0)], meta)[0]
        self.assertEqual(row['depthCm'], 0)

    def test_dwd_uses_total_depth_not_new_snow_and_requires_cm(self):
        station = {'country': 'PL', 'name': 'Warsaw', 'lat': 52.16, 'lon': 20.96}
        raw = b'surface;time;depth_of_new_snow;total_snow_depth\n12375;Unit;cm;cm\nDate;UTC;new;total\n14.10.26;06:00;99;12,5\n14.10.26;07:00;99;---\n14.10.26;08:00;99;997\n'
        row = self.adapter.parse_dwd(raw, '12375', station)[0]
        self.assertEqual(row['depthCm'], 12.5)
        self.assertEqual(row['time'], snow.timestamp('2026-10-14T06:00:00Z'))
        with self.assertRaises(ValueError):
            self.adapter.parse_dwd(raw.replace(b'Unit;cm;cm', b'Unit;cm;m'), '12375', station)
        with self.assertRaises(ValueError):
            self.adapter.parse_dwd(raw, '12300', station)

    def us_data(self, **patch):
        element = {'elementCode': 'SNWD', 'storedUnitCode': 'in', 'durationName': 'DAILY', 'derivedData': False, 'ordinal': 1}
        value = {'date': '2026-10-13', 'value': 4, 'qcFlag': 'V', 'qaFlag': 'P'}
        return [{'stationTriplet': '1:AK:SNTL', 'data': [{'stationElement': element, 'values': [{**value, **patch}]}]}]

    def us_meta(self):
        return {'1:AK:SNTL': {'name': 'Alaska station', 'latitude': 65, 'longitude': -150, 'networkCode': 'SNTL', 'operator': 'NRCS', 'dataTimeZone': -9}}

    def test_usa_inches_quality_flags_and_reporting_time_zone(self):
        row = self.adapter.parse_usa(self.us_data(), self.us_meta())[0]
        self.assertEqual(row['depthCm'], 10.2)
        self.assertEqual(row['time'], snow.timestamp('2026-10-13T09:00:00Z'))
        self.assertEqual(row['quality'], 'provisional')
        self.assertEqual(self.adapter.parse_usa(self.us_data(qaFlag='A'), self.us_meta())[0]['quality'], 'approved')
        for patch in ({'qcFlag': 'S'}, {'qcFlag': 'K'}, {'qcFlag': 'X'}, {'qaFlag': 'U'}, {'value': None}, {'value': -99}):
            self.assertEqual(self.adapter.parse_usa(self.us_data(**patch), self.us_meta()), [])
        payload = self.us_data();payload[0]['data'][0]['stationElement']['elementCode'] = 'WTEQ'
        self.assertEqual(self.adapter.parse_usa(payload, self.us_meta()), [])
        meta = self.us_meta();meta['1:AK:SNTL']['networkCode'] = 'SCAN'
        self.assertEqual(len(self.adapter.parse_usa(self.us_data(), meta)), 1)
        meta = self.us_meta();meta['1:AK:SNTL']['operator'] = 'PRIVATE'
        self.assertEqual(self.adapter.parse_usa(self.us_data(), meta), [])

    def test_new_bounds_do_not_change_existing_countries(self):
        for country, lat, lon in [('PL', 50, 20), ('DK', 56, 10), ('IE', 52, -8), ('UK', 51, 0), ('US', 65, -150), ('US', 39, -105)]:
            self.assertIsNotNone(snow.record(country, '1', 'Station', lat, lon, '2026-10-14T00:00:00Z', 0))
        self.assertIsNone(snow.record('FI', '1', 'Station', 50, 20, '2026-10-14T00:00:00Z', 0))
        self.assertIsNone(snow.record('US', '1', 'Station', 50, 20, '2026-10-14T00:00:00Z', 0))

