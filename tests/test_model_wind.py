import importlib.util
import pathlib
import tempfile
import unittest
import threading
import urllib.parse
from unittest import mock

spec = importlib.util.spec_from_file_location('model_wind', pathlib.Path(__file__).parents[1] / 'scripts/update_model_wind.py')
wind = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wind)


class ModelWindTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(wind.time, 'sleep', return_value=None)
        patch.start()
        self.addCleanup(patch.stop)

    def payload(self, units=None, times=None):
        return {'hourly_units': units or {'wind_speed_10m': 'm/s', 'wind_direction_10m': '°', 'wind_gusts_10m': 'm/s'},
                'hourly': {'time': times or [100, 200], 'wind_speed_10m': [10, 0],
                           'wind_direction_10m': [90, 0], 'wind_gusts_10m': [15, None]}}

    def test_collection_keeps_units_vectors_gust_missing_and_model_selection(self):
        with mock.patch.object(wind, 'request_json', return_value=self.payload()) as request:
            times, rows = wind.collect_points([(30, -100)], 'gfs_seamless', 'start', 'end')
        self.assertIn('models=gfs_seamless', request.call_args.args[0])
        self.assertEqual(times, [100, 200])
        self.assertEqual(rows[0][0], [-10, -0.0, 15])
        self.assertEqual(rows[0][1], [-0.0, -0.0, None])

    def test_collection_rejects_different_hours_and_wrong_units(self):
        for payload in [self.payload(times=[100, 300]), self.payload(units={'wind_speed_10m': 'km/h'})]:
            with mock.patch.object(wind, 'request_json', return_value=payload):
                with self.assertRaises(RuntimeError):
                    wind.collect_points([(30, -100)], 'gfs_seamless', 'start', 'end', [100, 200])

    def test_shared_nodes_are_fetched_once_and_legacy_shape_is_retained(self):
        grid = {'south': 0, 'north': 1, 'west': -180, 'east': 180, 'rows': 2, 'cols': 2}
        extra = {**grid, 'id': 'hemisphere', 'model': 'noaa_gfs'}
        def native(points, indices, times):
            return [[[3, 4, 8]] * len(times) for _ in points], {'gfsRun': 0}
        def collect(points, model, start, end, times):
            return times, [[[3, 4, 8]] * len(times) for _ in points]
        with mock.patch.object(wind, 'WIND_GRIDS', [grid]), mock.patch.object(wind, 'WIND_EXTRA_GRIDS', [extra]), \
             mock.patch.object(wind, 'collect_native', side_effect=native) as noaa, \
             mock.patch.object(wind, 'collect_points', side_effect=collect) as fetch:
            data = wind.build_snapshot(3600)
        self.assertEqual(len(fetch.call_args.args[0]), 2)
        self.assertEqual(len(noaa.call_args.args[0]), 2)
        self.assertEqual(data['version'], 6)
        self.assertEqual(len(data['grids']), 1)
        self.assertEqual(len(data['grids'][0]), 4)
        self.assertEqual(data['extraGrids'][0]['series'], data['grids'][0])

    def test_regional_api_failure_uses_current_native_data_with_provenance(self):
        grid = {'south': 0, 'north': 1, 'west': 0, 'east': 1, 'rows': 2, 'cols': 2}
        with mock.patch.object(wind, 'WIND_GRIDS', [grid]), mock.patch.object(wind, 'WIND_EXTRA_GRIDS', []), \
             mock.patch.object(wind, 'collect_native', return_value=([[[3,4,8]]*11]*4, {'gfsRun': 0})), \
             mock.patch.object(wind, 'collect_points', side_effect=RuntimeError('quota')):
            data = wind.build_snapshot(3600)
        self.assertEqual(data['legacyGustTiming'], 'instant')
        self.assertIn('fallback', data['regionalSource'])
        self.assertEqual(len(data['times']),11)
        self.assertEqual(data['grids'][0][0][0],[3,4,8])

    def test_failed_collection_keeps_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'model-wind.json'
            output.write_text('last successful snapshot')
            with mock.patch.object(wind, 'OUTPUT', output), mock.patch.object(wind, 'build_snapshot', side_effect=RuntimeError('upstream')):
                with self.assertRaises(RuntimeError):
                    wind.main()
            self.assertEqual(output.read_text(), 'last successful snapshot')

    def test_parallel_batches_preserve_request_order_and_have_two_workers(self):
        barrier = threading.Barrier(2)
        second_finished = threading.Event()
        def request(url):
            lat = float(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)['latitude'][0])
            barrier.wait(timeout=5)
            if lat == 1:
                second_finished.wait(timeout=5)
            else:
                second_finished.set()
            result = self.payload()
            result['hourly']['wind_speed_10m'] = [lat, lat]
            return result
        with mock.patch.object(wind, 'BATCH_SIZE', 1), mock.patch.object(wind, 'request_json', side_effect=request):
            times, rows = wind.collect_points([(1, -100), (2, -100)], 'gfs_seamless', 'start', 'end')
        self.assertTrue(second_finished.is_set())
        self.assertEqual(wind.BATCH_WORKERS, 2)
        self.assertEqual([row[0][0] for row in rows], [-1, -2])


if __name__ == '__main__':
    unittest.main()
