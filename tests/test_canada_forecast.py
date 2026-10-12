import datetime as dt
import pathlib,sys,tempfile,json,unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_canada_forecast as canada
import update_iceland_forecast as ifs

RUN=dt.datetime(2026,10,12,6,tzinfo=dt.timezone.utc)
def frames():
 lat=np.array([18.,40.,62.,84.]);lon=np.array([-190.,-150.,-110.,-70.,-30.]);result={}
 for hour in range(0,91,3):
  shape=(4,5);result[hour]={'lat':lat,'lon':lon,'2t':np.full(shape,270+hour/10),'10u':np.full(shape,4),'10v':np.zeros(shape),'tcc':np.full(shape,.5),'tp':np.full(shape,hour*.001),'10fg':np.full(shape,12),'gust_start':max(0,hour-3),'gust_end':hour}
 return result

class CanadaForecast(unittest.TestCase):
 def test_canada_render_reprojects_both_edges_without_changing_iceland(self):
  palette=np.array([[i,i,i,255] for i in range(64)],dtype=np.uint8)
  before=ifs.BOUNDS.copy()
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)/'wind.webp';ifs.render(np.array([[0.,0.],[30.,30.]]),[18,84],[-190,-30],'wind',palette,path,bounds=canada.BOUNDS,size=16)
   with Image.open(path) as im:self.assertEqual(im.getpixel((0,0))[0],63);self.assertEqual(im.getpixel((0,15))[0],0)
   self.assertEqual(ifs.BOUNDS,before);self.assertEqual(ifs.SIZE,2048)
 def test_canada_gusts_keep_native_values_periods_and_bounded_regional_grids(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);canada.write_gusts(frames(),RUN,root);files=list(root.glob('gust-grid*'));self.assertEqual(len(files),12)
   for path in files:
    data=json.loads(path.read_text());self.assertEqual(data['region'],'North America');self.assertEqual(len(data['samples']),30);self.assertEqual(data['samples'][0]['values'][0],12);self.assertEqual(data['samples'][0]['start'],'2026-10-12T06:00:00.000Z');self.assertEqual(data['samples'][0]['end'],'2026-10-12T09:00:00.000Z');self.assertGreaterEqual(data['longitudes'][0],data['bounds'][0]);self.assertLessEqual(data['longitudes'][-1],data['bounds'][2])
 def test_only_referenced_immutable_nordic_palettes_are_restored(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);paths={k:'data/forecast-cache/run/'+k+'-legend.webp' for k in ifs.FIELDS};calls=[]
   def restore(selected):
    calls.append(selected)
    for p in selected:(root/p).parent.mkdir(parents=True,exist_ok=True);Image.new('RGBA',(256,18),(50,70,90,255)).save(root/p,format='WEBP')
   palettes=canada.ensure_palettes({'legends':paths},root,restore);self.assertEqual(len(calls),1);self.assertEqual(palettes['wind'].shape,(64,4));canada.ensure_palettes({'legends':paths},root,restore);self.assertEqual(len(calls),1)
   paths['rain']='../outside.webp'
   with self.assertRaises(ValueError):canada.ensure_palettes({'legends':paths},root,restore)
 def test_complete_cycle_is_atomic_and_size_failure_preserves_previous_manifest(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);data=root/'data';data.mkdir();legends={k:'data/forecast-cache/run/'+k+'-legend.webp' for k in ifs.FIELDS};palettes={k:np.full((64,4),255,dtype=np.uint8) for k in ifs.FIELDS}
   for p in legends.values():(root/p).parent.mkdir(parents=True,exist_ok=True);Image.new('RGBA',(256,18),(255,255,255,255)).save(root/p,format='WEBP')
   old={'reference_time':'older','marker':'keep'};(data/'forecast-canada.json').write_text(json.dumps(old))
   with patch.object(canada,'MAX_BYTES',1):
    with self.assertRaisesRegex(ValueError,'200 MiB'):canada.publish(frames(),RUN,{'legends':legends},palettes,data,size=4)
   self.assertEqual(json.loads((data/'forecast-canada.json').read_text()),old);self.assertEqual(list((data/canada.ASSET_ROOT).iterdir()),[])
   manifest=canada.publish(frames(),RUN,{'legends':legends},palettes,data,size=4)
   self.assertEqual(len(manifest['cached_times']),87);self.assertEqual(manifest['cached_times'][-1],'2026-10-15T23:00:00.000Z');self.assertEqual(manifest['periods']['2026-10-12T10:00:00.000Z']['gust_start'],'2026-10-12T06:00:00.000Z');self.assertEqual(len(manifest['images']['wind']),87);self.assertTrue(canada.complete_previous(manifest,RUN,root))
   (root/next(iter(manifest['images']['clouds'].values()))).unlink();self.assertFalse(canada.complete_previous(manifest,RUN,root))

if __name__=='__main__':unittest.main()


class NorthAmericaCoverage(unittest.TestCase):
 def test_domain_covers_all_us_states_and_meets_iceland_without_overlapping(self):
  for lat,lon in [(25.8,-80.2),(32.7,-117.2),(40.7,-74),(64,-149),(20,-156),(52.8,173.2)]:
   if lon>170:lon-=360
   self.assertTrue(canada.BOUNDS[0]<=lon<=canada.BOUNDS[2] and canada.BOUNDS[1]<=lat<=canada.BOUNDS[3])
   self.assertTrue(any(west<=lon<=east and south<=lat<=north for west,south,east,north in canada.GUST_AREAS))
  self.assertEqual(canada.BOUNDS[2],ifs.BOUNDS[0]);self.assertEqual(canada.BOUNDS[1],ifs.BOUNDS[1]);self.assertEqual(canada.BOUNDS[3],ifs.BOUNDS[3])
 def test_decoder_unwraps_alaska_and_keeps_atlantic_edge_in_one_continuous_grid(self):
  raw_lon=np.array([169.75,170,179.75,180,180.25,329.75,330,330.25]);lat=np.repeat([18.,18.25],len(raw_lon));lon=np.tile(raw_lon,2);values=np.arange(len(lat),dtype=float)
  keys={'validityDate':20261012,'validityTime':1800,'dataDate':20261012,'dataTime':600,'units':'K','startStep':0,'endStep':12,'packingError':0.001}
  with patch.object(ifs.ec,'codes_new_from_message',return_value=object()),patch.object(ifs.ec,'codes_get',side_effect=lambda g,key:keys[key]),patch.object(ifs.ec,'codes_get_array',side_effect=lambda g,key:lat if key=='latitudes' else lon),patch.object(ifs.ec,'codes_get_values',return_value=values),patch.object(ifs.ec,'codes_release'):
   la,lo,grid,*_=ifs.decode(b'grib',RUN,12,canada.BOUNDS)
  self.assertEqual(lo.tolist(),[-190.25,-190.,-180.25,-180.,-179.75,-30.25,-30.]);self.assertEqual(grid.shape,(2,7));self.assertEqual(grid[0,1],1);self.assertEqual(grid[0,-1],6)
