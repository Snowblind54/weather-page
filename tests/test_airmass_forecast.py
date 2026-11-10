import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import update_airmass_forecast as air

RUN = datetime(2026, 11, 10, tzinfo=timezone.utc)


class AirMassTests(unittest.TestCase):
    def test_only_correct_temperature_level_and_actual_surface_pressure_are_selected(self):
        rows = [{'param': 't', 'levtype': 'pl', 'levelist': '700'},
                {'param': 't', 'levtype': 'pl', 'levelist': '850'},
                {'param': 'msl', 'levtype': 'sfc'}, {'param': 'sp', 'levtype': 'sfc'}]
        raw = lambda values: '\n'.join(json.dumps(row) for row in values).encode()
        self.assertEqual(air.select_fields(raw(rows)), {'t': rows[1], 'sp': rows[3]})
        with self.assertRaises(ValueError): air.select_fields(raw(rows[:-1]))
        with self.assertRaises(ValueError): air.select_fields(raw([rows[0], rows[3]]))

    def test_only_complete_new_long_cycles_are_prepared(self):
        calls = []
        def probe(run, step):
            calls.append((run, step))
            if run == RUN and step == 120: raise RuntimeError('not ready')
            return {'t': {}, 'sp': {}}
        previous = RUN - timedelta(hours=12)
        self.assertIsNone(air.publishable_cycle(RUN + timedelta(hours=5), previous, probe))
        self.assertEqual(calls, [(RUN, 0), (RUN, 120)])
        self.assertEqual(air.publishable_cycle(RUN + timedelta(hours=5), None, probe)[0], previous)

    def test_freezing_contour_and_colour_do_not_leak_below_terrain(self):
        t = np.tile(np.linspace(-10, 10, 30), (20, 1))
        p = np.full_like(t, 101000); p[:7, :] = 80000
        image = np.asarray(air.image_frame(t, p))
        self.assertTrue((image[:7, :, 3] == 0).all())
        self.assertTrue((image[7:, :, 3] == 255).all())
        self.assertTrue((image[9:, :, :3] == [255, 243, 207]).all(axis=2).any())

    def test_generation_publishes_all_native_frames_or_keeps_previous_index(self):
        lat, lon = np.array([25, 82]), np.array([-40, 60])
        def read(run, step, seeds):
            return {'t': (lat, lon, np.array([[265, 285], [270, 280]])),
                    'sp': (lat, lon, np.full((2, 2), 101000))}
        def fail(run, step, seeds):
            if step == 120: raise RuntimeError('provider missing a frame')
            return read(run, step, seeds)
        with tempfile.TemporaryDirectory() as tmp, patch.object(air, 'pixels', return_value=air.pixels(32)):
            root = Path(tmp)
            air.build(RUN, {}, root, read)
            previous = (root / air.MANIFEST).read_bytes()
            manifest = json.loads(previous)
            self.assertEqual(len(manifest['cached_times']), 41)
            self.assertEqual(manifest['cached_times'][-1], air.iso(RUN + timedelta(hours=120)))
            for asset in [*manifest['images']['airmass'].values(), manifest['legends']['airmass']]:
                self.assertTrue((root / asset).is_file())
            with self.assertRaises(RuntimeError): air.build(RUN + timedelta(hours=12), {}, root, fail)
            self.assertEqual((root / air.MANIFEST).read_bytes(), previous)
