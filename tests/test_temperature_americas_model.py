import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('americas',pathlib.Path(__file__).parents[1]/'scripts/update_temperature_americas_model.py')
model=importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


class AmericasModelTests(unittest.TestCase):
    def test_retries_transport_and_truncated_json_then_recovers(self):
        responses=[urllib.error.URLError(TimeoutError('TLS handshake timed out')),
                   contextlib.closing(io.BytesIO(b'{"hourly":')),
                   contextlib.closing(io.BytesIO(b'{"ok":true}'))]
        with patch.object(model.urllib.request,'urlopen',side_effect=responses) as request, patch.object(model.time,'sleep') as sleep:
            self.assertEqual(model.fetch_samples('request'),{'ok':True})
            self.assertEqual(request.call_count,3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list],[20,40])

    def test_retry_after_is_bounded_and_nonretryable_http_errors_fail(self):
        error=urllib.error.HTTPError('url',429,'rate limited',{'Retry-After':'900'},None)
        with patch.object(model.urllib.request,'urlopen',side_effect=[error,contextlib.closing(io.BytesIO(b'[]'))]), patch.object(model.time,'sleep') as sleep:
            self.assertEqual(model.fetch_samples('request'),[])
            sleep.assert_called_once_with(120)
        with patch.object(model.urllib.request,'urlopen',side_effect=urllib.error.HTTPError('url',403,'Forbidden',{},None)) as request:
            with self.assertRaises(urllib.error.HTTPError):model.fetch_samples('request')
            self.assertEqual(request.call_count,1)

    def test_collect_requests_extended_coverage_and_preserves_wind_vectors(self):
        now=int(time.time()//3600)*3600
        times=list(range(now-6*3600,now+24*3600,3600))
        def samples(request):
            params=urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
            self.assertEqual(params['forecast_hours'],['24'])
            self.assertEqual(params['past_hours'],['6'])
            count=len(params['latitude'][0].split(','))
            return [{'hourly':{'time':times,'temperature_2m':[0]*len(times),'wind_speed_10m':[5]*len(times),
                              'wind_direction_10m':[90]*len(times),'wind_gusts_10m':[10]*len(times)}} for _ in range(count)]
        with patch.object(model,'SPECS',{'canada':([41,-142],[42,-140],1,2),'greenland':([59,-74],[60,-72],1,2)}), patch.object(model,'fetch_samples',side_effect=samples), patch.object(model.time,'sleep'):
            data=model.collect()
        self.assertEqual(set(data['grids']),{'canada','greenland'})
        for grid in data['grids'].values():
            self.assertEqual(len(grid['series']),4)
            self.assertEqual(grid['series'][0]['temps'],[0]*30)
            self.assertEqual(grid['series'][0]['wind'][0],[-5.0,0.0,10])

    def test_failed_collection_never_overwrites_last_successful_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            output=pathlib.Path(directory)/'snapshot.json'
            output.write_text('previous snapshot')
            with patch.object(model,'OUTPUT',output), patch.object(model,'collect',side_effect=RuntimeError('provider offline')):
                with self.assertRaises(RuntimeError):model.main()
            self.assertEqual(output.read_text(),'previous snapshot')

    def test_exhausted_retries_are_bounded(self):
        with patch.object(model.urllib.request,'urlopen',side_effect=TimeoutError('offline')) as request, patch.object(model.time,'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError,'three attempts'):model.fetch_samples('request')
            self.assertEqual(request.call_count,3)
            self.assertEqual(sleep.call_count,2)
