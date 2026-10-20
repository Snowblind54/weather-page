import datetime as dt
import io
import json
import pathlib
import sys
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]/'scripts'))
import official_wind_western as w

NOW = dt.datetime(2026, 10, 20, 11, tzinfo=dt.timezone.utc)


def archive(header, rows):
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, 'w') as z:
        z.writestr('produkt_zehn_now_ff_00011.txt', header+'\n'+'\n'.join(rows))
    return raw.getvalue()


class WesternWind(unittest.TestCase):
    def test_german_separate_files_join_only_at_exact_observation_times(self):
        mean = w.dwd_values(archive('STATIONS_ID;MESS_DATUM;QN;FF_10;DD_10;eor',
            ['11;202610201000;3;0;360;eor', '11;202610201010;3;4.5;100;eor', '12;202610201020;3;99;90;eor']), '00011', 'wind')
        gust = w.dwd_values(archive('STATIONS_ID;MESS_DATUM;QN;FX_10;FNX_10;FMX_10;DX_10;eor',
            ['11;202610201000;3;3.2;0;2;90;eor', '11;202610201020;3;8.1;3;6;100;eor', '11;202610201030;3;-999;3;6;100;eor']), '00011', 'extreme_wind')
        s = w.merge_dwd('00011', {'name':'Donaueschingen','lat':47.97,'lon':8.52}, mean, gust)
        self.assertEqual([r[1:] for r in s['rows']], [[0,3.2,360], [4.5,None,100], [None,8.1,None]])
        self.assertEqual(s['rows'][0][0], int(dt.datetime(2026,10,20,10,tzinfo=dt.timezone.utc).timestamp()))

    def test_dwd_rejects_archives_with_changed_columns(self):
        with self.assertRaises(ValueError):
            w.dwd_values(archive('STATIONS_ID;MESS_DATUM;FMX_10', ['11;202610201000;6']), '00011', 'extreme_wind')

    def test_dutch_units_local_timezone_header_order_and_missing_readings(self):
        raw = '<h2>Waarnemingen 20 oktober 2026 12:30 uur</h2><table><tr><th>Station</th><th>Windstoot (km/uur)</th><th>Wind (m/s)</th><th>Wind (bft)</th></tr><tr><td>De Bilt</td><td>36</td><td>0</td><td>ZO 0</td></tr><tr><td>Calm</td><td>-</td><td>2</td><td>O 2</td></tr><tr><td>Unknown</td><td>99</td><td>20</td><td>O 7</td></tr></table>'
        meta = {'DEBILT':{'code':'260','lat':52.1,'lon':5.18},'CALM':{'code':'261','lat':52.2,'lon':5.2}}
        rows = w.knmi_observations(raw, meta)
        self.assertEqual(rows[0]['rows'][0], [int(dt.datetime(2026,10,20,10,30,tzinfo=dt.timezone.utc).timestamp()),0,10,None])
        self.assertEqual(rows[1]['rows'][0][1:], [2,None,None])
        self.assertEqual(len(rows), 2)
        with self.assertRaises(ValueError):
            w.knmi_observations(raw.replace('km/uur','knots'), meta)

    def test_belgian_ten_metre_wind_never_substitutes_thirty_metre_wind(self):
        def station(code, **extra):
            return {'properties':{'code':code,'name':'Belgian station', **extra},'geometry':{'coordinates':[4.35,50.8]}}
        meta = [station(1), station(2,date_end='2020-01-01T00:00:00Z')]
        features = [{'properties':{'code':code,'timestamp':'2026-10-20T10:50:00Z','wind_speed_10m':speed,'wind_speed_avg_30m':30,'wind_gusts_speed':gust,'wind_direction':270}}
                    for code,speed,gust in [(1,None,8),(2,5,10),(3,99,99)]]
        rows = w.rmi_observations(features, meta, NOW)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['rows'][0][1:], [None,8,270])

    def test_meteolux_actual_source_uses_same_midpoint_sensor_and_native_units(self):
        fixture = json.loads(pathlib.Path(__file__).with_name('fixtures').joinpath('meteolux-wind.json').read_text())
        row = w.meteolux_observations(fixture['observations'], fixture['station'], fixture['parameters'])
        self.assertEqual(row['country'], 'LU')
        self.assertEqual((row['lat'],row['lon']), (49.63258,6.23301))
        self.assertEqual(row['rows'][0][1:], [3.1,3.6,103])
        fixture['parameters']['data'][8]['unit']='knots'
        with self.assertRaises(ValueError):
            w.meteolux_observations(fixture['observations'], fixture['station'], fixture['parameters'])

    def test_bounds_reject_foreign_stations_and_old_or_future_rows(self):
        with self.assertRaises(ValueError):
            w.core.station('LU','bad','Foreign',50.8,4.35,[(int(NOW.timestamp()),2,4,180)])
        for offset in (-4*3600, 600):
            with self.assertRaises(ValueError):
                w.recent([w.core.station('DE','1','German',47.97,8.52,[(int(NOW.timestamp())+offset,2,4,180)])], NOW)


if __name__ == '__main__':
    unittest.main()
