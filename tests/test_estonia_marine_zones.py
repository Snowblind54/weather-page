"""Run with unittest; requires scripts/requirements-warning-geometry.txt."""
import json
import unittest
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]


class MarineZonesTest(unittest.TestCase):
    def setUp(self):
        data = json.loads((ROOT / 'data/estonia-marine-warning-zones.geojson').read_text())
        self.zones = {f['properties']['area']: shape(f['geometry']) for f in data['features']}
        self.water = unary_union(list(self.zones.values()))

    def test_valid_water_geometries(self):
        self.assertEqual(len(self.zones), 6)
        for zone in self.zones.values():
            self.assertTrue(zone.is_valid)
            self.assertFalse(zone.is_empty)
        self.assertTrue(self.zones['peipsi järv'].covers(Point(27.35, 58.6)))
        self.assertTrue(self.zones['soome lahe lääneosa'].covers(Point(24.7, 59.7)))

    def test_gulf_of_finland_zones_stay_compact(self):
        west = self.zones['soome lahe lääneosa']
        east = self.zones['soome lahe idaosa']
        self.assertLessEqual(west.bounds[3], 59.74)
        self.assertLessEqual(east.bounds[3], 59.77)
        self.assertFalse(west.covers(Point(24.7, 59.9)))
        self.assertFalse(east.covers(Point(27.0, 59.9)))

    def test_mainland_and_islands_are_not_covered(self):
        # Tallinn, Pärnu, Saaremaa, Hiiumaa, Muhu, Vormsi, Ruhnu, Helsinki,
        # Haapsalu and the western shore of Lake Peipsi.
        for lon, lat in [(24.75, 59.437), (24.5, 58.39), (22.5, 58.25),
                         (22.7, 58.9), (23.23, 58.6), (23.28, 59.0),
                         (23.25, 57.8), (24.94, 60.17), (23.54, 58.94),
                         (27.0, 58.7)]:
            with self.subTest(lon=lon, lat=lat):
                self.assertFalse(self.water.covers(Point(lon, lat)))


if __name__ == '__main__':
    unittest.main()
