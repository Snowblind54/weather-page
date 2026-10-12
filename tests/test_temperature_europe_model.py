import importlib.util
import json
import sys
import tempfile
import urllib.error
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import update_temperature_europe_model as model


class EuropeModelTests(unittest.TestCase):
    def test_timeout_is_retried_and_recovers(self):
        import io
        with patch.object(model.urllib.request, 'urlopen', side_effect=[
                TimeoutError('slow provider'), io.BytesIO(b'{"ok":true}')]) as fetch, patch.object(model.time, 'sleep') as sleep:
            self.assertEqual(model.fetch_samples('request'), {'ok': True})
            self.assertEqual(fetch.call_count, 2)
            sleep.assert_called_once_with(20)

    def test_rate_limit_respects_retry_after_and_permanent_errors_fail(self):
        import io
        error = urllib.error.HTTPError('url', 429, 'rate limit', {'Retry-After': '60'}, None)
        with patch.object(model.urllib.request, 'urlopen', side_effect=[error, io.BytesIO(b'[]')]), patch.object(model.time, 'sleep') as sleep:
            self.assertEqual(model.fetch_samples('request'), [])
            sleep.assert_called_once_with(60)
        error = urllib.error.HTTPError('url', 400, 'bad request', {}, None)
        with patch.object(model.urllib.request, 'urlopen', side_effect=error) as fetch, patch.object(model.time, 'sleep'):
            with self.assertRaises(urllib.error.HTTPError): model.fetch_samples('request')
            self.assertEqual(fetch.call_count, 1)

    def test_exhausted_timeout_preserves_snapshot_and_skips_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root/'config.json'
            config.write_text(json.dumps({'grids': {'test': [[0, 0], [1, 1], 1, 1]}, 'cities': [[0, 0]]}))
            item = lambda lat, lon: {'lat': lat, 'lon': lon, 'times': [100, 200], 'temps': [2, 3]}
            data = {'version': 1, 'generatedAt': 123, 'grids': {'test': {'latitudes': [0, 1], 'longitudes': [0, 1],
                    'series': [item(lat, lon) for lat in [0, 1] for lon in [0, 1]]}}, 'cities': [item(0, 0)]}
            output = root/'snapshot.json'; output.write_text(json.dumps(data)); original = output.read_bytes()
            result = root/'result'; summary = root/'summary'
            with patch.object(model, 'OUTPUT', output), patch.object(model, 'CONFIG', config), patch.dict(model.os.environ,
                    {'GITHUB_OUTPUT': str(result), 'GITHUB_STEP_SUMMARY': str(summary)}), patch.object(
                    model.urllib.request, 'urlopen', side_effect=TimeoutError('slow')) as fetch, patch.object(model.time, 'sleep'):
                model.main()
                self.assertEqual(fetch.call_count, 3)
                self.assertEqual(output.read_bytes(), original)
                self.assertEqual(result.read_text(), 'updated=false\n')
                self.assertIn('original data timestamp is unchanged', summary.read_text())
                output.write_text('{}')
                with self.assertRaises(model.ProviderUnavailable): model.main()

    def test_invalid_provider_payload_is_not_hidden_as_outage(self):
        import io
        with patch.object(model.urllib.request, 'urlopen', return_value=io.BytesIO(b'not json')), patch.object(model.time, 'sleep'):
            with self.assertRaises(ValueError): model.main()

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
