import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import official_wind_mediterranean as m
NOW=dt.datetime(2026,10,31,11,30,tzinfo=dt.timezone.utc)

class MediterraneanWind(unittest.TestCase):
 def cy(self,speed='10',unit='Knots',date='2026-10-31 13:20'):
  return f'''<meteorology><stations><station><station_code>ACHNA</station_code><station_latitude>35.0255</station_latitude><station_longitude>33.7744</station_longitude></station></stations><observations><station_code>ACHNA</station_code><date_time>{date} (Local Time)</date_time><observation><observation_name>Wind Speed (10m)</observation_name><observation_unit>{unit}</observation_unit><observation_value>{speed}</observation_value></observation><observation><observation_name>Wind Direction (10m)</observation_name><observation_unit>Degrees</observation_unit><observation_value>155</observation_value></observation><observation><observation_name>Wind Speed (2m)</observation_name><observation_unit>m/s</observation_unit><observation_value>99</observation_value></observation><observation><observation_name>Extreme Day Max. Wind</observation_name><observation_unit>Knots</observation_unit><observation_value>99</observation_value></observation></observations></meteorology>'''
 def test_cyprus_ten_metre_knots_native_local_time_and_no_invented_gust(self):
  s=m.parse_cyprus(self.cy(),NOW)[0];r=s['rows'][0]
  self.assertAlmostEqual(r[1],5.14,places=2);self.assertEqual(r[0],int(NOW.timestamp())-600);self.assertIsNone(r[2]);self.assertEqual(r[3],155)
  self.assertIn('CC BY 4.0',s['period'])
 def test_cyprus_calm_missing_units_stale_future_and_ambiguous_location(self):
  self.assertEqual(m.parse_cyprus(self.cy('0'),NOW)[0]['rows'][0][1:],[0,None,None])
  for raw in [self.cy('-999'),self.cy(unit='m/s'),self.cy(date='2026-10-31 17:20'),self.cy(date='2026-10-30 13:20')]:self.assertFalse(m.parse_cyprus(raw,NOW))
  raw=self.cy().replace('</stations>','<station><station_code>ACHNA</station_code><station_latitude>35.1</station_latitude><station_longitude>33.8</station_longitude></station></stations>')
  self.assertFalse(m.parse_cyprus(raw,NOW))
 def tr(self):
  return [dict(sondurumIstNo=17020,modelId=99999,enlem=41.6,boylam=32.3,il='Bartın',ilce='Merkez')],[dict(istNo=17020,veriZamani='2026-10-31T11:20:00.000Z',ruzgarHiz=36,ruzgarYon=333,gust=99)]
 def test_turkey_measured_speed_kmh_native_utc_no_gust_substitution(self):
  meta,rows=self.tr();s=m.parse_turkey(meta,rows,NOW)[0]
  self.assertEqual(s['rows'][0],[int(NOW.timestamp())-600,10,None,333]);self.assertEqual(s['code'],'MGM-17020')
  rows[0]['ruzgarHiz']=0;self.assertEqual(m.parse_turkey(meta,rows,NOW)[0]['rows'][0][1:],[0,None,None])
 def test_turkey_sentinels_identity_timezone_future_and_coordinates(self):
  for field,value in [('ruzgarHiz',-9999),('istNo',99999),('veriZamani','2026-10-31T11:20:00'),('veriZamani','2026-10-31T12:00:00Z')]:
   meta,rows=self.tr();rows[0][field]=value;self.assertFalse(m.parse_turkey(meta,rows,NOW))
  meta,rows=self.tr();meta[0]['enlem']=59;self.assertFalse(m.parse_turkey(meta,rows,NOW))
  meta,rows=self.tr();meta.append(dict(meta[0],boylam=33));self.assertFalse(m.parse_turkey(meta,rows,NOW))
 def test_six_hour_synop_retains_original_time_and_excludes_foreign_stations(self):
  raw='SMTU60 LTAA 310600\nAAXX 31064\n17020 11670 70000 10149 333 91120 92428=\n17500 11670 70000 10149 333 91199='
  metadata=json.loads(Path(m.__file__).with_name('mediterranean_wind_stations.json').read_text())['stations']['TR']
  rows=m.synop(raw,NOW,('SMTU60','LTAA'),metadata,NOW);self.assertEqual([c for c,r in rows],['17020']);r=rows[0][1]
  self.assertAlmostEqual(r[2],20*1852/3600)
  s=m.finish('TR','SYNOP-17020',metadata['17020'],[r],NOW,'synop');self.assertIsNotNone(s)
  self.assertIsNone(m.finish('TR','MGM-17020',metadata['17020'],[r],NOW))
  self.assertIsNone(m.finish('TR','SYNOP-17020',metadata['17020'],[r],NOW+dt.timedelta(hours=2),'synop'))
 def test_national_failure_keeps_official_airport_wind_and_explicit_gust(self):
  def fail(*args):raise ValueError('unavailable')
  raw='raw_text,station_id,observation_time,wind_speed_kt,wind_gust_kt,wind_dir_degrees,metar_type\nMETAR,LMML,2026-10-31T11:20:00Z,10,20,90,METAR\n'
  rows=m.load('MT',NOW,download=fail,aviation_data=lambda _ :([dict(icaoId='LMML',country='MT',site='Luqa',lat=35.858,lon=14.477)],raw))
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['code'],'METAR-LMML');self.assertAlmostEqual(rows[0]['rows'][0][2],10.29,places=2)
 def test_metadata_has_only_in_bounds_verified_country_stations(self):
  metadata=json.loads(Path(m.__file__).with_name('mediterranean_wind_stations.json').read_text())['stations']
  for c in ('MT','CY','TR'):
   s,n,w,e=m.BOUNDS[c];self.assertTrue(metadata[c]);self.assertTrue(all(s<=x['lat']<=n and w<=x['lon']<=e for x in metadata[c].values()))

if __name__=='__main__':unittest.main()
