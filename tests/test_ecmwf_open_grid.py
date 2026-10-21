import sys
import json
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import ecmwf_open_grid as tiers

class SourceSelectionTests(unittest.TestCase):
    now=datetime(2026,10,21,12,tzinfo=timezone.utc)
    newest=datetime(2026,10,21,6,tzinfo=timezone.utc)

    def test_surface_layout_and_legacy_fallback(self):
        fine=tiers.url('https://example/',self.newest,3,'index')
        self.assertIn('/ifs/0p1/oper/',fine)
        self.assertTrue(fine.endswith('-3h-oper-fc-sfc.index'))
        coarse=tiers.url('https://example/',self.newest,3,'grib2',.25)
        self.assertIn('/ifs/0p25/oper/',coarse)
        self.assertTrue(coarse.endswith('-3h-oper-fc.grib2'))
        with self.assertRaises(ValueError):tiers.url('',self.newest,0,'index',.5)

    def test_previous_complete_fine_cycle_precedes_new_coarse_cycle(self):
        def probe(run,step,res):
            if run==self.newest and res==.1:raise ValueError('not published')
            return {'step':step}
        run,res,first,last=tiers.choose_cycle(self.now,probe)
        self.assertEqual((run,res),(self.newest-timedelta(hours=6),.1))
        self.assertEqual((first['step'],last['step']),(0,90))

    def test_fallback_never_mixes_tiers_and_checks_final_step(self):
        calls=[]
        def probe(run,step,res):
            calls.append((run,step,res))
            if res==.1 and step==90:raise ValueError('incomplete')
            return step
        self.assertEqual(tiers.choose_cycle(self.now,probe)[:2],(self.newest,.25))
        self.assertIn((self.newest,90,.1),calls)

    def test_cached_coarse_does_not_prevent_fine_upgrade(self):
        result=tiers.choose_cycle(self.now,lambda *args: 'fine',cached=lambda run,res:res==.25)
        self.assertEqual(result[1:],(.1,'fine','fine'))

    def test_insufficient_horizon_retains_previous_publication(self):
        with self.assertRaises(RuntimeError):
            tiers.choose_cycle(self.now,lambda *args: {},horizon=72,minimum_hours=72)

    def test_index_validates_fields_and_retains_actual_download_url(self):
        rows=[{'param':p,'levtype':'sfc','_offset':0,'_length':20} for p in ['2t','tcc']]
        request=lambda url: '\n'.join(map(json.dumps,rows)).encode()
        result=tiers.index('https://example/',self.newest,3,request,{'2t','tcc'})
        self.assertEqual(result['tcc']['_grid_spacing'],.1)
        self.assertTrue(result['tcc']['_grib_url'].endswith('-sfc.grib2'))
        with self.assertRaises(ValueError):tiers.index('',self.newest,3,request,{'10fg'},.25)
        self.assertEqual(tiers.index('',self.newest,0,request,{'2t','10fg'},.25).keys(),{'2t'})

if __name__=='__main__':unittest.main()
