import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('snow', pathlib.Path(__file__).parents[1] / 'scripts/update_snow_depth.py')
snow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snow)


class SnowDepthTests(unittest.TestCase):
    def test_depth_units_missing_and_special_codes(self):
        self.assertEqual(snow.depth(.12, 'SE')[0], 12)
        self.assertEqual(snow.depth(-.01, 'SE')[1], 'trace')
        self.assertEqual(snow.depth(-.02, 'SE')[1], 'patchy')
        self.assertEqual(snow.depth(-1, 'FI')[0], 0)
        self.assertEqual(snow.depth(0, 'FI')[1], 'nearby')
        for value in (None, '', 'NaN', -999, 9999):
            self.assertIsNone(snow.depth(value, 'FI'))

    def test_sweden_quality_and_station_owner(self):
        payload = {'parameter': {'key': '8', 'unit': 'meter'}, 'station': [
            {'key': '1', 'name': 'Official', 'owner': 'SMHI', 'latitude': 60, 'longitude': 18,
             'value': [{'date': 1791000000000, 'value': .15, 'quality': 'G'},
                       {'date': 1791000100000, 'value': 9999, 'quality': 'Y'}]},
            {'key': '2', 'owner': 'PRIVATE', 'value': []}]}
        records = snow.parse_sweden(payload)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['depthCm'], 15)
        self.assertEqual(records[0]['time'], 1791000000)

    def test_estonia_date_is_observation_day_not_publication_date(self):
        rows = [{'jaam_kood': 'A', 'jaam_nimi': 'Harku', 'aasta': 2026, 'kuu': 10, 'paev': 3,
                 'element_yhik': 'cm', 'vaartus': 2, 'avaandmed_ts': '2026-10-04T10:00:00Z'}]
        records = snow.parse_estonia(rows, [{'name': 'Tallinn-Harku', 'latitude': 59.4, 'longitude': 24.6}])
        self.assertEqual(records[0]['time'], snow.timestamp('2026-10-03T00:00:00Z'))

    def test_finland_multipoint_names_missing_values_and_latest(self):
        raw = b'''<root><Location><identifier>123</identifier><name>Snow station</name><pos>60 25</pos></Location>
        <MultiPointCoverage><positions>60 25 1791000000 60 25 1791086400 61 26 1791086400</positions>
        <doubleOrNilReasonTupleList>12 -1 NaN</doubleOrNilReasonTupleList></MultiPointCoverage></root>'''
        records = snow.parse_finland(raw)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['name'], 'Snow station')
        self.assertEqual(records[0]['depthCm'], 0)


if __name__ == '__main__':
    unittest.main()
