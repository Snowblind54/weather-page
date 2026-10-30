import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import balkan_temperature as b
NOW=dt.datetime(2026,10,30,9,20,tzinfo=dt.timezone.utc)
RS_META={'13274':{'name':'Beograd','lat':44.8,'lon':20.466667}}
RS='''<feed xmlns="https://www.w3.org/2005/Atom"><title>RHMS of Serbia - Data from major meteorological stations 30.10.2026 10:00</title><updated>2026-10-30T10:14:00+01:00</updated><entry><title>Station: Beograd;</title><summary>Station ID: 13274; Temperature: 0 °C; Pressure: 1000 hPa; Humindex: -10 °C;</summary><updated>2026-10-30T10:14:02+01:00</updated></entry></feed>'''
BA_META={'14652':{'name':'Bjelašnica','lat':43.703611,'lon':18.256944}}
BA='''<table><tr><td><table><tr><td>Vrijeme u BiH 30.10.2026. u 10 <sup>h</sup></td></tr><tr><td>Grad</td><td>Smjer vjetra</td><td>Brzina vjetra (km/h)</td><td>Temperatura <sup>o</sup>C</td><td>Relativna vlažnost %</td><td>Pritisak hPa</td><td>Vrijeme</td></tr><tr><td>Bjelašnica</td><td>NE</td><td>11</td><td>0</td><td>100</td><td>797.0</td><td>magla</td></tr></table></td></tr></table>'''

class BalkanTemperatures(unittest.TestCase):
 def test_serbian_native_hour_not_publication_time_and_zero_not_humindex(self):
  s=b.parse_serbia(RS,RS_META,NOW)[0]
  self.assertEqual(s['rows'],[[int(NOW.timestamp())-1200,0]])
  self.assertEqual(s['code'],'RHMZ-13274')
 def test_serbian_station_identity_missing_units_stale_and_future(self):
  for text in [RS.replace('13274','99999'),RS.replace('Station: Beograd','Station: Airport'),RS.replace('Temperature: 0 °C','Temperature: --- °C'),RS.replace('Temperature: 0 °C','Temperature: 32 °F'),RS.replace('Temperature: 0 °C','Temperature: NaN °C'),RS.replace('30.10.2026 10:00','29.10.2026 10:00'),RS.replace('30.10.2026 10:00','30.10.2026 13:00')]:
   with self.assertRaises(ValueError):b.parse_serbia(text,RS_META,NOW)
 def test_bosnian_column_order_nested_table_and_zero(self):
  s=b.parse_bosnia(BA,BA_META,NOW)[0]
  self.assertEqual(s['rows'],[[int(NOW.timestamp())-1200,0]])
  self.assertEqual(s['code'],'FHMZ-14652');self.assertAlmostEqual(s['lat'],43.703611)
 def test_bosnian_missing_sentinel_unknown_dates_and_changed_columns(self):
  for text in [BA.replace('<td>0</td>','<td>-999</td>'),BA.replace('<td>0</td>','<td>-</td>'),BA.replace('<td>0</td>','<td></td>'),BA.replace('Bjelašnica','Unknown'),BA.replace('30.10.2026','29.10.2026'),BA.replace(' u 10 ',' u 13 '),BA.replace('Temperatura','Humindex')]:
   with self.assertRaises(ValueError):b.parse_bosnia(text,BA_META,NOW)
 def test_summer_offset_negative_decimal_and_duplicate_station(self):
  now=dt.datetime(2026,7,1,8,20,tzinfo=dt.timezone.utc)
  for raw,meta,parser in [(RS.replace('30.10.2026','01.07.2026').replace('Temperature: 0','Temperature: -2,5'),RS_META,b.parse_serbia),(BA.replace('30.10.2026','01.07.2026').replace('<td>0</td>','<td>-2,5</td>'),BA_META,b.parse_bosnia)]:
   s=parser(raw,meta,now)[0];self.assertEqual(s['rows'],[[int(now.timestamp())-1200,-2.5]])
  entry=RS[RS.index('<entry>'):RS.index('</entry>')+8]
  self.assertEqual(len(b.parse_serbia(RS.replace('</feed>',entry+'</feed>'),RS_META,NOW)),1)
 def test_ambiguous_autumn_hour_is_omitted_instead_of_guessing(self):
  now=dt.datetime(2026,10,25,2,tzinfo=dt.timezone.utc)
  for raw,meta,parser in [(RS.replace('30.10.2026 10:00','25.10.2026 02:00'),RS_META,b.parse_serbia),(BA.replace('30.10.2026. u 10','25.10.2026. u 02'),BA_META,b.parse_bosnia)]:
   with self.assertRaises(ValueError):parser(raw,meta,now)
 def test_country_catalogues_and_actual_mountain_location(self):
  meta=json.loads(Path('scripts/balkan_temperature_stations.json').read_text())['stations']
  self.assertEqual(len(meta['RS']),27);self.assertEqual(len(meta['BA']),17)
  for country,entries in meta.items():
   south,north,west,east=b.BOUNDS[country]
   self.assertTrue(all(south<=m['lat']<=north and west<=m['lon']<=east and m['metadataUrl'].startswith('https://') for m in entries.values()))
  self.assertAlmostEqual(meta['BA']['14652']['lat'],43+42/60+13/3600,places=6)
  self.assertNotIn('13382',meta['RS']) # Provider station profile lacks coordinates.
 def test_both_national_loaders_use_single_shared_download(self):
  for country in ('BA','RS'):
   calls=[]
   # Use the checked catalogue station names in each national-format fixture.
   raw=BA if country=='BA' else RS
   self.assertTrue(b.load(country,NOW,lambda url:(calls.append(url),raw.encode())[1]));self.assertEqual(calls,[b.URLS[country]])

if __name__=='__main__':unittest.main()
