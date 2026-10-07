"""Tests for model-derived cold/warm frontal axes."""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
try:
    import numpy as np
except ImportError:
    np = None
if np is not None:
    import update_fronts as f

RUN = dt.datetime(2026, 10, 7, 6, tzinfo=dt.timezone.utc)
STAMP = int(RUN.timestamp())


@unittest.skipIf(np is None, 'Optional cyclone numpy/scipy dependencies are not installed')
class CycloneFronts(unittest.TestCase):
    def test_grid_url_requests_850_temperature_and_wind(self):
        url = f.grid_url(RUN, 3)
        self.assertIn('lev_850_mb=on', url)
        self.assertIn('var_TMP=on', url)
        self.assertIn('var_UGRD=on', url)
        self.assertIn('var_VGRD=on', url)
        self.assertIn('f003', url)

    def test_advection_sign_classifies_front_type(self):
        self.assertEqual(f.classify_advection(0.001), 'warm')
        self.assertEqual(f.classify_advection(-0.001), 'cold')

    def test_objective_axis_finds_strong_synthetic_front(self):
        lats = np.arange(46, 61.1, .5)
        lons = np.arange(-12, 4.1, .5)
        temperature = 273 + np.broadcast_to(8 * np.tanh(lons[None, :] / 1.5), (len(lats), len(lons)))
        fields = {
            'temperature': temperature,
            # Temperature increases eastward. Westerly-to-easterly flow gives
            # cold advection, so the detected axis should classify as cold.
            'u': np.full_like(temperature, 12.0),
            'v': np.zeros_like(temperature),
        }
        frame = f.analyse_fronts(lats, lons, fields, STAMP)
        self.assertEqual(frame['time'], STAMP)
        self.assertTrue(frame['lines'])
        self.assertTrue(any(line['type'] == 'cold' for line in frame['lines']))
        self.assertTrue(any(abs(p[0]) < 2 for line in frame['lines'] for p in line['points']))


if __name__ == '__main__':
    unittest.main()
