import datetime as dt
import io
import json
from pathlib import Path
import sys
import unittest
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import rainfall_eastern as e
NOW=dt.datetime(2026,10,31,13,tzinfo=dt.timezone.utc)
T=int(NOW.timestamp())

class EasternRain(unittest.TestCase):
 def archive(self,rows,daily=False,day='20261030',field=None):
  field=field or ('rau' if daily else 'r');text='Time;StationNumber;StationName;Latitude;Longitude;'+field+';Q_'+field+'\n'+'\n'.join(rows)
  buf=io.BytesIO()
  with zipfile.ZipFile(buf,'w') as z:z.writestr('HABP_1D_'+day+'.csv' if daily else 'HABP_1H_SYNOP_20261031121603.csv',text)
  return buf.getvalue()
 def test_hungarian_hourly_native_units_calm_zero_missing_and_future(self):
  p=self.archive(['202610311200;12843;Budapest;47.5;19.1;2.4;','202610311100;12843;Budapest;47.5;19.1;0;','202610311000;12843;Budapest;47.5;19.1;-999;','202610311400;12843;Budapest;47.5;19.1;20;','202610310900;12843;Budapest;47.5;19.1;20;bad','202610311200;99999;Foreign;59;25;99;'])
  s=e.core.merge([],e.parse_hungary(p,NOW),NOW)[0];self.assertEqual(s['times'],[T-7200,T-3600]);self.assertEqual(s['amounts'],[0,2.4]);self.assertFalse(s.get('accumulations'))
 def test_daily_06utc_next_day_and_complete_48h_not_rolling_now(self):
  stations=[]
  for day,value in [('20261029',3),('20261030',5)]:stations+=e.parse_hungary(self.archive([day+';12843;Budapest;47.5;19.1;'+str(value)+';'],True,day),NOW,True,day)
  s=e.core.merge([],stations,NOW)[0];end=int(dt.datetime(2026,10,31,6,tzinfo=dt.timezone.utc).timestamp())
  self.assertIn(dict(end=end,hours=48,value=8),s['accumulations']);self.assertFalse(s['times']);self.assertFalse(any(p['end']==T for p in s['accumulations']))
  partial=e.core.merge([],stations[-1:],NOW)[0];self.assertFalse(any(p['hours']==48 for p in partial['accumulations']))
 def test_archive_identity_columns_future_and_station_move(self):
  raw=self.archive(['20261030;12843;Budapest;47.5;19.1;8;'],True)
  self.assertFalse(e.parse_hungary(raw,NOW,True,'20261029'))
  with self.assertRaises(ValueError):e.parse_hungary(self.archive([],field='temperature'),NOW)
  with self.assertRaises(ValueError):e.parse_hungary(self.archive(['202610311200;12843;Budapest;47.5;19.1;2;','202610311100;12843;Budapest;47.7;19.1;2;']),NOW)
 def test_raw_synop_measured_intervals_trace_and_no_national_or_foreign_false_rain(self):
  meta={'15020':dict(name='Botosani',lat=47.7,lon=26.7)}
  raw='SMRO01 YRBK 311200\nAAXX 31121\n15020 01570 83003 60011 333 69917 555 69999=\n99999 01570 83003 69991='
  s=e.parse_bulletin(raw,NOW,('SMRO01','YRBK'),meta,'RO',NOW)[0]
  self.assertFalse(s['times']);self.assertEqual(s['periods'],[dict(end=T-3600,hours=6,value=1),dict(end=T-3600,hours=3,value=.1)])
  raw=raw.replace('60011','69905');s=e.parse_bulletin(raw,NOW,('SMRO01','YRBK'),meta,'RO',NOW)[0];self.assertEqual(s['amounts'],[0]);self.assertEqual(s['traces'],[T-3600])
  # iR=4 means precipitation unavailable; section 5 local groups are excluded.
  self.assertFalse(e.parse_bulletin(raw.replace('01570','41570').replace('333 69917','333 91022'),NOW,('SMRO01','YRBK'),meta,'RO',NOW))
  with self.assertRaises(ValueError):e.parse_bulletin(raw,NOW-dt.timedelta(days=10),('SMRO01','YRBK'),meta,'RO',NOW)
  with self.assertRaises(ValueError):e.parse_bulletin(raw,NOW,('SMUR10','UKMS'),meta,'RO',NOW)
 def test_mixed_hourly_and_native_intervals_do_not_overlap_or_fill_gaps(self):
  s=e.core.station('UA','33345','Kyiv',50.4,30.5,[(T,1,False)]);s['periods']=[dict(end=T,hours=12,value=4),dict(end=T-12*3600,hours=12,value=3)]
  merged=e.core.merge([],[s],NOW)[0];self.assertIn(dict(end=T,hours=24,value=7),merged['accumulations']);self.assertFalse(any(p['hours']==48 for p in merged['accumulations']))
  self.assertEqual(merged['amounts'],[1])
 def test_verified_synop_locations_are_country_bounded(self):
  meta=json.loads(Path(e.__file__).with_name('eastern_rain_stations.json').read_text())['stations']
  for c in ('UA','RO'):self.assertTrue(meta[c]);self.assertTrue(all(e.location(c,m['lat'],m['lon']) for m in meta[c].values()))

if __name__=='__main__':unittest.main()

class UkraineWisRain(unittest.TestCase):
 def feature(self,hours=1,value=2,end=T):
  fmt=lambda t:dt.datetime.fromtimestamp(t,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
  return dict(type='Feature',geometry=dict(type='Point',coordinates=[30.53,50.39]),properties=dict(name='total_precipitation_or_total_water_equivalent',units='kg m-2',value=value,wigos_station_identifier='0-20000-0-33345',reportTime=fmt(end),phenomenonTime=fmt(end-hours*3600)+'/'+fmt(end)))
 def test_explicit_interval_water_equivalent_and_full_48h(self):
  meta={'33345':dict(name='Kyiv')};features=[self.feature(1,0),self.feature(24,3),self.feature(24,5,T-86400)]
  s=e.core.merge([],e.parse_ukraine_wis(features,meta,NOW),NOW)[0]
  self.assertEqual(s['amounts'],[0]);self.assertIn(dict(end=T,hours=48,value=8),s['accumulations'])
  s=e.parse_ukraine_wis([self.feature(6,12)],meta,NOW)[0];self.assertFalse(s['times']);self.assertEqual(s['periods'][0]['hours'],6)
 def test_wrong_parameter_units_missing_future_and_interval_identity_rejected(self):
  meta={'33345':dict(name='Kyiv')}
  for key,value in [('units','m'),('name','rainfall_rate'),('value',-9999),('value',None),('wigos_station_identifier','0-20000-0-99999'),('reportTime','2026-10-31T12:00:00Z')]:
   f=self.feature();f['properties'][key]=value;self.assertFalse(e.parse_ukraine_wis([f],meta,NOW))
  self.assertFalse(e.parse_ukraine_wis([self.feature(end=T+3600)],meta,NOW))
  f=self.feature();f['geometry']['coordinates']=[25,59];self.assertFalse(e.parse_ukraine_wis([f],meta,NOW))
 def test_pagination_destination_is_checked_before_download(self):
  urls=[]
  def download(url,*args):urls.append(url);return dict(type='FeatureCollection',features=[],links=[dict(rel='next',href='https://foreign.example/items')])
  with self.assertRaisesRegex(ValueError,'destination'):e.load_ukraine_wis(NOW,[],download)
  self.assertEqual(len(urls),1)
