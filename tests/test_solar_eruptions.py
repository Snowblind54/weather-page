import datetime as dt,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import solar_eruptions as s
import update_space_weather as u
NOW=dt.datetime(2026,10,13,16,tzinfo=dt.timezone.utc).timestamp()
M={'modelCompletionTime':'2026-10-13T10:00Z','estimatedShockArrivalTime':'2026-10-15T12:00Z','cmeIDs':['a','b']}
E={'activityID':'a','startTime':'2026-10-12T12:00Z','submissionTime':'2026-10-12T13:00Z','cmeAnalyses':[{'isMostAccurate':True,'submissionTime':'2026-10-13T10:00Z','speed':1200,'enlilList':[M]}]}
class SolarEruptions(unittest.TestCase):
 def test_speed_arrival_and_no_invented_error_bar(self):
  r=s.compact_cmes([E],NOW)['entries'][0];self.assertEqual(r['speed'],1200);self.assertEqual(r['earthImpact'],'expected');self.assertEqual(r['estimatedArrival'],M['estimatedShockArrivalTime']);self.assertIsNone(r['arrivalUncertaintyHours']);self.assertTrue(r['combinedForecast'])
 def test_latest_miss_replaces_previous_hit(self):
  newer={**M,'modelCompletionTime':'2026-10-13T11:00Z','estimatedShockArrivalTime':None}
  r=s.compact_cmes([{**E,'cmeAnalyses':[{**E['cmeAnalyses'][0],'enlilList':[M,newer]}]}],NOW)['entries'][0]
  self.assertEqual(r['earthImpact'],'not-predicted');self.assertIsNone(r['estimatedArrival'])
 def test_primary_measurement_glancing_unassessed(self):
  a={'speed':2500,'submissionTime':'2026-10-13T15:00Z','enlilList':[{**M,'isEarthGB':True}]}
  r=s.compact_cmes([{**E,'cmeAnalyses':E['cmeAnalyses']+[a]}],NOW)['entries'][0];self.assertEqual(r['speed'],1200)
  r=s.compact_cmes([{**E,'cmeAnalyses':[{**a,'isMostAccurate':True}]}],NOW)['entries'][0];self.assertEqual(r['earthImpact'],'glancing')
  r=s.compact_cmes([{**E,'cmeAnalyses':None}],NOW)['entries'][0];self.assertEqual(r['earthImpact'],'unassessed');self.assertIsNone(r['speed'])
 def test_rolling_window_sort_dedup_and_safe_link(self):
  rows=s.compact_cmes([E,{**E,'activityID':'b','startTime':'2026-10-13T12:00Z','link':'javascript:alert(1)'},{**E,'activityID':'old','startTime':'2026-10-06T15:00Z'},E],NOW)['entries']
  self.assertEqual([r['id'] for r in rows],['b','a']);self.assertIsNone(rows[0]['sourceUrl'])
  with self.assertRaises(ValueError):s.compact_cmes({},NOW)
 def test_current_g_never_uses_forecast_and_preserves_zero(self):
  c={'DateStamp':'2026-10-13','TimeStamp':'15:59:00','G':{'Scale':'0'}}
  self.assertEqual(s.current_g_scale({'0':c,'1':{**c,'G':{'Scale':'5'}}},NOW)['scale'],0)
  with self.assertRaises(ValueError):s.current_g_scale({'1':c},NOW)
  with self.assertRaises(ValueError):s.current_g_scale({'0':{**c,'G':{'Scale':None}}},NOW)
 def test_optional_failure_preserves_freshness_and_core_layers(self):
  old={'solarEruptions':{'fetchedAt':123,'entries':[]},'geomagneticStorm':{'scale':2,'time':'2026-10-12T10:00:00Z'},'solarArrivalReports':{'fetchedAt':123,'entries':[]}}
  def fetch(url,**kwargs):
   if 'ccmc' in url or 'noaa-scales' in url or 'alerts.json' in url:raise RuntimeError('unavailable')
   return {'coordinates':[]} if 'ovation' in url else []
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'space-weather.json';p.write_text(json.dumps(old))
   with patch.object(u,'OUTPUT',p),patch.object(u,'fetch_json',side_effect=fetch),patch.object(u,'fetch_text',side_effect=RuntimeError('unavailable')):u.main()
   r=json.loads(p.read_text());self.assertEqual(r['solarEruptions'],old['solarEruptions']);self.assertEqual(r['geomagneticStorm'],old['geomagneticStorm']);self.assertEqual(r['solarArrivalReports'],old['solarArrivalReports']);self.assertIn('aurora',r);self.assertEqual(r['version'],1)

class ArrivalReports(unittest.TestCase):
 def bulletin(self,code,body,issued='2026 Oct 13 1510 UTC',serial='1'):
  return {'issue_datetime':'2026-10-13 15:10:00.123','message':f'Space Weather Message Code: {code}\r\nSerial Number: {serial}\r\nIssue Time: {issued}\r\n\r\n{body}'}
 def warning(self):
  return self.bulletin('WARSUD','WARNING: Geomagnetic Sudden Impulse expected\nValid From: 2026 Oct 13 1515 UTC\nValid To: 2026 Oct 13 1550 UTC\nIp Shock: 2026-10-13 15:05')
 def test_upstream_is_observed_shock_with_forecast_window(self):
  row=s.compact_arrival_reports([self.warning()],NOW)['entries'][0]
  self.assertEqual(row['kind'],'upstream');self.assertEqual(row['shockAt'],'2026-10-13T15:05:00Z')
  self.assertEqual(row['validTo'],'2026-10-13T15:50:00Z');self.assertNotIn('observedAt',row)
 def test_ground_summary_preserves_actual_time_station_and_nt(self):
  report=self.bulletin('SUMSUD','SUMMARY: Geomagnetic Sudden Impulse\nObserved: 2026 Oct 13 1530 UTC\nDeviation: 56 nT\nStation: NGK',issued='2026 Oct 13 1540 UTC')
  row=s.compact_arrival_reports([report],NOW)['entries'][0]
  self.assertEqual(row['kind'],'observed');self.assertEqual(row['observedAt'],'2026-10-13T15:30:00Z');self.assertEqual(row['station'],'NGK');self.assertEqual(row['deviationNt'],56)
  self.assertNotIn('cmeId',row)
 def test_storm_alerts_are_not_arrival_confirmation_and_empty_is_valid(self):
  self.assertEqual(s.compact_arrival_reports([self.bulletin('ALTK05','ALERT: G1')],NOW)['entries'],[])
  self.assertEqual(s.compact_arrival_reports([],NOW)['entries'],[])
  with self.assertRaises(ValueError):s.compact_arrival_reports({},NOW)
 def test_cancellation_revision_replaces_warning(self):
  cancelled=self.bulletin('WARSUD','CANCEL WARNING: Geomagnetic Sudden Impulse expected',issued='2026 Oct 13 1520 UTC')
  rows=s.compact_arrival_reports([self.warning(),cancelled],NOW)['entries'];self.assertEqual(len(rows),1);self.assertEqual(rows[0]['kind'],'cancelled')
 def test_bad_known_bulletin_preserves_feed_via_error_and_utc_rollover(self):
  with self.assertRaises(ValueError):s.compact_arrival_reports([self.bulletin('SUMSUD','SUMMARY: Geomagnetic Sudden Impulse\nObserved: unknown')],NOW)
  self.assertEqual(s.bulletin_time('2026 Dec 31 2359 UTC'),'2026-12-31T23:59:00Z')
  self.assertEqual(s.bulletin_time('2027-01-01 00:10'),'2027-01-01T00:10:00Z')
  self.assertIsNone(s.bulletin_time('2026 Feb 31 1200 UTC'))
