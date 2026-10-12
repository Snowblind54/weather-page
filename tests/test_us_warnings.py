import datetime as dt,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_us_warnings as us

NOW=dt.datetime(2026,10,12,17,tzinfo=dt.timezone.utc)
ZONE=us.API+'zones/forecast/ORZ104'
SHAPE={'type':'MultiPolygon','coordinates':[[[[-124,45],[-123,45],[-123,46],[-124,45]],[[-123.8,45.2],[-123.7,45.2],[-123.7,45.3],[-123.8,45.2]]],[[[-123,44],[-122.9,44],[-122.9,44.1],[-123,44]]]]}
def alert(identifier='new',**changes):
 p={'id':identifier,'status':'Actual','messageType':'Alert','category':'Met','event':'Winter Storm Watch','severity':'Severe','effective':'2026-10-12T10:00:00-07:00','onset':'2026-10-13T00:00:00-07:00','expires':'2026-10-13T08:00:00-07:00','ends':'2026-10-13T18:00:00-07:00','areaDesc':'Official forecast area','affectedZones':[ZONE],'headline':'Official watch','description':'<p>Snow expected</p>','instruction':'Prepare','references':[]};p.update(changes)
 return {'type':'Feature','geometry':None,'properties':p}

class USWarnings(unittest.TestCase):
 def zones(self):return {ZONE:{'polygons':us.core.polygons(SHAPE),'timeZones':['America/Los_Angeles']}}
 def test_zone_boundaries_holes_local_time_and_official_alert_type(self):
  r=us.parse_alerts([alert()],self.zones(),NOW)[0]
  self.assertEqual(r['country'],'USA');self.assertEqual(r['alertType'],'Watch');self.assertEqual(r['level'],'Severe');self.assertEqual(r['timeZone'],'America/Los_Angeles');self.assertFalse(r['marine']);self.assertEqual(len(r['polygons']),2);self.assertEqual(len(r['polygons'][0]),2);self.assertEqual(r['polygons'][0][0][0],[45,-124]);self.assertEqual(r['description'],'Snow expected')
 def test_native_warning_polygon_takes_priority_over_broader_forecast_zone(self):
  f=alert(event='Tornado Warning',severity='Extreme');f['geometry']={'type':'Polygon','coordinates':[[[-100,40],[-99,40],[-99,41],[-100,40]]]}
  r=us.parse_alerts([f],self.zones(),NOW)[0];self.assertEqual(r['level'],'Extreme');self.assertEqual(r['polygons'][0][0][0],[40,-100]);self.assertEqual(len(r['polygons']),1)
 def test_minor_unknown_and_marine_alerts_preserve_official_severity(self):
  marine=us.API+'zones/forecast/AMZ250'
  r=us.parse_alerts([alert(event='Small Craft Advisory',severity='Minor',affectedZones=[marine])],{},NOW)[0]
  self.assertEqual(r['level'],'Information');self.assertEqual(r['officialSeverity'],'Minor');self.assertEqual(r['alertType'],'Advisory');self.assertTrue(r['marine']);self.assertEqual(r['polygons'],[])
  r=us.parse_alerts([alert(severity='Unknown')],self.zones(),NOW)[0];self.assertEqual(r['officialSeverity'],'Unknown')
 def test_canceled_replaced_expired_test_and_non_weather_alerts_are_excluded(self):
  canceled=alert('cancel',messageType='Cancel',references=[{'identifier':'old'}]);updated=alert('update',messageType='Update',references=[{'identifier':'older'}])
  rows=us.parse_alerts([alert('old'),alert('older'),canceled,updated,alert('expired',expires='2026-10-12T16:00:00Z'),alert('test',status='Test'),alert('civil',category='Safety')],self.zones(),NOW)
  self.assertEqual([r['identifier'] for r in rows],['update'])
 def test_partial_geometry_is_explicit_without_dropping_the_alert(self):
  missing=us.API+'zones/forecast/ORZ107'
  r=us.parse_alerts([alert(affectedZones=[ZONE,missing])],self.zones(),NOW)[0]
  self.assertTrue(r['geometryIncomplete']);self.assertTrue(r['polygons'])
  self.assertFalse(us.parse_alerts([alert()],self.zones(),NOW)[0]['geometryIncomplete'])
 def test_valid_message_expiry_is_separate_from_event_end(self):
  row=us.parse_alerts([alert()],self.zones(),NOW)[0];self.assertEqual(row['messageExpires'],'2026-10-13T08:00:00-07:00');self.assertEqual(row['expires'],'2026-10-13T18:00:00-07:00')
  self.assertEqual(us.parse_alerts([alert()],self.zones(),dt.datetime(2026,10,13,16,tzinfo=dt.timezone.utc)),[])
 def test_alert_pagination_does_not_drop_later_pages_or_follow_foreign_hosts(self):
  first={'type':'FeatureCollection','features':[alert('one')],'pagination':{'next':us.API+'alerts?cursor=next'}};last={'type':'FeatureCollection','features':[alert('two')]}
  with patch.object(us,'download_json',side_effect=[first,last]) as download:self.assertEqual(len(us.active_alerts()),2);self.assertEqual(download.call_count,2)
  first['pagination']['next']='https://example.com/alerts'
  with patch.object(us,'download_json',return_value=first):
   with self.assertRaisesRegex(ValueError,'pagination'):us.active_alerts()
 def test_zone_cache_bulk_mapping_and_reuse_avoid_per_visitor_requests(self):
  metadata={'type':'FeatureCollection','features':[{'properties':{'id':'ORZ104','type':'public','timeZone':['America/Los_Angeles']},'geometry':None}]}
  geometry={'type':'FeatureCollection','features':[{'properties':{'state_zone':'OR104'},'geometry':SHAPE}]}
  with tempfile.TemporaryDirectory() as tmp,patch.object(us,'CACHE',pathlib.Path(tmp)/'zones.json'),patch.object(us,'download_json',side_effect=[metadata,geometry]) as download:
   zones=us.resolve_zones([ZONE],NOW);self.assertEqual(len(zones[ZONE]['polygons']),2);self.assertEqual(download.call_count,2);self.assertIn('OR104',download.call_args.args[0]);us.resolve_zones([ZONE],NOW);self.assertEqual(download.call_count,2)
  with self.assertRaisesRegex(ValueError,'affected-zone'):us.zone_parts('https://example.com/zones/forecast/ORZ104')

if __name__=='__main__':unittest.main()
