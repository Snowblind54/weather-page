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
                 'element_yhik_eng': 'cm', 'vaartus': 2, 'avaandmed_ts': '2026-10-04T10:00:00Z'}]
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

    def test_latvia_decimal_coordinates_parameter_and_missing(self):
        meta = [{'STATION_ID': 'A', 'NAME': 'Riga', 'GEOGR1': '24.1', 'GEOGR2': '57.0'}]
        params = [{'ABBREVIATION': 'HSNOW', 'MEASUREMENT_UNIT': 'cm'}]
        rows = [{'STATION_ID': 'A', 'ABBREVIATION': 'HSNOW', 'DATETIME': '2026.10.04 09:00:00', 'VALUE': '12'},
                {'STATION_ID': 'A', 'ABBREVIATION': 'HSNOW', 'DATETIME': '2026.10.04 10:00:00', 'VALUE': ''},
                {'STATION_ID': 'A', 'ABBREVIATION': 'HTDRY', 'DATETIME': '2026.10.04 11:00:00', 'VALUE': '30'}]
        r = snow.parse_latvia(rows, meta, params)[0]
        self.assertEqual((r['lat'], r['lon'], r['depthCm']), (57, 24.1, 12))
        self.assertEqual(r['time'], snow.timestamp('2026-10-04T09:00:00Z'))
        self.assertEqual(snow.parse_latvia(rows, meta, []), [])

    def test_lithuania_null_is_not_zero_and_latest_measured_value(self):
        p = {'station': {'code': 'A', 'name': 'Vilnius', 'coordinates': {'latitude': 54.6, 'longitude': 25.1}},
             'observations': [{'observationTimeUtc': '2026-10-04 08:00:00', 'snowDepth': 7},
                              {'observationTimeUtc': '2026-10-04 09:00:00', 'snowDepth': None}]}
        r = snow.parse_lithuania(p)[0]
        self.assertEqual(r['depthCm'], 7)
        self.assertEqual(r['time'], snow.timestamp('2026-10-04T08:00:00Z'))

    def test_norway_official_owner_units_quality_and_time_offset(self):
        meta = [{'id': 'SN1', 'name': 'Norway', 'stationHolders': ['MET.NO'],
                 'geometry': {'coordinates': [5, 60]}},
                {'id': 'SN2', 'name': 'Other', 'stationHolders': ['PRIVATE']}]
        obs = {'elementId': 'surface_snow_thickness', 'unit': 'cm', 'qualityCode': 0,
               'timeOffset': 'PT6H', 'value': 20}
        row = {'sourceId': 'SN1:0', 'referenceTime': '2026-10-04T00:00:00Z', 'observations': [obs]}
        r = snow.parse_norway({'data': [row]}, meta)[0]
        self.assertEqual(r['time'], snow.timestamp('2026-10-04T06:00:00Z'))
        self.assertEqual(r['depthCm'], 20)
        for patch in ({'unit': 'm'}, {'qualityCode': 1}, {'qualityCode': 6}, {'qualityCode': 7}):
            row['observations'] = [{**obs, **patch}]
            self.assertEqual(snow.parse_norway({'data': [row]}, meta), [])
        row['sourceId'] = 'SN2:0'; row['observations'] = [obs]
        self.assertEqual(snow.parse_norway({'data': [row]}, meta), [])
        self.assertEqual(snow.depth(0, 'NO')[1], 'trace')
        self.assertEqual(snow.depth(-1, 'NO')[1], 'patchy')
        self.assertIsNone(snow.depth(-3, 'NO'))

    def test_iceland_west_longitude_missing_and_observation_time(self):
        raw = 'sk 1 2026-10-04 09:00:00 0 0 - Reykjavík\nur 2 2026-10-04 09:00:00 - 4 - Missing\n'.encode('latin-1')
        meta = {'1': {'lat': 64.1289, 'lon': -21.9082}, '2': {'lat': 65, 'lon': -22}}
        rows = snow.parse_iceland(raw, meta)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['depthCm'], 0)
        self.assertEqual(rows[0]['lon'], -21.9082)
        self.assertEqual(rows[0]['time'], snow.timestamp('2026-10-04T09:00:00Z'))
        self.assertEqual(rows[0]['quality'], 'provisional')



if __name__ == '__main__':
    unittest.main()
