import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import update_snow_depth as snow
from snow_depth_expansion import SnowDepthExpansion
from snow_depth_eastern import EasternSnowDepth, BOUNDS
NOW=dt.datetime(2026,11,1,12,tzinfo=dt.timezone.utc)

class EasternSnowTests(unittest.TestCase):
 def setUp(self):
  self.base=SnowDepthExpansion(None,snow.record,snow.latest,snow.NoRecentSnowData)
  self.adapter=EasternSnowDepth(self.base)
  self.meta={'26850':dict(name='Minsk',lat=53.9,lon=27.56)}
 def raw(self,group='40215',extra=''):
  return 'SMBY01 UMMN 010600\nAAXX 01061\n26850 32580 80101 40287 333 '+group+' '+extra+' 555 49995=\n99999 32580 80101 333 40299='
 def parse(self,raw=None,**kw):
  return self.adapter.parse(raw or self.raw(),kw.get('reference',NOW),kw.get('expected',('SMBY01','UMMN')),kw.get('metadata',self.meta),kw.get('country','BY'),kw.get('now',NOW))
 def test_only_section_three_total_depth_and_original_time(self):
  rows=self.parse();self.assertEqual(len(rows),1);r=rows[0]
  self.assertEqual(r['depthCm'],215);self.assertEqual(r['time'],snow.timestamp('2026-11-01T06:00:00Z'));self.assertEqual(r['timePrecision'],'instant')
  self.assertEqual(r['country'],'BY');self.assertEqual(r['quality'],'provisional')
  self.assertFalse(self.parse(self.raw('4////')));self.assertFalse(self.parse(self.raw('40215 40220')))
  # Gust reports do not change the snow observation time.
  self.assertEqual(self.parse(self.raw(extra='91012'))[0]['depthCm'],215)
  self.assertFalse(self.parse(self.raw().replace('333 40215','22200 40215')))
 def test_wmo_trace_patchy_unused_and_unmeasurable_codes(self):
  for group,state in [('40997','trace'),('40998','patchy')]:
   r=self.parse(self.raw(group))[0];self.assertEqual(r['state'],state);self.assertIsNone(r['depthCm'])
  for group in ['40999','40000','4////','']:
   self.assertFalse(self.parse(self.raw(group)))
 def test_station_country_bounds_and_relocated_report_are_rejected(self):
  for lat,lon in [(49,27),(54,40)]:self.assertFalse(self.parse(metadata={'26850':dict(name='Foreign',lat=lat,lon=lon)}))
  self.assertFalse(self.parse(self.raw().replace('40287 333','40287 90630 333')))
  self.assertFalse(self.parse(metadata={}))
 def test_dates_future_month_rollover_and_stale_headers(self):
  with self.assertRaises(ValueError):self.parse(reference=NOW-dt.timedelta(days=8))
  with self.assertRaises(ValueError):self.parse(expected=('SMUR10','UKMS'))
  with self.assertRaises(ValueError):self.parse(reference=NOW.replace(tzinfo=None))
  self.assertFalse(self.parse(now=NOW.replace(hour=5),reference=NOW.replace(hour=5)))
  raw=self.raw().replace('010600','311800').replace('01061','31181')
  r=self.parse(raw,reference=NOW.replace(hour=0))[0];self.assertEqual(r['time'],snow.timestamp('2026-10-31T18:00:00Z'))
 def test_catalogues_and_ukrainian_depth(self):
  for country,file in [('BY','belarus_snow_stations.json'),('UA','ukraine_temperature_stations.json')]:
   m=json.loads(Path(snow.__file__).with_name(file).read_text())['stations'];s,n,w,e=BOUNDS[country]
   self.assertGreater(len(m),20);self.assertTrue(all(s<=x['lat']<=n and w<=x['lon']<=e for x in m.values()))
   self.assertIsNone(snow.record(country,'foreign','Foreign',60,10,NOW.isoformat(),1))
  raw='SMUR10 UKMS 010600\nAAXX 01061\n33345 32580 80101 333 40123='
  r=self.parse(raw,expected=('SMUR10','UKMS'),metadata={'33345':dict(name='Kyiv',lat=50.4,lon=30.5)},country='UA')[0]
  self.assertEqual(r['depthCm'],123);self.assertEqual(r['country'],'UA')
 def test_explicit_dwd_zero_not_new_snow_and_missing_not_zero(self):
  raw=b'field;time;depth_of_new_snow;total_snow_depth\n26850;unit;cm;cm\nDate;UTC;new;total\n01.11.26;06:00;50;0\n01.11.26;09:00;50;---\n'
  r=self.base.parse_dwd(raw,'26850',dict(country='BY',**self.meta['26850']))[0]
  self.assertEqual(r['depthCm'],0);self.assertEqual(r['state'],'bare');self.assertEqual(r['time'],snow.timestamp('2026-11-01T06:00:00Z'))
 def test_clean_empty_reports_have_no_data_status_and_outages_remain_distinct(self):
  self.base.load_dwd=lambda country,now:[]
  def empty(url):
   a,b=url.split('/')[-1].split('.')[:2]
   return (a.upper()+' '+b.upper()+' 010600\nAAXX 01061\n26850 32580 80101 333 20059=').encode(),NOW
  adapter=EasternSnowDepth(self.base,empty)
  with self.assertRaises(snow.NoRecentSnowData):adapter.load_belarus(NOW)
  def outage(url):raise ValueError('feed outage')
  with self.assertRaises(ValueError) as caught:EasternSnowDepth(self.base,outage).load_belarus(NOW)
  self.assertNotIsInstance(caught.exception,snow.NoRecentSnowData)
