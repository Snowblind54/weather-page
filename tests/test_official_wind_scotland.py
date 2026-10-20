import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]/'scripts'))
import official_wind_scotland as s
import official_wind_atlantic as a

RAW = pathlib.Path(__file__).with_name('fixtures').joinpath('scotland-wind.csv').read_text()
META = {'name':'Altnaharra','lat':58.283333,'lon':-4.433333}
NOW = dt.datetime(2026,10,20,11,tzinfo=dt.timezone.utc)


class ScottishWind(unittest.TestCase):
    def test_actual_synop_fields_utc_decimal_comma_and_hourly_gust(self):
        item = s.parse_scotland(RAW, '03044', META)
        self.assertEqual(item['code'], 'SYNOP-03044')
        self.assertEqual(item['rows'][-1], [int(dt.datetime(2026,10,20,10,tzinfo=dt.timezone.utc).timestamp()),10,16.67,110])
        self.assertIn('preceding hour', item['period'])
        self.assertIn('SYNOP', item['sourceName'])

    def test_synop_cannot_substitute_six_hour_gusts_or_maximum_mean_wind(self):
        lines = RAW.splitlines();header = lines[0].split(';');latest = lines[3].split(';')
        latest[header.index(s.GUST)]='---'
        latest[header.index('maximum_wind_speed_during_last_6_hours')]='99'
        latest[header.index('maximum_wind_speed_as_10_minutes_mean_during_last_hour')]='80'
        item = s.parse_scotland('\n'.join(lines[:3]+[';'.join(latest)]), '03044', META)
        self.assertEqual(item['rows'][0][1:],[10,None,110])

    def test_station_identity_and_units_must_match(self):
        with self.assertRaises(ValueError):s.parse_scotland(RAW, '03005', META)
        with self.assertRaises(ValueError):s.parse_scotland(RAW.replace('km/h','m/s'), '03044', META)

    def test_scottish_reports_survive_an_airport_feed_failure(self):
        item = s.parse_scotland(RAW, '03044', META)
        with patch.object(a.core,'download_json',side_effect=ValueError('airport unavailable')), patch.object(s,'load_scotland',return_value=[item]):
            self.assertEqual(a.load_britain(NOW),[item])


if __name__ == '__main__':
    unittest.main()
