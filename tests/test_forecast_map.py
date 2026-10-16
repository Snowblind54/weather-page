import importlib.util
import unittest
import tempfile
import json
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))

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

    def test_cache_rain_uses_ending_hour_and_mercator_bounds(self):
        from urllib.parse import urlparse,parse_qs
        manifest = {'endpoint':'https://thredds.met.no/example', 'bounds':[-11,52,42,74],
                    'layers':{k:v[0] for k,v in module.VARIABLES.items()}}
        t=datetime(2026,10,7,18,tzinfo=timezone.utc)
        params=parse_qs(urlparse(module.image_url(manifest,'rain',t)).query)
        self.assertEqual(params['time'],['2026-10-07T19:00:00.000Z'])
        self.assertEqual(params['srs'],['EPSG:3857'])
        self.assertEqual(len(params['bbox'][0].split(',')),4)
        self.assertEqual(parse_qs(urlparse(module.image_url(manifest,'temperature',t)).query)['colorscalerange'],['213.15,333.15'])

    def test_failed_download_keeps_previous_snapshot(self):
        manifest={'reference_time':'2026-10-07T18:00:00+00:00', 'endpoint':'https://thredds.met.no/example',
                  'time_dimension':'2026-10-07T18:00:00Z/2026-10-07T20:00:00Z/PT1H',
                  'bounds':[-11,52,42,74],'layers':{'wind':'wind_speed_10m'}}
        with tempfile.TemporaryDirectory() as directory:
            dest=Path(directory);(dest/'forecast-map.json').write_text('{"old":true}')
            def fail(*args): raise RuntimeError('source unavailable')
            with self.assertRaises(RuntimeError):module.publish_cache(manifest,dest,fail)
            self.assertEqual(json.loads((dest/'forecast-map.json').read_text()),{'old':True})
            self.assertEqual(list((dest/'forecast-cache').iterdir()),[])

    def test_complete_cache_contains_shared_frames_and_legends(self):
        manifest={'reference_time':'2026-10-07T18:00:00+00:00', 'endpoint':'https://thredds.met.no/example',
                  'time_dimension':'2026-10-07T18:00:00Z/2026-10-07T20:00:00Z/PT1H',
                  'bounds':[-11,52,42,74],'layers':{'rain':'precipitation_amount'}}
        with tempfile.TemporaryDirectory() as directory:
            dest=Path(directory)/'data';dest.mkdir()
            def save(url,path,size):path.write_bytes(b'valid test image')
            result=module.publish_cache(manifest,dest,save)
            self.assertTrue(module.cache_complete(result,dest))
            self.assertEqual(len(result['images']['rain']),2)
            self.assertIn('2026-10-07T19:00:00.000Z',result['images']['rain'])
            self.assertEqual(result['delivery'],'static-regional-images')

if __name__ == '__main__':
    unittest.main()



class SnowPhasePublication(unittest.TestCase):
    def test_probability_map_uses_the_rain_ending_hour_and_explicit_probability_thresholds(self):
        from urllib.parse import urlparse,parse_qs
        m={'endpoint':'https://thredds.met.no/example','bounds':[-11,52,42,74],'layers':{'rain':'precipitation_amount'},'snow_phase_variable':'probability_of_snow_phase'}
        p=parse_qs(urlparse(module.snow_phase_url(m,datetime(2026,10,7,18,tzinfo=timezone.utc))).query)
        self.assertEqual(p['time'],['2026-10-07T19:00:00.000Z']);self.assertEqual(p['colorscalerange'],['0.3,0.7'])
        self.assertEqual(p['layers'],['probability_of_snow_phase']);self.assertEqual(p['nodatacolor'],['transparent'])
    def test_complete_publication_colours_snow_and_does_not_publish_intermediate_phase_maps(self):
        from PIL import Image
        from urllib.parse import urlparse,parse_qs
        m={'reference_time':'2026-10-07T18:00:00+00:00','endpoint':'https://thredds.met.no/example','time_dimension':'2026-10-07T18:00:00Z/2026-10-07T20:00:00Z/PT1H','bounds':[-11,52,42,74],'layers':{'rain':'precipitation_amount'},'snow_phase_variable':'probability_of_snow_phase'}
        def save(url,path,size):
            query=parse_qs(urlparse(url).query);colour=(255,0,255,255) if query.get('layers')==['probability_of_snow_phase'] else (0,120,240,255)
            Image.new('RGBA',size,colour).save(path,lossless=True)
        with tempfile.TemporaryDirectory() as tmp,patch.object(module,'WIDTH',32),patch.object(module,'HEIGHT',32):
            data=Path(tmp)/'data';data.mkdir();result=module.publish_cache(m,data,save)
            self.assertEqual(result['precipitation_types']['version'],1)
            self.assertFalse(list((data/'forecast-cache').rglob('phase-*.webp')))
            with Image.open(data.parent/next(iter(result['images']['rain'].values()))) as im:self.assertEqual(im.getpixel((0,0))[:3],(234,94,218))
