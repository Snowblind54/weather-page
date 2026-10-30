import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import moldova_belarus_temperature as m
NOW=dt.datetime(2026,10,30,8,20,tzinfo=dt.timezone.utc)
META={'33815':{'name':'Chișinău','lat':47.013889,'lon':28.85}}
HTML='''<section class="forecast"><h1>Moldova, vineri, 30.10.2026 10:00</h1><ul class="weather-map"><li><h4>Chisinau<span>30.10 10:00</span></h4><dt>Temperatura</dt><dd>0 °C</dd><dt>Confortul termic</dt><dd>-10 °C</dd></li></ul></section>'''
BY=[{'country':'BY','number':26850,'name':'Минск','LATITUDE':53.86,'LONGITUDE':27.53,'date':'2026-10-30T00:00:00.000Z','HH':6,'Temp':'%2b6.3'}]

class MoldovaBelarusTemperatures(unittest.TestCase):
 def test_moldova_uses_measured_zero_and_dated_local_hour(self):
  s=m.parse_moldova(HTML,META,NOW)[0]
  self.assertEqual(s['rows'],[[int(NOW.timestamp())-1200,0]])
  self.assertEqual(s['code'],'AMM-33815');self.assertAlmostEqual(s['lon'],28.85)
 def test_moldova_rejects_missing_stale_future_and_apparent_temperature(self):
  for text in [HTML.replace('<dd>0 °C</dd>','<dd>--</dd>'),HTML.replace('30.10.2026','29.10.2026'),HTML.replace('10:00','13:00'),HTML.replace('<dt>Temperatura</dt>','<dt>Confortul termic</dt>'),HTML.replace('30.10 10:00','30.10 09:00'),HTML.replace('Chisinau','Unknown')]:
   with self.assertRaises(ValueError):m.parse_moldova(text,META,NOW)
 def test_moldova_summer_timezone_and_ambiguous_autumn_hour(self):
  text=HTML.replace('30.10.2026 10:00','01.07.2026 10:00').replace('30.10 10:00','01.07 10:00')
  now=dt.datetime(2026,7,1,7,20,tzinfo=dt.timezone.utc)
  self.assertEqual(m.parse_moldova(text,META,now)[0]['rows'][0][0],int(now.timestamp())-1200)
  text=HTML.replace('30.10.2026 10:00','25.10.2026 02:00').replace('30.10 10:00','25.10 02:00')
  with self.assertRaises(ValueError):m.parse_moldova(text,META,dt.datetime(2026,10,25,2,tzinfo=dt.timezone.utc))
 def test_belarus_separate_utc_hour_and_encoded_sign(self):
  s=m.parse_belarus(BY,NOW)[0]
  self.assertEqual(s['rows'],[[int(NOW.timestamp())-8400,6.3]])
  self.assertEqual(s['code'],'SYNOP-26850')
  for v,expected in [('0',0),('-2.5',-2.5),('%2b0.1',.1)]:
   p=copy.deepcopy(BY);p[0]['Temp']=v;self.assertEqual(m.parse_belarus(p,NOW)[0]['rows'][0][1],expected)
 def test_belarus_rejects_bad_identity_coordinates_dates_and_missing_values(self):
  for k,v in [('Temp',None),('Temp',''),('Temp',False),('Temp','NaN'),('Temp','---'),('Temp','999'),('HH',24),('HH',True),('HH',9),('date','2026-10-29T00:00:00.000Z'),('date','2026-10-30T06:00:00.000Z'),('country','RU'),('number',None),('LATITUDE',None),('LONGITUDE',None),('LATITUDE',60),('LONGITUDE',20)]:
   p=copy.deepcopy(BY);p[0][k]=v
   with self.assertRaises(ValueError,msg=(k,v)):m.parse_belarus(p,NOW)
 def test_six_hour_old_belarus_report_does_not_reappear_and_duplicates_merge(self):
  with self.assertRaises(ValueError):m.parse_belarus(BY,NOW+dt.timedelta(hours=2))
  p=copy.deepcopy(BY)+copy.deepcopy(BY);p[1]['HH']=3
  s=m.parse_belarus(p,NOW);self.assertEqual(len(s),1);self.assertEqual(len(s[0]['rows']),2)
 def test_catalogue_validated_bounds_and_distinct_stations(self):
  a=json.loads(Path('scripts/moldova_temperature_stations.json').read_text())['stations'];self.assertEqual(len(a),14)
  self.assertTrue(all(45.4<=s['lat']<=48.6 and 26.5<=s['lon']<=30.3 for s in a.values()))
  self.assertEqual(len({(s['lat'],s['lon']) for s in a.values()}),len(a))
 def test_national_loaders_use_one_shared_download_each(self):
  for country,payload in [('MD',HTML.encode()),('BY',json.dumps(BY).encode())]:
   calls=[]
   result=m.load(country,NOW,lambda url:(calls.append(url),payload)[1]);self.assertEqual(len(calls),1);self.assertTrue(result)

if __name__=='__main__':unittest.main()
