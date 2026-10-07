import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

spec=importlib.util.spec_from_file_location('iceland',Path(__file__).resolve().parents[1]/'scripts/update_iceland_forecast.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class IcelandForecastTests(unittest.TestCase):
    def test_hourly_wind_interpolates_components_not_speed(self):
        lower={'2t':np.array([[270.]]),'10u':np.array([[4.]]),'10v':np.array([[0.]]),
               'tp':np.array([[.003]]),'tcc':np.array([[.2]])}
        upper={'2t':np.array([[282.]]),'10u':np.array([[-4.]]),'10v':np.array([[0.]]),
               'tp':np.array([[.009]]),'tcc':np.array([[.8]]),'10fg':np.array([[12.]])}
        fields=m.hourly_fields(lower,upper,.5)
        self.assertAlmostEqual(fields['wind'][0,0],0)
        self.assertAlmostEqual(fields['temperature'][0,0],276)
        self.assertAlmostEqual(fields['clouds'][0,0],.5)
        self.assertAlmostEqual(fields['rain'][0,0],2)  # 6 mm over 3 hours, not 6 mm/h.

    def test_decreasing_accumulation_does_not_make_up_rain(self):
        a={k:np.array([[0.]]) for k in ['2t','10u','10v','tp','tcc']}
        b={**a,'tp':np.array([[-.001]]),'10fg':np.array([[5.]])}
        with self.assertRaises(ValueError):m.hourly_fields(a,b,.5)

    def test_grib_rounding_decrease_is_zero_within_both_error_bounds(self):
        a={k:np.array([[0.]]) for k in ['2t','10u','10v','tp','tcc']}
        a['tp_packing_error']=2**-18
        b={**a,'tp':np.array([[-1.52587890625e-5]]),'tp_packing_error':2**-17,'10fg':np.array([[5.]])}
        self.assertEqual(m.hourly_fields(a,b,.5)['rain'][0,0],0)
        b['tp']=np.array([[-3e-5]])
        with self.assertRaises(ValueError):m.hourly_fields(a,b,.5)

    def test_render_keeps_mercator_north_at_top_and_rain_transparent(self):
        palette=np.array([[i,i,i,255] for i in range(64)],dtype=np.uint8)
        lat=np.array([61.,69.]);lon=np.array([-28.,-12.])
        grid=np.array([[0.,0.],[30.,30.]])
        with tempfile.TemporaryDirectory() as directory,patch.object(m,'SIZE',16):
            path=Path(directory)/'wind.webp';m.render(grid,lat,lon,'wind',palette,path)
            with Image.open(path) as im:
                self.assertEqual(im.getpixel((0,0))[0],63)
                self.assertEqual(im.getpixel((0,15))[0],0)
            m.render(np.zeros((2,2)),lat,lon,'rain',palette,path)
            with Image.open(path) as im:self.assertEqual(im.getpixel((4,4))[3],0)

if __name__=='__main__':unittest.main()
