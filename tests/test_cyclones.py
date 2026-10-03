"""Closed-low detection, association and official-name matching."""
import datetime as dt
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
try:
    import numpy as np
    import scipy
except ImportError:
    np = None
if np is not None:
    import update_cyclones as c

RUN = dt.datetime(2026, 10, 3, 6, tzinfo=dt.timezone.utc)
STAMP = int(RUN.timestamp())


def point(hour=0, lon=-30, pressure=985):
    return {'time': STAMP+hour*3600, 'lat': 55, 'lon': lon, 'pressure': pressure, 'nearbyWind': 5}


@unittest.skipIf(np is None, 'Optional cyclone numpy/scipy dependencies are not installed')
class Cyclones(unittest.TestCase):
    def test_closed_minimum_and_wind_units(self):
        lats, lons = np.arange(48, 62.1, .5), np.arange(-43, -16.9, .5)
        r2 = ((lats[:, None]-55)*111.2)**2+((lons[None, :]+30)*111.2*np.cos(np.deg2rad(55)))**2
        pressure = 1015-30*np.exp(-r2/20000)
        fields = {'pressure': pressure, 'u': np.full_like(pressure, 3), 'v': np.full_like(pressure, 4), 'gust': np.full_like(pressure, 12)}
        lows = c.centres(lats, lons, fields, STAMP)
        self.assertEqual(len(lows), 1)
        self.assertAlmostEqual(lows[0]['lat'], 55, places=2)
        self.assertAlmostEqual(lows[0]['lon'], -30, places=2)
        self.assertAlmostEqual(lows[0]['pressure'], 985, places=1)
        self.assertEqual(lows[0]['nearbyWind'], 5)
        self.assertEqual(lows[0]['nearbyGust'], 12)
        fields['pressure'] = 1015-np.exp(-r2/20000)
        self.assertEqual(c.centres(lats, lons, fields, STAMP), [], 'Shallow lows are rejected')
        fields['pressure'] = np.full_like(pressure, 1025)
        self.assertEqual(c.centres(lats, lons, fields, STAMP), [])
        fields['pressure'] = 985+np.broadcast_to(np.arange(len(lons))*.3, pressure.shape)
        self.assertEqual(c.centres(lats, lons, fields, STAMP), [], 'An open trough is not a closed cyclone')

    def test_crossing_tracks_keep_velocity_and_one_to_one_association(self):
        frames = [(STAMP+h*3600, [point(h, -30+h), point(h, -20-h)]) for h in (0, 3, 6, 9)]
        tracks = c.track_frames(frames)
        self.assertEqual(len(tracks), 2)
        self.assertEqual([p['lon'] for p in tracks[0]['points']], [-30, -27, -24, -21])
        self.assertEqual([p['lon'] for p in tracks[1]['points']], [-20, -23, -26, -29])
        self.assertEqual(c.track_frames(frames[:3]), [], 'A transient minimum cannot become a displayed track')

    def test_long_missing_gap_splits_tracks_and_never_extrapolates(self):
        frames = [(STAMP+h*3600, [point(h)]) for h in (0, 3, 6, 9, 18, 21, 24, 27)]
        self.assertEqual(len(c.track_frames(frames)), 2)
        points = [point(0), point(3), point(12), point(15)]
        self.assertIsNone(c.point_at(points, STAMP-1))
        self.assertIsNone(c.point_at(points, STAMP+6*3600))
        self.assertIsNone(c.point_at(points, STAMP+16*3600))
        self.assertEqual(c.point_at(points, STAMP+15*3600)['lon'], -30)

    def test_id_handoff_is_stable_without_new_id_collision(self):
        old = {'systems': [{'id': 'GFS-2026100306-02', 'points': [point(h) for h in (0, 3, 6, 9)]}]}
        tracks = [{'points': [point(h, -30.1) for h in (0, 3, 6, 9)]},
                  {'points': [point(h, -55) for h in (0, 3, 6, 9)]}]
        result = c.assign_ids(tracks, old, RUN)
        self.assertEqual(result[0]['id'], old['systems'][0]['id'])
        self.assertEqual(len(set(t['id'] for t in result)), 2)
        self.assertTrue(all(t['name'] is None for t in result))

    def test_atlantic_name_only_matches_fresh_nearby_centre(self):
        tracks = [{'points': [point(h) for h in (0, 3, 6, 9)]}]
        storm = {'id': 'al012026', 'name': 'Example', 'classification': 'TS', 'lastUpdate': RUN.isoformat(),
                 'latitudeNumeric': 55, 'longitudeNumeric': -30, 'pressure': '985',
                 'intensity': '40', 'movementSpeed': '10', 'movementDir': '90',
                 'publicAdvisory': {'url': 'https://www.nhc.noaa.gov/example'}}
        payload = {'activeStorms': [storm | {'id': 'ep012026', 'name': 'Pacific'}, storm]}
        with patch.object(c, 'download', return_value=json.dumps(payload).encode()):
            status = c.add_names(tracks, RUN+dt.timedelta(hours=3))
        self.assertEqual(status['atlanticStorms'], 1)
        self.assertEqual(tracks[0]['name'], 'Example')
        self.assertEqual(tracks[0]['nhc']['movementKMH'], 18.5)
        self.assertEqual(tracks[0]['nhc']['windMS'], 20.6)
        for age, lon in ((13, -30), (3, -50)):
            payload = {'activeStorms': [storm | {'longitudeNumeric': lon}]}
            anonymous = [{'points': [point(h) for h in (0, 3, 6, 9)]}]
            with patch.object(c, 'download', return_value=json.dumps(payload).encode()):
                c.add_names(anonymous, RUN+dt.timedelta(hours=age))
            self.assertNotIn('name', anonymous[0])

    def test_region_and_interpolation(self):
        self.assertTrue(c.display_region(30, -30))
        self.assertTrue(c.display_region(55, 25))
        self.assertFalse(c.display_region(40, 25))
        self.assertFalse(c.display_region(80, -30))
        middle = c.point_at([point(0, -30, 980), point(3, -27, 986)], STAMP+5400)
        self.assertEqual(middle['lon'], -28.5)
        self.assertEqual(middle['pressure'], 983)

    def test_history_survives_model_handoff_without_future_or_unmatched_positions(self):
        old = {'systems': [{'id': 'matched', 'history': [point(-75), point(-12)],
                            'points': [point(h) for h in (0, 3, 6, 9, 12, 15)]}]}
        now = RUN+dt.timedelta(hours=9)
        new = [{'id': 'matched', 'points': [point(h, -29) for h in (6, 9, 12, 15)]},
               {'id': 'new', 'points': [point(h, -50) for h in (6, 9, 12, 15)]}]
        result = c.retain_history(new, old, now, STAMP+6*3600)
        self.assertEqual([p['time'] for p in result[0]['history']], [STAMP+h*3600 for h in (-12, 0, 3, 6, 9)])
        self.assertEqual([p['time'] for p in result[1]['history']], [STAMP+h*3600 for h in (6, 9)])
        self.assertTrue(all(p['time'] <= int(now.timestamp()) for s in result for p in s['history']))
        self.assertEqual(result[0]['history'][-1]['lon'], -29)


if __name__ == '__main__':
    unittest.main()
