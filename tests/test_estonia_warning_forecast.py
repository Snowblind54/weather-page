import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('estonia_forecast', ROOT / 'scripts/update_estonia_warnings.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PAGE = (ROOT / 'tests/fixtures/estonia-official-warning-page.html').read_text()


class EstoniaForecastTests(unittest.TestCase):
    def test_grouped_forecast_expands_exactly_five_tomorrow_counties(self):
        days, records = module.parse_forecast(PAGE)
        counties = [r for r in records if r['id'] == '5111']
        self.assertEqual({r['area'] for r in counties}, {
            'Harju maakond', 'Hiiu maakond', 'Lääne maakond',
            'Pärnu maakond', 'Saare maakond'})
        self.assertEqual(len(counties), 5)  # Spanning-day duplicates removed.
        self.assertTrue(all(r['effective'] == '2026-10-05T18:00:00+00:00' for r in counties))
        self.assertTrue(all(r['expires'] == '2026-10-06T16:00:00+00:00' for r in counties))
        self.assertTrue(all(r['preAlert'] for r in counties))
        self.assertEqual(len(days), 4)

    def test_distinct_segments_and_all_marine_regions_survive(self):
        _, records = module.parse_forecast(PAGE)
        self.assertEqual(len([r for r in records if r['id'] == '5091']), 2)
        self.assertEqual({r['regionId'] for r in records if r['regionId'].startswith('999')},
                         {'99993', '99995', '99996', '99997', '99998', '99999'})
        self.assertEqual(len(records), 44)

    def test_empty_valid_forecast_and_nonpublic_rows(self):
        self.assertEqual(module.parse_forecast('_var["warningsData"] = {"2026-10-04":[]};')[1], [])
        self.assertEqual(module.parse_forecast('_var["warningsData"] = {"2026-10-04":{"DATA":{}}};')[1], [])
        self.assertEqual(module.parse_forecast('_var["warningsData"] = {"2026-10-04":{"DATA":[]}};')[1], [])
        data = json.JSONDecoder().raw_decode(PAGE[re.search(r'_var\["warningsData"\]\s*=\s*', PAGE).end():])[0]
        for day in data.values():
            for group in day['DATA'].values():
                for row in group['ROWS']:
                    row['status'] = 'DRAFT'
        self.assertEqual(module.parse_forecast('_var["warningsData"] = ' + json.dumps(data))[1], [])

    def test_missing_or_invalid_forecast_is_not_an_all_clear(self):
        for page in ('<html>Unavailable</html>', '_var["warningsData"] = {};', '_var["warningsData"] = null;'):
            with self.assertRaises(ValueError):
                module.parse_forecast(page)
        for bad in ('{"2026-10-04":[1]}', '{"2026-10-04":{}}', '{"2026-10-04":{"DATA":"bad"}}'):
            with self.assertRaises(ValueError):
                module.parse_forecast('_var["warningsData"] = ' + bad)
        with self.assertRaises(ValueError):
            module.parse_forecast(PAGE.replace('37,39,56,68,74', '12345'))


if __name__ == '__main__':
    unittest.main()
