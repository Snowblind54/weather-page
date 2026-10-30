import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import official_wind_eastern as e
import update_official_wind as core

UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,14,tzinfo=UTC)
META={'33345':{'name':'Kyiv','lat':50.4,'lon':30.5}}

class EasternWind(unittest.TestCase):
 def test_ukraine_measured_zero_direction_and_local_clock(self):
  rows=e.ukraine({'33345':{'CD':'2026-10-30','CT':14,'C_W':4,'C_D':31,'C_I':19,'gust':99}},META)
  self.assertEqual(rows,[('33345',[int(NOW.timestamp())-7200,4,None,310])])
  row=e.ukraine({'33345':{'CD':'2026-10-30','CT':14,'C_W':0,'C_D':0}},META)[0][1]
  self.assertEqual(row[1:],[0,None,None])
  self.assertFalse(e.ukraine({'unknown':{'C_W':4},'33345':{'CD':'2026-10-30','CT':14,'C_W':True}},META))
 def test_ukraine_summer_dst_and_repeated_autumn_hour(self):
  rows=e.ukraine({'33345':{'CD':'2026-07-30','CT':14,'C_W':2,'C_D':99}},META)
  self.assertEqual(rows[0][1][0],int(dt.datetime(2026,7,30,11,tzinfo=UTC).timestamp()))
  self.assertIsNone(rows[0][1][3])
  self.assertFalse(e.ukraine({'33345':{'CD':'2026-10-25','CT':3,'C_W':2}},META))
 def test_belarus_native_utc_and_calm_missing(self):
  base=dict(country='BY',number=26850,name='Minsk',LATITUDE=53.9,LONGITUDE=27.6,date='2026-10-30T00:00:00.000Z',HH=12,Speed=3,Dir='С-З',windGust=99)
  m,r=e.belarus([base]);self.assertEqual(r[0][1],[int(NOW.timestamp())-7200,3,None,315])
  self.assertEqual(e.belarus([{**base,'Speed':0}])[1][0][1][1:],[0,None,None])
  for v in [None,True,-999,101,'']:
   self.assertFalse(e.belarus([{**base,'Speed':v}])[1])
  for change in [{'country':'UA'},{'HH':True},{'LONGITUDE':45},{'date':'2026-10-30T12:00:00Z'}]:
   self.assertFalse(e.belarus([{**base,**change}])[1])
 def bulletin(self,wind='83104',tail='333 91012 91118 555 91099',iw='1'):
  return f'SMUR10 UKMS 301200\nAAXX 3012{iw}\n33345 /1598 {wind} 10108 {tail}='
 def test_synop_gust_period_and_estimated_winds(self):
  parse=lambda raw:e.synop(raw,NOW,('SMUR10','UKMS'),META,NOW)
  self.assertEqual(parse(self.bulletin())[0][1][1:],[4,12,310])
  self.assertEqual(parse(self.bulletin(tail='333 91118'))[0][1][2],18)
  self.assertIsNone(parse(self.bulletin(tail='333 91230 555 91099'))[0][1][2])
  for tail in ['333 90710 91118','333 90430 91118']:
   self.assertIsNone(parse(self.bulletin(tail=tail))[0][1][2])
  self.assertFalse(parse(self.bulletin(iw='0')))
  self.assertFalse(parse(self.bulletin(iw='3')))
 def test_synop_knots_extended_missing_and_modified_observation_time(self):
  p=lambda raw:e.synop(raw,NOW,('SMUR10','UKMS'),META,NOW)
  r=p(self.bulletin(iw='4'))[0][1];self.assertAlmostEqual(r[1],4*1852/3600);self.assertAlmostEqual(r[2],12*1852/3600)
  self.assertAlmostEqual(p(self.bulletin(wind='83199',tail='00102 333 91099 00120',iw='4'))[0][1][2],120*1852/3600)
  self.assertFalse(p(self.bulletin(wind='8////',tail='333 911//')))
  self.assertFalse(p(self.bulletin(tail='91230 333 91012')))
  self.assertFalse(p(self.bulletin().replace('33345','99999')))
 def test_synop_absolute_file_date_and_identity(self):
  with self.assertRaises(ValueError):e.synop(self.bulletin(),NOW-dt.timedelta(days=31),('SMUR10','UKMS'),META,NOW)
  with self.assertRaises(ValueError):e.synop(self.bulletin(),NOW,('SMBY01','UMMN'),META,NOW)
  ref=dt.datetime(2026,11,1,0,5,tzinfo=UTC)
  raw=self.bulletin().replace('301200','312100').replace('30121','31211')
  self.assertEqual(e.synop(raw,ref,('SMUR10','UKMS'),META,ref)[0][1][0],int(dt.datetime(2026,10,31,21,tzinfo=UTC).timestamp()))
 def test_merge_only_same_station_time_and_keep_real_gaps(self):
  t=int(NOW.timestamp());obs=[('33345',[t-7200,2,12,30]),('33345',[t,0,None,None])]
  s=e.finalize('UA',META,obs,NOW)[0]
  self.assertEqual(s['rows'][-1],[t,0,None,None]);self.assertEqual(s['rows'][0][2],12)
  with self.assertRaises(ValueError):e.finalize('UA',META,[('33345',[t+120,1,3,0])],NOW)
  with self.assertRaises(ValueError):e.finalize('UA',META,[('33345',[t-14401,1,3,0])],NOW)
  with self.assertRaises(ValueError):core.station('UA','x','x',59,25,obs[0][1:])
 def test_bounded_load_uses_national_feed_if_bulletins_fail(self):
  calls=[]
  def bulletin(url):calls.append(url);raise ValueError('unavailable')
  s=e.load('UA',NOW,bulletin_download=bulletin,ua_download=lambda:{'33345':{'CD':'2026-10-30','CT':14,'C_W':4,'C_D':31}})
  self.assertEqual(len(calls),4);self.assertEqual(len(s),1);self.assertIsNone(s[0]['rows'][0][2])
  with self.assertRaises(ValueError):e.load('NO',NOW)

if __name__=='__main__':unittest.main()
