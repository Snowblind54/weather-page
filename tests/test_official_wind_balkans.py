import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import official_wind_balkans as b
from official_wind_eastern import synop
from official_wind_us import parse_us_metars
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,20,30,tzinfo=UTC)

class BalkanWind(unittest.TestCase):
 def ro(self,wind='3.1 m/s, directia : NV'):
  return {'success':True,'type':'FeatureCollection','date':'2026-10-30T22:00:00+02:00','features':[{'geometry':{'type':'Point','coordinates':['3113115.070000','5479112.020000']},'properties':{'nume':'Adamclisi','actualizat':'30-10-2026&nbsp;ora&nbsp;22:00','vant':wind,'tempe':99,'gust':99}}]}
 def test_romania_wind_units_projection_native_time_and_missing_gust(self):
  s=b.parse_romania(self.ro(),NOW)[0];self.assertEqual(s['rows'][0],[int(NOW.timestamp())-1800,3.1,None,315]);self.assertAlmostEqual(s['lat'],44.088268,places=5);self.assertEqual(s['country'],'RO')
  self.assertEqual(b.parse_romania(self.ro('0.0 m/s, directia : -'),NOW)[0]['rows'][0][1:],[0,None,None])
  self.assertFalse(b.parse_romania(self.ro('3.1 km/h, directia : NV'),NOW));self.assertFalse(b.parse_romania(self.ro('-999 m/s, directia : NV'),NOW))
  p=self.ro();p['features'][0]['geometry']['coordinates']=[0,0];self.assertFalse(b.parse_romania(p,NOW))
 def rs(self,wind='2',direction='N',hour='21:00'):
  return f'<feed xmlns="https://www.w3.org/2005/Atom"><title>RHMS of Serbia - Data from major meteorological stations 30.10.2026 {hour}</title><updated>2026-10-30T21:14:00+01:00</updated><entry><title>Station: Palić;</title><summary>Station ID: 13067; Wind direction: {direction}; Wind speed: {wind} m/s; Temperature: 99 °C;</summary></entry></feed>'
 def test_serbian_observed_title_not_later_publication_and_identity(self):
  meta={'13067':{'name':'Palić','lat':46.1,'lon':19.8}}
  s=b.parse_serbia(self.rs(),meta,NOW)[0];self.assertEqual(s['rows'][0],[int(NOW.timestamp())-1800,2,None,0])
  self.assertEqual(b.parse_serbia(self.rs('0','C'),meta,NOW)[0]['rows'][0][1:],[0,None,None])
  self.assertFalse(b.parse_serbia(self.rs().replace('Station: Palić','Station: Unknown'),meta,NOW))
  self.assertFalse(b.parse_serbia(self.rs('-999'),meta,NOW))
  self.assertFalse(b.parse_serbia(self.rs(hour='23:00'),meta,NOW))
 def bg(self,wind='1',direction='NW'):
  return f'<table><tr><th>Станция</th><th>Дата/час</th><th>Температура[°C]</th><th>Време</th><th>Вятър-скорост[m/s]</th><th>Вятър-посока</th><th>Налягане[hPa]</th></tr><tr><td>Vidin</td><td>30.10.2026 г.20ч.</td><td>99</td><td>rain</td><td>{wind}</td><td>{direction}</td><td>1016</td></tr></table>'
 def test_bulgarian_units_actual_local_time_zero_and_unknown_direction(self):
  meta={'15502':{'name':'Vidin','lat':43.98,'lon':22.85}}
  s=b.parse_bulgaria(self.bg(),meta,NOW)[0];self.assertEqual(s['rows'][0],[int(NOW.timestamp())-9000,1,None,315])
  self.assertEqual(b.parse_bulgaria(self.bg('0','тихо'),meta,NOW)[0]['rows'][0][1:],[0,None,None])
  self.assertIsNone(b.parse_bulgaria(self.bg('2','unknown'),meta,NOW)[0]['rows'][0][3])
  self.assertFalse(b.parse_bulgaria(self.bg().replace('[m/s]','[km/h]'),meta,NOW))
 def test_synop_gust_survives_sea_section_and_national_codes_are_not_gusts(self):
  raw='SMBU01 LZSO 301800\nAAXX 30181\n15502 11566 82501 10112 222// 00161 10401 333 91012 91115 555 91099='
  rows=synop(raw,NOW,('SMBU01','LZSO'),{'15502':{}},NOW);self.assertEqual(rows[0][1][1:],[1,12,250])
  self.assertIsNone(synop(raw.replace('333 91012 91115','333 91220'),NOW,('SMBU01','LZSO'),{'15502':{}},NOW)[0][1][2])
 def test_freshness_native_six_hour_report_and_stale_future_rejection(self):
  m={'name':'Romania','lat':46,'lon':25};t=int(NOW.timestamp())
  self.assertIsNotNone(b.finish('RO','SYNOP-15020',m,[(t-6*3600,2,5,30)],NOW,'synop'))
  self.assertIsNone(b.finish('RO','SYNOP-15020',m,[(t-7*3600-1,2,5,30)],NOW,'synop'))
  self.assertIsNone(b.finish('RO','ANM-test',m,[(t-4*3600,2,None,30)],NOW))
  self.assertIsNone(b.finish('RO','ANM-test',m,[(t+1,2,None,30)],NOW))
 def test_airport_knots_gust_and_calm_are_observations_not_temperature(self):
  raw='raw_text,station_id,observation_time,wind_speed_kt,wind_gust_kt,wind_dir_degrees,metar_type\nMETAR,LROP,2026-10-30T20:00:00Z,10,20,VRB,METAR\n'
  meta={'LROP':{'country':'RO','site':'Otopeni','lat':44.57,'lon':26.08}}
  r=parse_us_metars(raw,meta,NOW,'RO')[0]['rows'][0];self.assertAlmostEqual(r[1],5.14,places=2);self.assertAlmostEqual(r[2],10.29,places=2);self.assertIsNone(r[3])
  r=parse_us_metars(raw.replace(',10,20,VRB,',',0,,0,'),meta,NOW,'RO')[0]['rows'][0];self.assertEqual(r[1:3],[0,None])
 def test_national_and_synop_mean_gust_windows_do_not_get_merged(self):
  t=int(NOW.timestamp());m={'name':'Test','lat':46,'lon':25}
  a=b.finish('RO','ANM-test',m,[(t,2,None,30)],NOW);s=b.finish('RO','SYNOP-15020',m,[(t-7200,3,12,30)],NOW,'synop')
  merged=b.core.merge([], [a,s],NOW);self.assertEqual(len(merged),2);self.assertIsNone(merged[0]['rows'][0][2]);self.assertEqual(merged[1]['rows'][0][2],12)
 def test_national_feed_failure_retains_measured_airport_backup(self):
  raw='raw_text,station_id,observation_time,wind_speed_kt,wind_gust_kt,wind_dir_degrees,metar_type\nMETAR,LROP,2026-10-30T20:00:00Z,10,20,90,METAR\n'
  def fail(url):raise ValueError('unavailable')
  s=b.load('RO',NOW,download=fail,bulletin_download=fail,aviation_data=lambda _:([dict(icaoId='LROP',country='RO',site='Otopeni',lat=44.57,lon=26.08)],raw))
  self.assertEqual(len(s),1);self.assertEqual(s[0]['code'],'METAR-LROP');self.assertGreater(s[0]['rows'][0][2],10)

if __name__=='__main__':unittest.main()

class SouthernBalkanWind(unittest.TestCase):
 def test_greek_explicit_three_hour_gust_knots_and_unknown_period(self):
  raw='SMGR55 LGAT 301800\nAAXX 30184\n16606 17/// /0000 10125 333 90730 91120 555 91199='
  args=(raw,NOW,('SMGR55','LGAT'),{'16606':{}},NOW)
  self.assertIsNone(synop(*args)[0][1][2])
  row=synop(*args,allowed_reference_periods=('30',))[0][1]
  self.assertEqual(row[1],0);self.assertAlmostEqual(row[2],20*1852/3600)
  self.assertIsNone(synop(raw.replace('90730','90766'),*args[1:],allowed_reference_periods=('30',))[0][1][2])
  self.assertIsNone(synop(raw.replace('90730','90730 90430'),*args[1:],allowed_reference_periods=('30',))[0][1][2])
 def test_new_country_metadata_bounds_and_no_foreign_station_in_bulletins(self):
  meta=json.loads(Path(b.__file__).with_name('southern_balkan_wind_stations.json').read_text())['stations']
  for country in ('MK','GR','AL'):
   south,north,west,east=b.BOUNDS[country]
   self.assertTrue(meta[country]);self.assertTrue(all(south<=m['lat']<=north and west<=m['lon']<=east for m in meta[country].values()))
  raw='SMMJ20 MJSK 301800\nAAXX 30181\n13571 12698 83104 10110 333 91012=\n13600 12698 83104 10110 333 91015='
  rows=synop(raw,NOW,('SMMJ20','MJSK'),meta['MK'],NOW)
  self.assertEqual([c for c,r in rows],['13571'])
  for country,point in [('MK',(41.99,21.62)),('GR',(35.34,25.18)),('AL',(41.42,19.72))]:
   s=b.finish(country,'SYNOP-test',dict(name=country,lat=point[0],lon=point[1]),[(int(NOW.timestamp())-7200,0,12,30)],NOW,'synop')
   self.assertEqual(s['rows'][0][1:3],[0,12])
   self.assertIsNone(b.finish(country,'bad',dict(name=country,lat=59,lon=25),s['rows'],NOW,'synop'))
 def test_greek_sparse_synop_age_is_not_applied_to_airport_reports(self):
  m=dict(name='Greece',lat=38,lon=24);t=int(NOW.timestamp())
  self.assertIsNotNone(b.finish('GR','SYNOP-16716',m,[(t-6*3600,2,5,90)],NOW,'synop'))
  self.assertIsNone(b.finish('GR','SYNOP-16716',m,[(t-7*3600-1,2,5,90)],NOW,'synop'))
  self.assertIsNone(b.finish('GR','METAR-LGAV',m,[(t-4*3600,2,5,90)],NOW))
