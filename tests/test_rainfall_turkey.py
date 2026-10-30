import datetime as dt
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import rainfall_turkey as tr
import update_rainfall as core
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,15,40,tzinfo=UTC)
META=[dict(sondurumIstNo=17020,il='Bartın',enlem=41.6,boylam=32.3)]

def daily(day,value=2,code=17020,**extra):
 t=f'2026-10-{day:02}T06:00:00.000Z'
 return t,[dict(istNo=code,istAd='Bartın',enlem=41.6,boylam=32.3,il='Bartın',tarih=t,deger=value,**extra)]

def current(**extra):
 return [dict(istNo=17020,veriZamani='2026-10-30T15:34:00.000Z',yagis1Saat=0,yagis24Saat=17,yagis00Now=99,**extra)]

class TurkeyRain(unittest.TestCase):
 def test_native_minute_zero_and_consecutive_daily_totals(self):
  s=tr.parse([daily(29,3),daily(30,2)],META,current(),NOW)[0]
  self.assertEqual(s['times'],[])
  totals={(p['end'],p['hours']):p['value'] for p in s['accumulations']}
  minute=tr.stamp('2026-10-30T15:34:00.000Z');six=tr.stamp('2026-10-30T06:00:00.000Z')
  self.assertEqual(totals[minute,1],0);self.assertEqual(totals[minute,24],17)
  self.assertEqual(totals[six,24],2);self.assertEqual(totals[six,48],5)
  self.assertFalse(any(x==99 for x in totals.values()))
  merged=core.merge([], [s],NOW)[0]
  self.assertIn({'end':minute,'hours':1,'value':0},merged['accumulations'])
 def test_never_sum_overlapping_rolling_or_missing_daily_reports(self):
  for days in [[daily(30,2)],[daily(28,5),daily(30,2)],[daily(29,-9999),daily(30,2)]]:
   s=tr.parse(days,META,current(),NOW)[0]
   self.assertFalse(any(x['hours']==48 for x in s['accumulations']))
 def test_no_invented_hourly_values_or_dry_omissions(self):
  s=tr.parse([daily(30,0)],[],[],NOW)[0]
  self.assertEqual(s['times'],[]);self.assertEqual(s['accumulations'][0]['value'],0)
  self.assertFalse(any(x['hours']==1 for x in s['accumulations']))
 def test_invalid_coordinates_foreign_values_and_missing_ids(self):
  for change in [dict(enlem=59),dict(il='Suriye'),dict(deger=True),dict(deger=-9999),dict(istNo=999),dict(tarih='2026-10-29T06:00:00.000Z')]:
   t,p=daily(30);p[0].update(change)
   with self.assertRaises(ValueError):tr.parse([(t,p)],[],[],NOW)
  s=tr.parse([daily(30)],[{**META[0],'enlem':59}],current(),NOW)[0]
  self.assertFalse(any(x['hours']==1 for x in s['accumulations']))
 def test_future_stale_and_timezone_less_native_reports_excluded(self):
  for date in ['2026-10-30T16:00:00.000Z','2026-10-30T12:00:00.000Z','2026-10-30T15:34:00']:
   c=current();c[0]['veriZamani']=date
   s=tr.parse([daily(30)],META,c,NOW)[0]
   self.assertFalse(any(x['hours']==1 for x in s['accumulations']))
 def test_moving_gauges_and_conflicting_revisions_are_not_combined(self):
  a=daily(29);b=daily(30);b[1][0]['enlem']=42
  with self.assertRaises(ValueError):tr.parse([a,b],[],[],NOW)
  a=daily(30);b=daily(30,8)
  with self.assertRaises(ValueError):tr.parse([a,b],[],[],NOW)
 def test_merge_preserves_minutes_but_never_future_or_foreign_fractional_hours(self):
  s=tr.parse([],META,current(),NOW)[0];s['accumulations'].append(dict(end=int(NOW.timestamp())+120,hours=1,value=3))
  m=core.merge([], [s],NOW)[0];self.assertEqual(len(m['accumulations']),2)
  other={**s,'country':'IS','lat':64,'lon':-21,'accumulations':s['accumulations'][:1]}
  self.assertFalse(core.merge([], [other],NOW))
 def test_daily_date_catalogue_rejects_wrong_or_stale_ends(self):
  for dates in [[],['2026-10-20T06:00:00.000Z'],['2026-10-30T00:00:00.000Z']]:
   import json
   with self.assertRaises(ValueError):tr.load(NOW,[],download=lambda url:json.dumps(dates))

if __name__=='__main__':unittest.main()
