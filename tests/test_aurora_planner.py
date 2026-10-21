import importlib.util
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from datetime import datetime,timezone
import json

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import update_aurora_planner as clouds
import update_space_weather as space

class AuroraPlannerTests(unittest.TestCase):
    def test_native_bands_overlap_and_wrap_date_line(self):
        values=bytes(x%101 for y in range(clouds.HEIGHT) for x in range(clouds.WIDTH))
        self.assertEqual(len(clouds.split_cloud(values,0)),301*551)
        self.assertEqual(clouds.split_cloud(values,0)[300],clouds.split_cloud(values,1)[0])
        self.assertEqual(clouds.split_cloud(values,11)[300],clouds.split_cloud(values,0)[0])
        with self.assertRaises(ValueError):clouds.split_cloud(b'bad',0)

    def test_noaa_keeps_only_real_forecast_bins(self):
        now=datetime(2026,10,13,12,tzinfo=timezone.utc).timestamp()
        payload=[{'time_tag':'2026-10-13T12:00:00','kp':0,'observed':'predicted'},
                 {'time_tag':'2026-10-13T15:00:00','kp':4,'observed':'estimated'},
                 {'time_tag':'2026-10-13T18:00:00','kp':8,'observed':'observed'},
                 {'time_tag':'2026-10-13T21:00:00','kp':12,'observed':'predicted'},
                 {'time_tag':'2026-09-13T12:00:00','kp':5,'observed':'predicted'},
                 {'time_tag':'invalid','kp':3,'observed':'predicted'}]
        result=space.predicted_kp(payload,now)
        self.assertEqual(len(result['bins']),2)
        self.assertEqual(result['bins'][0]['value'],0)
        self.assertEqual(result['bins'][0]['start'],'2026-10-13T12:00:00Z')
        self.assertEqual(result['bins'][0]['end'],'2026-10-13T15:00:00Z')

    def test_failed_cloud_cycle_does_not_replace_last_successful_manifest(self):
        class Client:
            def __init__(self,**kwargs):pass
            def latest(self,**kwargs):return datetime(2026,10,13,tzinfo=timezone.utc)
            def retrieve(self,**kwargs):raise RuntimeError('provider unavailable')
        with TemporaryDirectory() as directory:
            root=Path(directory);(root/'data').mkdir();path=root/'data/aurora-planner.json';path.write_text('{"previous":true}')
            with patch.object(clouds,'ROOT',root),patch.object(clouds,'cloud_cycle',return_value=(datetime(2026,10,13,tzinfo=timezone.utc),.1,None,None)),patch.object(clouds,'read_cloud',side_effect=RuntimeError('provider unavailable')),patch.object(clouds.time,'sleep'):
                with self.assertRaises(RuntimeError):clouds.main()
            self.assertEqual(json.loads(path.read_text()),{'previous':True})
            self.assertFalse(list((root/'data/aurora-planner-cloud').glob('*.tmp')))

if __name__=='__main__':unittest.main()
