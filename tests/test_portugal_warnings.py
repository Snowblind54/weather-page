import datetime as dt
import gzip
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from update_portugal_warnings import REGIONS, parse_portugal


class PortugalWarnings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with gzip.open(REGIONS, 'rt', encoding='utf-8') as stream:
            cls.regions = json.load(stream)['regions']

    def test_ipma_regions_include_all_districts_and_island_zones(self):
        self.assertEqual(len(self.regions), 25)
        for code, emma_id, bounds in [
            ('FAR', 'PT021', (36, 38, -9.1, -7.3)),
            ('AOC', 'PT001', (39, 40, -32, -31)),
            ('MCN', 'PT025', (32, 33, -18, -16)),
        ]:
            zone = self.regions[code]
            self.assertEqual(zone['emmaId'], emma_id)
            lo, hi, west, east = bounds
            for polygon in zone['polygons']:
                for ring in polygon:
                    self.assertEqual(ring[0], ring[-1])
                    self.assertTrue(all(lo <= lat <= hi and west <= lon <= east for lat, lon in ring))

    def test_levels_validity_and_coastal_outlines(self):
        now = dt.datetime(2026, 7, 10, 10, tzinfo=dt.timezone.utc)
        row = dict(idAreaAviso='FAR', awarenessTypeName='Precipitação',
                   awarenessLevelID='orange', text='Chuva forte.',
                   startTime='2026-07-10T09:00:00', endTime='2026-07-10T12:00:00')
        records = parse_portugal([
            row, row, dict(row, awarenessLevelID='green'),
            dict(row, awarenessLevelID='red', endTime='2026-07-10T10:00:00'),
            dict(row, idAreaAviso='ACE', awarenessTypeName='Agitação Marítima',
                 awarenessLevelID='yellow', startTime='2026-07-10T11:00:00'),
            dict(row, idAreaAviso='ZZZ', awarenessLevelID='red'),
        ], self.regions, now)
        self.assertEqual([r['level'] for r in records], ['Severe', 'Moderate', 'Extreme'])
        rain, marine, unmapped = records
        self.assertEqual(rain['onset'], '2026-07-10T09:00:00+00:00')
        self.assertEqual(rain['timeZone'], 'Europe/Lisbon')
        self.assertEqual(rain['description'], 'Chuva forte.')
        self.assertEqual(rain['polygons'], self.regions['FAR']['polygons'])
        self.assertFalse(rain['marine'])
        self.assertTrue(marine['marine'])
        self.assertIn('(coast)', marine['area'])
        self.assertEqual(marine['timeZone'], 'Atlantic/Azores')
        self.assertGreater(dt.datetime.fromisoformat(marine['onset']), now)
        self.assertEqual(unmapped['polygons'], [])
        self.assertTrue(unmapped['geometryIncomplete'])

    def test_empty_or_quiet_feed(self):
        now = dt.datetime.now(dt.timezone.utc)
        self.assertEqual(parse_portugal([{'awarenessLevelID': 'green'}], self.regions, now), [])
        with self.assertRaises(ValueError):
            parse_portugal([], self.regions, now)
