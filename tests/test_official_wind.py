import datetime as dt
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import update_official_wind as w

STAMP = 1791183600


class OfficialWind(unittest.TestCase):
    def test_missing_values_are_not_calm_and_gust_only_stations_survive(self):
        for value in [None, '', False, 'NaN', -1, 999]:
            self.assertIsNone(w.number(value))
        self.assertEqual(w.number('0'), 0)
        s = w.station('EE', 'A', 'Station', 59, 25,
                      [(STAMP, 0, '', 360), (STAMP + 3600, '', 8, None), (STAMP + 7200, '', '', None)])
        self.assertEqual(s['rows'], [[STAMP, 0, None, 360], [STAMP + 3600, None, 8, None]])

    def test_northern_europe_bounds_and_timestamp_formats(self):
        s = w.station('IS', 'IS1', 'Iceland', 64.1, -21.9, [('2026-10-05T07:00:00Z', 4, 9, None)])
        self.assertEqual(s['rows'][0][0], 1791183600)
        self.assertEqual(w.timestamp(STAMP * 1000), STAMP)
        self.assertEqual(w.station('PL', 'PL1', 'Poland', 49.0, 19.0, [(STAMP, 2, 5, 180)])['country'], 'PL')

    def test_estonia_keeps_feed_time_and_exact_values_without_missing_stations(self):
        raw = f'<observations timestamp="{STAMP}"><station><name>Test &amp; shore</name><wmocode>EE1</wmocode><latitude>59</latitude><longitude>25</longitude><windspeed>2.1</windspeed><windspeedmax>4.7</windspeedmax><winddirection>230</winddirection></station><station><name>No wind</name><windspeed></windspeed><windspeedmax></windspeedmax></station></observations>'
        s = w.parse_estonia(raw)
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]['name'], 'Test & shore')
        self.assertEqual(s[0]['rows'], [[STAMP, 2.1, 4.7, 230]])
        self.assertEqual(w.SOURCES['EE']['timeKind'], 'feed')

    def fixture(self, values='7.2 3.4 230', positions=None):
        return f'<root xmlns:g="g" xmlns:x="x"><Point g:id="p"><pos>60 25</pos></Point><Location><identifier codeSpace="fmisid">FI1</identifier><name codeSpace="location/name">Helsinki &amp; shore</name><representativePoint x:href="#p"/></Location><MultiPointCoverage><DataRecord><field name="wg_10min"/><field name="ws_10min"/><field name="wd_10min"/></DataRecord><positions>{positions or "60 25 " + str(STAMP)}</positions><doubleOrNilReasonTupleList>{values}</doubleOrNilReasonTupleList></MultiPointCoverage></root>'

    def test_finland_resolves_real_names_and_field_order(self):
        s = w.parse_finland(self.fixture())[0]
        self.assertEqual(s['name'], 'Helsinki & shore')
        self.assertEqual(s['code'], 'FI1')
        self.assertEqual(s['rows'], [[STAMP, 3.4, 7.2, 230]])

    def test_finland_rejects_bad_grids_and_api_errors_and_preserves_missing_gusts(self):
        with self.assertRaises(ValueError):
            w.parse_finland(self.fixture(values='3.4 5'))
        with self.assertRaises(ValueError):
            w.parse_finland('<root><ExceptionText>Down</ExceptionText></root>')
        self.assertEqual(w.parse_finland(self.fixture(values='NaN 0 NaN'))[0]['rows'], [[STAMP, 0, None, None]])

    def test_sweden_merges_sustained_and_gust_parameters(self):
        base = {'key': 'SE1', 'name': 'Swedish shore', 'owner': 'SMHI', 'latitude': 59, 'longitude': 18}
        speed = {'parameter': {'key': '4'}, 'station': [{**base, 'value': [{'date': STAMP * 1000, 'value': 3.2, 'quality': 'G'}]}]}
        gust = {'parameter': {'key': '21'}, 'station': [{**base, 'value': [{'date': STAMP * 1000, 'value': 8.7, 'quality': 'Y'}]}]}
        s = w.parse_sweden(speed, gust)[0]
        self.assertEqual(s['rows'], [[STAMP, 3.2, 8.7, None]])

    def test_norway_keeps_primary_measured_wind_and_gust(self):
        metadata = [{'id': 'SN1', 'stationHolders': ['MET.NO'], 'shortName': 'Norwegian shore',
                     'geometry': {'coordinates': [10.0, 60.0]}}]
        payload = {'data': [{'sourceId': 'SN1:0', 'referenceTime': '2026-10-05T07:00:00Z', 'observations': [
            {'elementId': 'wind_speed', 'unit': 'm/s', 'qualityCode': 0, 'timeSeriesId': 0, 'value': 4.2},
            {'elementId': w.NORWAY_GUST_ELEMENT, 'unit': 'm/s', 'qualityCode': 2, 'timeSeriesId': 0, 'value': 9.1},
            {'elementId': 'wind_from_direction', 'unit': 'degrees', 'qualityCode': 0, 'timeSeriesId': 0, 'value': 220},
        ]}]}
        s = w.parse_norway(payload, metadata)[0]
        self.assertEqual(s['rows'], [[STAMP, 4.2, 9.1, 220]])

    def test_provider_element_and_current_iceland_endpoint_are_explicit(self):
        self.assertEqual(w.NORWAY_GUST_ELEMENT, 'max(wind_speed_of_gust PT1H)')
        self.assertIn('/10min/latest', w.ICELAND_LATEST_URL)

    def test_iceland_uses_f_for_wind_and_fg_for_gust(self):
        metadata = [{'station': 1475, 'name': 'Reykjavik', 'lat': 64.1, 'lon': -21.9}]
        payload = [{'station': 1475, 'name': 'Reykjavik', 'time': '2026-10-05T07:00:00', 'f': 5.2, 'fx': 7.1, 'fg': 8.4}]
        s = w.parse_iceland(payload, metadata)[0]
        self.assertEqual(s['rows'], [[STAMP, 5.2, 8.4, None]])

    def test_latvia_merges_official_wind_fields_by_station_and_time(self):
        metadata = [{'STATION_ID': 'RIGA', 'NAME': 'Riga', 'GEOGR1': 24.1, 'GEOGR2': 56.95}]
        payloads = {
            'WNS10': [{'STATION_ID': 'RIGA', 'DATETIME': '2026-10-05T09:00:00', 'VALUE': 4.2}],
            'WPGST': [{'STATION_ID': 'RIGA', 'DATETIME': '2026-10-05T09:00:00', 'VALUE': 8.8}],
            'WNDD10': [{'STATION_ID': 'RIGA', 'DATETIME': '2026-10-05T09:00:00', 'VALUE': 240}],
        }
        self.assertEqual(w.parse_latvia(payloads, metadata)[0]['rows'], [[STAMP + 7200, 4.2, 8.8, 240]])

    def test_lithuania_keeps_hourly_measured_wind_and_gust(self):
        payload = {'station': {'code': 'vilniaus-ams', 'name': 'Vilnius AMS',
                               'coordinates': {'latitude': 54.63, 'longitude': 25.1}},
                   'observations': [{'observationTimeUtc': '2026-10-05 09:00:00', 'windSpeed': 3.1,
                                     'windGust': 7.2, 'windDirection': 250}]}
        self.assertEqual(w.parse_lithuania(payload)['rows'], [[STAMP + 7200, 3.1, 7.2, 250]])

    def test_poland_does_not_turn_maximum_wind_into_missing_gust(self):
        payload = [{'kod_stacji': 'PL1', 'nazwa_stacji': 'Polish station', 'lat': '52.0', 'lon': '21.0',
                    'wiatr_srednia_predkosc': '4', 'wiatr_srednia_predkosc_data': '2026-10-05 09:00:00',
                    'wiatr_predkosc_maksymalna': '12', 'wiatr_predkosc_maksymalna_data': '2026-10-05 09:00:00',
                    'wiatr_poryw_10min': None, 'wiatr_poryw_10min_data': None,
                    'wiatr_kierunek': '250', 'wiatr_kierunek_data': '2026-10-05 09:00:00'}]
        self.assertEqual(w.parse_poland(payload)[0]['rows'], [[STAMP + 7200, 4.0, None, 250]])

    def test_denmark_merges_same_time_mean_wind_and_three_second_max(self):
        metadata = {'features': [{'geometry': {'coordinates': [12.0, 55.5]},
                    'properties': {'owner': 'DMI', 'country': 'DNK', 'stationId': '06180', 'name': 'Danish station'}}]}
        def feature(parameter, value):
            return {'properties': {'parameterId': parameter, 'stationId': '06180',
                                   'observed': '2026-10-05T09:00:00Z', 'value': value}}
        payloads = {'wind_speed': {'features': [feature('wind_speed', 5.0)]},
                    'wind_max': {'features': [feature('wind_max', 9.5)]},
                    'wind_dir': {'features': [feature('wind_dir', 230)]}}
        self.assertEqual(w.parse_denmark(payloads, metadata)[0]['rows'], [[STAMP + 7200, 5.0, 9.5, 230]])

    def test_retained_history_keeps_a_failed_country_and_never_invents_missing_hours(self):
        now = dt.datetime.fromtimestamp(STAMP + 3600, dt.timezone.utc)
        old = [w.station('EE', 'EE1', 'EE', 59, 25, [(STAMP, 2, 4, None), (STAMP - 25 * 3600, 1, 1, None)])]
        current = [w.station('FI', 'FI1', 'FI', 60, 25, [(STAMP + 3600, 3, 5, None), (STAMP + 7200, 8, 9, None)])]
        rows = w.merge(old, current, now)
        self.assertEqual(len(rows), 2)
        self.assertEqual([r[0] for s in rows for r in s['rows']], [STAMP, STAMP + 3600])


if __name__ == '__main__':
    unittest.main()

class AmericasWindTests(unittest.TestCase):
    def test_canadian_units_quality_and_missing_gust(self):
        from official_wind_americas import parse_canada
        props={'msc_id-value':'CAN001','obs_date_tm':'2026-10-08T10:00:00Z',
               'avg_wnd_spd_10m_pst10mts':36,'avg_wnd_spd_10m_pst10mts-qa':100,'avg_wnd_spd_10m_pst10mts-uom':'km/h',
               'max_wnd_spd_10m_pst10mts':72,'max_wnd_spd_10m_pst10mts-qa':100,'max_wnd_spd_10m_pst10mts-uom':'km/h'}
        feature={'properties':props,'geometry':{'coordinates':[-123,49]}}
        rows=parse_canada([feature],{'CAN001':{'name':'Vancouver'}})[0]['rows']
        self.assertEqual(rows[0][1:],[10,20,None])
        props['max_wnd_spd_10m_pst10mts-qa']=10
        self.assertIsNone(parse_canada([feature],{'CAN001':{}})[0]['rows'][0][2])
        props['avg_wnd_spd_10m_pst10mts']=0
        self.assertEqual(parse_canada([feature],{'CAN001':{}})[0]['rows'][0][1],0)
        self.assertEqual(parse_canada([feature],{}),[])

    def test_country_bounds_do_not_expand_europe(self):
        w.station('GL','x','Nuuk',64,-51,[(100,5,None,90)])
        w.station('CA','x','Canada',49,-123,[(100,5,None,90)])
        with self.assertRaises(ValueError):w.station('EE','x','Wrong',49,-123,[(100,5,None,90)])
