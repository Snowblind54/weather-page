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
  old={'solarEruptions':{'fetchedAt':123,'entries':[]},'geomagneticStorm':{'scale':2,'time':'2026-10-12T10:00:00Z'}}
  def fetch(url,**kwargs):
   if 'ccmc' in url or 'noaa-scales' in url:raise RuntimeError('unavailable')
   return {'coordinates':[]} if 'ovation' in url else []
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'space-weather.json';p.write_text(json.dumps(old))
   with patch.object(u,'OUTPUT',p),patch.object(u,'fetch_json',side_effect=fetch),patch.object(u,'fetch_text',side_effect=RuntimeError('unavailable')):u.main()
   r=json.loads(p.read_text());self.assertEqual(r['solarEruptions'],old['solarEruptions']);self.assertEqual(r['geomagneticStorm'],old['geomagneticStorm']);self.assertIn('aurora',r);self.assertEqual(r['version'],1)
