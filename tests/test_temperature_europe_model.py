import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import update_temperature_europe_model as model


class EuropeModelTests(unittest.TestCase):
    def test_preserves_geometry_city_samples_and_land_downscaling(self):
        from urllib.parse import parse_qs, urlsplit
        requests = []
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps(self.body).encode()
        def fetch(request, timeout):
            params = parse_qs(urlsplit(request.full_url).query)
            requests.append(params)
            self.assertEqual(params['cell_selection'], ['land'])
            self.assertEqual(params['past_hours'], ['6'])
            count = len(params['latitude'][0].split(','))
            return Response([{'hourly': {'time': [100, 200], 'temperature_2m': [2, 3]}} for _ in range(count)])
        with patch.object(model.urllib.request, 'urlopen', fetch), patch.object(model.time, 'sleep'):
            result = model.collect()
        self.assertEqual(sum(len(g['series']) for g in result['grids'].values()), 449)
        self.assertEqual(len(result['cities']), 66)
        self.assertEqual(len(requests), 8)
        self.assertEqual(result['refreshMinutes'], 60)
    def test_incomplete_response_aborts_generation(self):
        import io
        with patch.object(model.urllib.request, 'urlopen', return_value=io.BytesIO(b'[]')):
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                model.collect()
