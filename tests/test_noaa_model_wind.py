import pathlib
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'scripts'))
import noaa_model_wind as wind


class NoaaWindTests(unittest.TestCase):
    def test_index_selects_10_m_not_10_mb_and_limits_downloads(self):
        index = '\n'.join(['1:0:d=x:UGRD:10 mb:x:', '2:100:d=x:UGRD:10 m above ground:x:',
                           '3:200:d=x:VGRD:10 m above ground:x:', '4:300:d=x:GUST:surface:x:', '5:400:d=x:TMP:surface:x:'])
        self.assertEqual(wind.wind_ranges(index), {'u': (100,199), 'v': (200,299), 'gust': (300,399)})
        with self.assertRaises(RuntimeError):
            wind.wind_ranges(index.replace('GUST', 'TMP'))

    def test_grid_north_is_rotated_to_true_north_and_east(self):
        u,v=wind.rotate_wind(np.array([0.,1.]), np.array([1.,0.]), np.radians([-30.,30.]))
        np.testing.assert_allclose(u,[-.5,np.sqrt(3)/2])
        np.testing.assert_allclose(v,[np.sqrt(3)/2,-.5])

    def sample(self, points, **changes):
        keys={'units':'m s**-1','typeOfLevel':'heightAboveGround','level':10,
              'jPointsAreConsecutive':0,'alternativeRowScanning':0,'Nx':4,'Ny':3,'missingValue':9999,
              'iScansNegatively':0,'jScansPositively':0,'latitudeOfFirstGridPointInDegrees':90,
              'longitudeOfFirstGridPointInDegrees':0,'gridType':'regular_ll',
              'iDirectionIncrementInDegrees':90,'jDirectionIncrementInDegrees':45,**changes}
        with mock.patch.object(wind.ec,'codes_new_from_message',return_value=1), \
             mock.patch.object(wind.ec,'codes_get',side_effect=lambda _,k:keys[k]), \
             mock.patch.object(wind.ec,'codes_get_values',return_value=np.arange(12.)), \
             mock.patch.object(wind.ec,'codes_release'), mock.patch.object(wind,'valid_time',return_value=100):
            return wind.sample_message(b'GRIB',points,100,'u')[0]

    def test_native_bilinear_sampling_handles_equator_dateline_and_bounds(self):
        samples=self.sample([(0,0),(45,-90),(45,270),(45,315),(-1,0),(91,0)])
        np.testing.assert_allclose(samples[:4],[8,7,7,5.5])
        self.assertTrue(np.isnan(samples[4:]).all())
        with self.assertRaises(RuntimeError):
            self.sample([(40,-100)],units='km/h')
        with self.assertRaises(RuntimeError):
            self.sample([(40,-100)],level=100)

    def test_missing_values_remain_unavailable(self):
        self.assertTrue(np.isnan(self.sample([(0,0)],missingValue=8)[0]))

    def test_full_file_instead_of_range_is_rejected(self):
        response=mock.MagicMock(status=200, headers={})
        response.__enter__.return_value=response
        with mock.patch.object(wind.urllib.request,'urlopen',return_value=response),mock.patch.object(wind.time,'sleep'):
            with self.assertRaises(RuntimeError):
                wind.read_url('https://example.invalid/file',{'Range':'bytes=10-20'})
        response.read.assert_not_called()


if __name__ == '__main__':
    unittest.main()
