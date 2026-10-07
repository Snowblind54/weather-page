import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('forecast_map', Path(__file__).resolve().parents[1] / 'scripts/update_forecast_map.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ForecastMapTests(unittest.TestCase):
    def test_catalog_ignores_analysis_and_latest_alias(self):
        xml = '<catalog><dataset urlPath="metpplatest/met_analysis_1_0km_nordic_20261007T22Z.nc"/><dataset urlPath="metpplatest/met_forecast_1_0km_nordic_latest.nc"/><dataset urlPath="metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc"/></catalog>'
        self.assertEqual(module.discover(xml), ['metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc'])

    def test_units_and_future_time_validation(self):
        caps = {name: {'dimension': '2026-10-07T21:00:00Z/2026-10-10T07:00:00Z/PT1H', 'bounds': [-11,52,42,74]} for name, _ in module.VARIABLES.values()}
        das = '\n'.join(name + ' { String units "' + unit + '"; }' for name, unit in module.VARIABLES.values())
        now = datetime(2026,10,7,21,tzinfo=timezone.utc)
        result = module.build_manifest('metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc', caps, das, now)
        self.assertEqual(result['layers']['wind'], 'wind_speed_10m')
        with self.assertRaises(ValueError):
            module.build_manifest('metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc', caps, das.replace('"K"','"celsius"'), now)
        with self.assertRaises(ValueError):
            module.build_manifest('metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc', caps, das, datetime(2026,10,11,tzinfo=timezone.utc))

if __name__ == '__main__':
    unittest.main()
