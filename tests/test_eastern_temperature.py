import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import eastern_temperature as e
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,8,20,tzinfo=UTC)
META={'33345':{'name':'Kyiv','lat':50.391792,'lon':30.535631}}
UA={'33345':{'CD':'2026-10-30','CT':8,'C_T':0}}
RO={'success':True,'type':'FeatureCollection','date':'2026-10-30T10:00:00+02:00','features':[{'geometry':{'type':'Point','coordinates':['3113115.070000','5479112.020000']},'properties':{'nume':'ADAMCLISI','actualizat':'30-10-2026&nbsp;ora&nbsp;10:00','tempe':'0'}}]}

class EasternTemperatures(unittest.TestCase):
 def test_ukraine_zero_native_kyiv_time_and_catalogued_station(self):
  s=e.parse_ukraine(UA,META,NOW)[0]
  self.assertEqual(s['country'],'UA');self.assertEqual(s['rows'],[[int(NOW.timestamp())-8400,0]])
  self.assertAlmostEqual(s['lon'],30.535631)
 def test_ukraine_missing_non_numeric_and_unknown_are_not_zero(self):
  for v in (None,'',False,'indisponibil',float('nan'),999):
   p=copy.deepcopy(UA);p['33345']['C_T']=v
   with self.assertRaises(ValueError):e.parse_ukraine(p,META,NOW)
  with self.assertRaises(ValueError):e.parse_ukraine({'99999':UA['33345']},META,NOW)
 def test_ukraine_stale_future_and_forecast_products_rejected(self):
  for p in [{'33345':{'CD':'2026-10-29','CT':8,'C_T':5}},{'33345':{'CD':'2026-10-30','CT':14,'C_T':5}},{'33345':{'2026-10-30':{'T_D':10}}}]:
   with self.assertRaises(ValueError):e.parse_ukraine(p,META,NOW)
 def test_summer_offset_and_ambiguous_autumn_hour(self):
  t=e.local_time(dt.datetime(2026,7,1,8),'Europe/Kyiv')
  self.assertEqual(dt.datetime.fromtimestamp(t,UTC).hour,5)
  with self.assertRaises(ValueError):e.local_time(dt.datetime(2026,10,25,3),'Europe/Kyiv')
 def test_romania_web_mercator_inverse_and_celsius_zero(self):
  s=e.parse_romania(RO,NOW)[0]
  self.assertAlmostEqual(s['lat'],44.088268,places=5);self.assertAlmostEqual(s['lon'],27.965588,places=5)
  self.assertEqual(s['rows'],[[int(NOW.timestamp())-1200,0]])
 def test_romania_uses_station_time_not_root_refresh(self):
  p=copy.deepcopy(RO);p['features'][0]['properties']['actualizat']='30-10-2026 ora 09:00'
  self.assertEqual(e.parse_romania(p,NOW)[0]['rows'][0][0],int(NOW.timestamp())-4800)
  p['features'][0]['properties']['actualizat']='29-10-2026 ora 09:00'
  with self.assertRaises(ValueError):e.parse_romania(p,NOW)
 def test_romania_rejects_wrong_axes_missing_and_future_values(self):
  for field,value in [('tempe','indisponibil'),('tempe',True),('actualizat','30-10-2026 ora 13:00')]:
   p=copy.deepcopy(RO);p['features'][0]['properties'][field]=value
   with self.assertRaises(ValueError):e.parse_romania(p,NOW)
  p=copy.deepcopy(RO);p['features'][0]['geometry']['coordinates']=[27.96,44.08]
  with self.assertRaises(ValueError):e.parse_romania(p,NOW)
 def test_romania_date_offset_resolves_repeated_hour(self):
  p=copy.deepcopy(RO);p['date']='2026-10-25T03:00:00+02:00';p['features'][0]['properties']['actualizat']='25-10-2026 ora 03:00'
  now=dt.datetime(2026,10,25,1,20,tzinfo=UTC)
  self.assertEqual(e.parse_romania(p,now)[0]['rows'][0][0],int(now.timestamp())-1200)
  p['date']='2026-10-25T03:00:00'
  with self.assertRaises(ValueError):e.parse_romania(p,now)
 def test_country_bounds_and_catalogue(self):
  m=json.loads(Path('scripts/ukraine_temperature_stations.json').read_text())['stations'];self.assertGreater(len(m),150)
  self.assertTrue(all(44<=s['lat']<=52.5 and 22<=s['lon']<=40.5 for s in m.values()))
  self.assertIsNone(e.make('RO','X','Foreign',59,24,[(int(NOW.timestamp()),1)],NOW))
 def test_corrections_preserve_station_identity_and_duplicate_is_removed(self):
  s=e.parse_romania(RO,NOW)[0];p=copy.deepcopy(RO);p['features'][0]['properties']['tempe']='-2.5';p['features'].append(copy.deepcopy(p['features'][0]))
  corrected=e.parse_romania(p,NOW);self.assertEqual(len(corrected),1);self.assertEqual(corrected[0]['code'],s['code']);self.assertEqual(corrected[0]['rows'][0][1],-2.5)

if __name__=='__main__':unittest.main()
