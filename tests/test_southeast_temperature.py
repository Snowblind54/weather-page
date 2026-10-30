import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import southeast_temperature as s
from europe_synop import TEMP
NOW=dt.datetime(2026,10,30,9,40,tzinfo=dt.timezone.utc)
META=json.loads(Path('scripts/southeast_temperature_stations.json').read_text())['stations']
BG='<table><tr><th>Станция</th><th>Дата/час</th><th>Температура[°C]</th><th>Време</th><th>Вятър-скорост[m/s]</th><th>Вятър-посока</th><th>Налягане[hPa]</th></tr><tr><td>Musala peak</td><td>30.10.2026 г.11ч.</td><td>0</td><td>snow</td><td>2</td><td>N</td><td>714.4</td></tr></table>'
MK='<p>Времето на мерење е UTC+1 (без менување на летно и зимско време)</p><table><tr><td>ИМЕ</td><td>ДЕН</td><td>ВРЕМЕ</td><td>ПРИТИСОК</td><td>ТЕМПЕРАТУРА</td><td>ВЛАГА</td><td>БРЗИНА</td><td>ПРАВЕЦ</td><td>ВРНЕЖИ</td><td>СНЕГ</td></tr><tr><td>Берово</td><td>30.10.2026</td><td>10:00</td><td>984</td><td>0</td><td>65</td><td>2.2</td><td>север</td><td>0</td><td></td></tr></table>'

def report(code='BKPR',**kw):return dict(icaoId=code,obsTime=int(NOW.timestamp())-600,temp=0,metarType='METAR',**kw)
def synop(value='0'):
 return f'surface;Parameter description;{TEMP}\n13610;Unit;Grad C\nDatum;Uhrzeit (UTC);Temperatur (2m)\n30.10.26;09:00;{value}\n'.encode()

class SoutheastTemperatures(unittest.TestCase):
 def test_national_measured_zero_not_pressure_precipitation_or_wind(self):
  for c,raw in [('BG',BG),('MK',MK)]:
   a=s.parse_national(c,raw,META[c],NOW);self.assertEqual(len(a),1);self.assertEqual(a[0]['rows'],[[int(NOW.timestamp())-2400,0]])
 def test_macdedonian_fixed_utc_plus_one_is_not_summer_dst(self):
  raw=MK.replace('30.10.2026','01.07.2026');now=dt.datetime(2026,7,1,9,40,tzinfo=dt.timezone.utc)
  self.assertEqual(s.parse_national('MK',raw,META['MK'],now)[0]['rows'][0][0],int(now.timestamp())-2400)
  with self.assertRaises(ValueError):s.parse_national('MK',raw.replace('UTC+1',''),META['MK'],now)
 def test_bulgarian_summer_local_clock_and_negative_decimal(self):
  raw=BG.replace('30.10.2026','01.07.2026').replace('<td>0</td>','<td>-2,5</td>');now=dt.datetime(2026,7,1,8,40,tzinfo=dt.timezone.utc)
  self.assertEqual(s.parse_national('BG',raw,META['BG'],now)[0]['rows'],[[int(now.timestamp())-2400,-2.5]])
 def test_national_stale_future_missing_unknown_and_changed_columns(self):
  for c,raw in [('BG',BG),('MK',MK)]:
   for text in [raw.replace('30.10.2026','29.10.2026'),raw.replace('30.10.2026','31.10.2026'),raw.replace('<td>0</td>','<td>---</td>'),raw.replace('<td>0</td>','<td>-999</td>'),raw.replace('Musala peak','Unknown').replace('Берово','Unknown')]:
    with self.assertRaises(ValueError):s.parse_national(c,text,META[c],NOW)
  with self.assertRaises(ValueError):s.parse_national('BG',BG.replace('[°C]','[°F]'),META['BG'],NOW)
 def test_airport_identity_measured_time_zero_and_missing_not_zero(self):
  a=s.parse_airports('XK',[report()],META['XK'],NOW);self.assertEqual(a[0]['rows'],[[int(NOW.timestamp())-600,0]]);self.assertEqual(a[0]['lat'],42.576)
  for k,v in [('icaoId','LATI'),('temp',None),('temp',False),('temp',''),('temp',float('nan')),('metarType','TAF'),('obsTime',int(NOW.timestamp())+120),('obsTime',int(NOW.timestamp())-8000)]:
   p=report();p[k]=v;self.assertEqual(s.parse_airports('XK',[p],META['XK'],NOW),[])
 def test_kukes_native_synop_zero_uses_current_airport_position_and_one_identity(self):
  def download(url):return synop('0.4') if 'BEOB.csv' in url else json.dumps([report('LAKU'),report('LATI')]).encode()
  a=s.load('AL',NOW,download);self.assertEqual(len(a),2)
  kukes=next(x for x in a if x['code']=='AIRPORT-LAKU');self.assertEqual(kukes['lat'],42.034);self.assertEqual(kukes['rows'][0][1],.4);self.assertEqual(kukes['rows'][-1][1],0)
 def test_three_hourly_kukes_remains_current_but_expires_without_fake_zero(self):
  now=NOW+dt.timedelta(hours=3)
  a=s.load('AL',now,lambda u:synop() if 'BEOB.csv' in u else b'[]');self.assertEqual(len(a),1)
  with self.assertRaises(ValueError):s.load('AL',now+dt.timedelta(hours=1),lambda u:synop() if 'BEOB.csv' in u else b'[]')
  with self.assertRaises(ValueError):s.load('AL',NOW,lambda u:synop('---') if 'BEOB.csv' in u else b'[]')
 def test_national_outage_retains_available_official_macedonian_airports(self):
  def download(url):
   if url==s.URLS['MK']:raise ValueError('temporary outage')
   return json.dumps([report('LWSK'),report('LWOH')]).encode()
  a=s.load('MK',NOW,download);self.assertEqual(len(a),2);self.assertTrue(all(x['code'].startswith('AIRPORT-') for x in a))
 def test_metadata_stays_inside_country_and_does_not_invent_national_networks(self):
  self.assertEqual(len(META['XK']),1);self.assertEqual(len(META['AL']),2)
  for c,entries in META.items():
   south,north,west,east=s.BOUNDS[c]
   self.assertTrue(all(south<=m['lat']<=north and west<=m['lon']<=east for m in entries.values()))
  self.assertAlmostEqual(META['BG']['15615']['lat'],42.183)
  self.assertNotIn('13578',META['MK']) # Airport record is not the Ohrid city station.

if __name__=='__main__':unittest.main()
