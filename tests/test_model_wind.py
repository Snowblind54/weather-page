import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('model_wind', pathlib.Path(__file__).parents[1] / 'scripts/update_model_wind.py')
wind = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wind)


class ModelWindTests(unittest.TestCase):
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
        extra = {**grid, 'id': 'hemisphere', 'model': 'best_match'}
        def collect(points, model, start, end, times):
            return [100, 200], [[[3, 4, 8], [4, 5, 9]] for _ in points]
        with mock.patch.object(wind, 'WIND_GRIDS', [grid]), mock.patch.object(wind, 'WIND_EXTRA_GRIDS', [extra]), \
             mock.patch.object(wind, 'collect_points', side_effect=collect) as fetch:
            data = wind.build_snapshot(3600)
        self.assertEqual(len(fetch.call_args.args[0]), 2)
        self.assertEqual(data['version'], 6)
        self.assertEqual(len(data['grids']), 1)
        self.assertEqual(len(data['grids'][0]), 4)
        self.assertEqual(data['extraGrids'][0]['series'], data['grids'][0])

    def test_failed_collection_keeps_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'model-wind.json'
            output.write_text('last successful snapshot')
            with mock.patch.object(wind, 'OUTPUT', output), mock.patch.object(wind, 'build_snapshot', side_effect=RuntimeError('upstream')):
                with self.assertRaises(RuntimeError):
                    wind.main()
            self.assertEqual(output.read_text(), 'last successful snapshot')


if __name__ == '__main__':
    unittest.main()
