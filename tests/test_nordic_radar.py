"""Cache parsing, missing data and corrected Icelandic scan selection."""
import pathlib
import sys
import unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_nordic_radar as radar


class NordicRadar(unittest.TestCase):
    def test_imo_only_corrected_reflectivity_and_acquisition_minute(self):
        raw = '<a href="T_PAGZ41_C_BIRK_20261003223002.h5">radar</a><a href="T_PAJZ41_C_BIRK_20261003223002.h5">TH</a>'
        frames = radar.parse_imo(raw,'2026-10-03','iskef',1791066600,1791067000)
        self.assertEqual(len(frames),1)
        self.assertEqual(frames[0]['time'],1791066600)
        self.assertEqual(frames[0]['station'],'iskef')
        self.assertEqual(radar.parse_imo(raw,'2026-10-03','iskef',1791066700,1791067000),[])

    def test_dmi_keeps_observation_time_and_rejects_external_asset(self):
        feature = {'properties':{'datetime':'2026-10-03T22:30:00Z'},'asset':{'data':{'href':'https://opendataapi.dmi.dk/v1/radardata/download/test.h5'}}}
        frames=radar.parse_dmi({'features':[feature]},1791066000,1791067000)
        self.assertEqual(frames[0]['time'],1791066600)
        feature['asset']['data']['href']='https://example.com/fake.h5'
        self.assertEqual(radar.parse_dmi({'features':[feature]},1791066000,1791067000),[])

    def test_polar_interpolation_preserves_missing_and_zero_echo(self):
        try: import numpy as np
        except ImportError: self.skipTest('Optional radar rendering dependencies are absent')
        values=np.array([[20,20],[20,20],[20,20],[0,0]],dtype=np.uint8)
        what={'gain':1,'offset':0,'nodata':255,'undetect':0}
        args=([0,90,180,270],[90,180,270,360],np.array([0.]),np.array([1.]))
        rate=radar.polar_rates(values,what,{},*args)[0]
        self.assertGreater(rate,0);self.assertLess(rate,(100/200)**(1/1.6))
        values[0,0]=255
        self.assertTrue(np.isnan(radar.polar_rates(values,what,{},*args)[0]))

    def test_nodata_undetect_and_light_rain(self):
        try: import numpy as np
        except ImportError: self.skipTest('Radar image dependencies are installed by the radar workflow')
        colours=radar.colour_rates(np.array([255,0,110]),{'gain':.5,'offset':-32,'nodata':255,'undetect':0},{})
        self.assertEqual(colours[:,3].tolist(),[0,0,210])
        self.assertEqual(colours[2,:3].tolist(),[232,247,0])


if __name__=='__main__': unittest.main()
