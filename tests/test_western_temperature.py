import datetime as dt
import io
import pathlib
import sys
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import update_western_temperature as west


class WesternTemperatures(unittest.TestCase):
    def archive(self, text):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('produkt_zehn_now_tu_20261019_20261019_00044.txt', text)
        return stream.getvalue()

    def test_dwd_preserves_named_station_coordinates_celsius_and_utc(self):
        metadata = west.dwd_metadata('00044 20070208 20261019 44 52.9336 8.2370 Großenkneten    Niedersachsen    Frei'.encode('latin-1'))
        raw = self.archive('STATIONS_ID;MESS_DATUM;QN;PP_10;TT_10;TM5_10\n'
                           '44;202610191000;3;999;0;-5\n44;202610191010;3;999;-2.5;-6\n'
                           '44;202610191020;3;999;-999;12\n55;202610191030;3;999;30;30\n')
        s = west.dwd_station(raw, '00044', metadata['00044'])
        self.assertEqual(s['name'], 'Großenkneten')
        self.assertEqual(s['lat'], 52.9336)
        self.assertEqual(s['rows'], [[1792404000, 0], [1792404600, -2.5]])
        self.assertEqual(s['country'], 'DE')

    def test_dwd_does_not_guess_changed_archive_columns(self):
        with self.assertRaisesRegex(ValueError, 'columns changed'):
            west.dwd_station(self.archive('time;temp\n202610191000;1\n'), '00044', {})

    def metadata(self):
        return west.knmi_metadata('# STN LON LAT ALT NAME\n'
            '# 260 5.180 52.100 1.90 De Bilt\n# 240 4.790 52.318 -3.30 Schiphol Airport\n'
            '# 235 4.781 52.928 1.20 De Kooy Airport\n# 380 5.762 50.906 114.30 Maastricht Airport\n')

    def page(self, date='19 oktober 2026 13:20'):
        return '<h2>Waarnemingen '+date+' uur</h2><table><tr><th>Station</th><th>Weer</th><th>Temp<br>(&deg;C)</th><th>WBGT</th></tr>' \
            '<tr><td>De Bilt</td><td></td><td>0</td><td>20</td></tr>' \
            '<tr><td>Schiphol</td><td>bewolkt</td><td>12,3</td><td>25</td></tr>' \
            '<tr><td>Den Helder</td><td></td><td>-</td><td>18</td></tr>' \
            '<tr><td>Unknown station</td><td></td><td>50</td><td>35</td></tr></table>'

    def test_knmi_joins_official_metadata_and_handles_empty_table_cells(self):
        rows = west.knmi_observations(self.page(), self.metadata())
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['code'], '260')
        self.assertEqual(rows[0]['rows'], [[1792408800, 0]])
        self.assertEqual(rows[1]['code'], '240')
        self.assertEqual(rows[1]['rows'][0][1], 12.3)

    def test_knmi_winter_and_summer_local_times_are_converted_to_utc(self):
        for local, expected in [('19 oktober 2026 13:20', '2026-10-19T11:20:00+00:00'),
                                ('19 januari 2026 13:20', '2026-01-19T12:20:00+00:00')]:
            row = west.knmi_observations(self.page(local), self.metadata())[0]['rows'][0]
            self.assertEqual(dt.datetime.fromtimestamp(row[0], dt.timezone.utc).isoformat(), expected)

    def test_knmi_missing_date_fails_instead_of_assigning_collection_time(self):
        with self.assertRaisesRegex(ValueError, 'timestamp missing'):
            west.knmi_observations(self.page().replace('Waarnemingen', 'Measurements'), self.metadata())

    def test_rmi_uses_shelter_temperature_and_active_official_station_metadata(self):
        now = 1792408800
        def feature(code, **p):
            return {'properties': {'code': code, **p}, 'geometry': {'coordinates': [4.35, 50.85]}}
        metadata = [feature(6447, name='Uccle', date_begin='2000-01-01T00:00:00Z'),
                    feature(1, name='Closed', date_end='2020-01-01T00:00:00Z')]
        observations = [feature(6447, timestamp='2026-10-19T11:20:00Z', temp_dry_shelter_avg=0,
                                temp_grass_pt100_avg=15, qc_flags='{"validated":{"TEMP_DRY_SHELTER_AVG":false}}'),
                        feature(6447, timestamp='2026-10-19T11:30:00Z', temp_dry_shelter_avg=None),
                        feature(1, timestamp='2026-10-19T11:20:00Z', temp_dry_shelter_avg=10),
                        feature(999, timestamp='2026-10-19T11:20:00Z', temp_dry_shelter_avg=20)]
        rows = west.rmi_observations(observations, metadata, now)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['rows'], [[now, 0]])
        self.assertEqual(rows[0]['country'], 'BE')
        self.assertIn('provisional', rows[0]['source'])

    def test_missing_sentinels_future_and_old_observations_stay_unavailable(self):
        for value in [None, '', '-', '---', False, -999, 'NaN', 'Infinity']:
            self.assertIsNone(west.temperature(value))
        now = 1792408800
        s = lambda rows: west.core.make_station('DE', '1', 'Station', 48, 10, rows)
        for rows in [[(now+1, 10)], [(now-96*60, 10)]]:
            with self.assertRaises(ValueError): west.recent_stations([s(rows)], now)
        fresh = west.recent_stations([s([(now-600, 0), (now+1, 50)])], now)[0]
        self.assertEqual(fresh['rows'], [[now-600, 0]])

    def test_new_countries_join_the_existing_twenty_four_hour_history(self):
        now = 1792408800
        for country, lat, lon in [('DE', 47.5, 10), ('NL', 52, 5), ('BE', 50, 4)]:
            self.assertIn(country, west.core.LOADERS)
            make = lambda t, v: west.core.make_station(country, 'same', country, lat, lon, [(t, v)])
            rows = west.core.merge_country_history({'stations': [make(now-3600, 0)]}, country,
                                                   [make(now, 5)], now-86400, now)
            self.assertEqual(rows[0]['rows'], [[now-3600, 0], [now, 5]])
