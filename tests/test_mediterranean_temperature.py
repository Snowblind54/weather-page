import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import mediterranean_temperature as m
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,13,50,tzinfo=UTC)
CY='''<meteorology><stations><station><station_code>AGROS</station_code><station_latitude>34.914875</station_latitude><station_longitude>33.0156667</station_longitude></station></stations><observations><station_code>AGROS</station_code><date_time>2026-10-30 15:40 (Local Time)</date_time><observation><observation_name>Air Temperature (5cm)</observation_name><observation_value>35</observation_value><observation_unit>Celcius</observation_unit></observation><observation><observation_name>Extreme Day Max. Temp.</observation_name><observation_value>30</observation_value><observation_unit>Celcius</observation_unit></observation><observation><observation_name>Air Temperature (1.2m)</observation_name><observation_value>0</observation_value><observation_unit>Celcius</observation_unit></observation></observations></meteorology>'''
TR_META=[{'sondurumIstNo':17112,'merkezId':91701,'gunlukTahminIstNo':91701,'il':'Çanakkale','ilce':'Merkez','enlem':40.141,'boylam':26.3993}]
TR=[{'istNo':17112,'sicaklik':0,'hissedilenSicaklik':99,'denizSicaklik':25,'denizVeriZamani':'2026-10-30T06:00:00Z','veriZamani':'2026-10-30T13:49:00.000Z'}]
MT=[{'icaoId':'LMML','metarType':'METAR','obsTime':int(NOW.timestamp())-300,'reportTime':'2026-10-30T15:00:00Z','temp':0}]

class MediterraneanTemperatures(unittest.TestCase):
 def test_cyprus_shelter_height_zero_native_local_hour_and_coordinates(self):
  a=m.parse_cyprus(CY,NOW)[0];self.assertEqual(a['rows'],[[int(NOW.timestamp())-600,0]])
  self.assertAlmostEqual(a['lat'],34.914875);self.assertIn('1.2 m',a['source']);self.assertIn('CC BY 4.0',a['source'])
 def test_cyprus_summer_time_and_ambiguous_autumn_hour(self):
  text=CY.replace('2026-10-30','2026-07-01');now=dt.datetime(2026,7,1,12,50,tzinfo=UTC)
  self.assertEqual(m.parse_cyprus(text,now)[0]['rows'][0][0],int(now.timestamp())-600)
  text=CY.replace('2026-10-30 15:40','2026-10-25 03:40')
  with self.assertRaises(ValueError):m.parse_cyprus(text,dt.datetime(2026,10,25,2,tzinfo=UTC))
 def test_cyprus_missing_wrong_height_units_identity_stale_and_future(self):
  for text in [CY.replace('<observation_value>0</observation_value>','<observation_value>---</observation_value>'),CY.replace('Air Temperature (1.2m)','Air Temperature (5cm)'),CY.replace('Celcius','Fahrenheit'),CY.replace('2026-10-30','2026-10-29'),CY.replace('2026-10-30','2026-10-31'),CY.replace('34.914875','54.914875')]:
   with self.assertRaises(ValueError):m.parse_cyprus(text,NOW)
  with self.assertRaises(ValueError):m.parse_cyprus(CY.replace('<observations><station_code>AGROS','<observations><station_code>UNKNOWN'),NOW)
 def test_turkey_matches_observation_id_and_uses_measured_zero_and_utc(self):
  a=m.parse_turkey(TR_META,TR,NOW)[0];self.assertEqual(a['rows'],[[int(NOW.timestamp())-60,0]])
  self.assertEqual(a['code'],'MGM-17112');self.assertEqual(a['name'],'Çanakkale')
  p=copy.deepcopy(TR);p[0]['veriZamani']='2026-10-30T16:49:00+03:00'
  self.assertEqual(m.parse_turkey(TR_META,p,NOW)[0]['rows'][0][0],int(NOW.timestamp())-60)
 def test_turkey_does_not_join_forecast_identifiers_or_use_apparent_temperature(self):
  for field,value in [('istNo',91701),('sicaklik',None),('sicaklik',False),('sicaklik',''),('sicaklik',-9999),('sicaklik',float('nan')),('sicaklik',9999),('veriZamani','2026-10-30T13:49:00'),('veriZamani','2026-10-30T10:00:00Z'),('veriZamani','2026-10-30T15:00:00Z')]:
   p=copy.deepcopy(TR);p[0][field]=value
   with self.assertRaises(ValueError):m.parse_turkey(TR_META,p,NOW)
 def test_turkish_duplicate_and_out_of_country_metadata_is_not_guessed(self):
  p=copy.deepcopy(TR_META);p[0]['enlem']=50
  with self.assertRaises(ValueError):m.parse_turkey(p,TR,NOW)
  p=copy.deepcopy(TR_META)+copy.deepcopy(TR_META);p[1]['enlem']=41
  with self.assertRaises(ValueError):m.parse_turkey(p,TR,NOW)
  self.assertEqual(len(m.parse_turkey(TR_META,TR+TR,NOW)[0]['rows']),1)
 def test_malta_is_one_official_airport_and_uses_obs_time_not_report_time(self):
  a=m.load('MT',NOW,lambda u:json.dumps(MT).encode());self.assertEqual(len(a),1)
  self.assertEqual(a[0]['code'],'AIRPORT-LMML');self.assertEqual(a[0]['rows'],[[int(NOW.timestamp())-300,0]])
  self.assertAlmostEqual(a[0]['lon'],14.477);self.assertIn('one station',a[0]['source'])
 def test_malta_missing_future_wrong_airport_and_forecasts_do_not_produce_zero(self):
  for field,value in [('icaoId','LATI'),('metarType','TAF'),('temp',None),('temp',False),('obsTime',int(NOW.timestamp())+600)]:
   p=copy.deepcopy(MT);p[0][field]=value
   with self.assertRaises(ValueError):m.load('MT',NOW,lambda u:json.dumps(p).encode())
 def test_national_data_is_shared_one_cypriot_download_and_two_turkish_downloads(self):
  calls=[]
  self.assertTrue(m.load('CY',NOW,lambda url:(calls.append(url),CY.encode())[1]));self.assertEqual(calls,[m.CY_URL])
  calls=[]
  def download(url):calls.append(url);return json.dumps(TR_META if url==m.TR_METADATA else TR).encode()
  self.assertTrue(m.load('TR',NOW,mgm_download=download));self.assertEqual(calls,[m.TR_METADATA,m.TR_OBSERVATIONS])

if __name__=='__main__':unittest.main()
