import sys,pathlib,unittest,tempfile
import numpy as np
from PIL import Image
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from forecast_precipitation import ecmwf_phase,nordic_phase,paint_phase,recolour_nordic

class PrecipitationTypes(unittest.TestCase):
 def test_ecmwf_categories_do_not_use_temperature_or_interpolate_codes(self):
  values=np.array([[0,1,3,5,6,7,8,12,255,4,2.5]])
  self.assertEqual(ecmwf_phase(values).tolist(),[[0,1,4,2,2,3,5,4,0,0,0]])
 def test_nordic_probability_colour_codes_distinguish_snow_transition_and_missing(self):
  pixels=np.array([[[0,136,255,255],[255,0,255,255],[0,0,0,255],[255,255,255,255],[0,0,0,0],[12,14,16,255]]],dtype=np.uint8)
  self.assertEqual(nordic_phase(Image.fromarray(pixels)).tolist(),[[1,2,3,3,0,0]])
 def test_snow_has_white_snowflakes_and_dry_pixels_remain_transparent(self):
  pixels=np.full((64,64,4),255,dtype=np.uint8);pixels[:,:,:3]=[20,100,220];pixels[:5,:,3]=0
  phase=np.full((64,64),2,dtype=np.uint8);phase[:,30:]=1
  output=np.array(paint_phase(Image.fromarray(pixels),phase))
  self.assertTrue(np.any(np.all(output[:,:,:3]==[234,94,218],axis=2)))
  self.assertTrue(np.any(np.all(output[5:,:30,:3]==255,axis=2)))
  self.assertTrue(np.all(output[:5,:,3]==0));np.testing.assert_array_equal(output[:,30:],pixels[:,30:])
 def test_freezing_mixed_and_unknown_have_different_colours(self):
  phase=np.array([[0,3,4,5]],dtype=np.uint8);rain=Image.new('RGBA',(4,1),(20,100,220,255));out=np.array(paint_phase(rain,phase))
  self.assertEqual(len(set(map(tuple,out[0,:,:3]))),4)
 def test_nordic_composite_is_written_without_changing_dry_areas(self):
  with tempfile.TemporaryDirectory() as tmp:
   rain=pathlib.Path(tmp)/'rain.webp';phase=pathlib.Path(tmp)/'phase.webp'
   Image.new('RGBA',(32,32),(10,90,200,255)).save(rain,lossless=True)
   Image.new('RGBA',(32,32),(255,0,255,255)).save(phase,lossless=True)
   recolour_nordic(rain,phase)
   with Image.open(rain) as im:self.assertEqual(im.getpixel((0,0))[:3],(234,94,218))

if __name__=='__main__':unittest.main()
