import datetime as dt
import gzip
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import update_turkey_warnings as w
NOW=dt.datetime(2026,11,1,10,tzinfo=dt.timezone.utc)

class TurkeyWarnings(unittest.TestCase):
 def setUp(self):
  self.catalogue=json.loads(gzip.decompress(w.REGIONS.read_bytes()))
  self.payload=json.loads((Path(__file__).parent/'fixtures/turkey-official-warnings.json').read_text())
 def test_real_mgm_alerts_use_only_named_districts_and_original_colour_times(self):
  records=w.parse(self.payload,self.catalogue,NOW);self.assertEqual(len(records),38)
  for r in records:
   self.assertEqual(r['country'],'Turkey');self.assertEqual(r['timeZone'],'Europe/Istanbul');self.assertTrue(r['polygons']);self.assertFalse(r['geometryIncomplete']);self.assertIn(r['level'],['Moderate','Severe'])
   self.assertEqual(r['polygons'],self.catalogue['regions']['TR']['MGM:'+r['officialDistrictCode']]);self.assertIn('MGM',r['sourceName']);self.assertTrue(r['description']);self.assertEqual(r['language'],'tr-TR')
  r=next(r for r in records if r['officialSeverity']=='orange');self.assertEqual(r['onset'],'2026-11-01T15:00:00+00:00');self.assertIn('Muğla',r['area']);self.assertEqual(r['level'],'Severe')
 def test_expiry_and_malformed_dates_are_not_fresh_warnings(self):
  self.assertFalse(w.parse(self.payload,self.catalogue,NOW+dt.timedelta(days=4)))
  for value in ['2026-11-01T15:00:00','invalid']:
   data=json.loads(json.dumps(self.payload));data[0]['begin']=value
   with self.assertRaises(ValueError):w.parse(data,self.catalogue,NOW)
 def test_missing_boundaries_keep_named_warning_without_guessing_province(self):
  data=[json.loads(json.dumps(self.payload[0]))];data[0]['towns']['orange']=[90601]
  r=w.parse(data,self.catalogue,NOW)[0];self.assertFalse(r['polygons']);self.assertTrue(r['geometryIncomplete']);self.assertIn('Keçiören',r['area'])
  data[0]['towns']['orange']=[99999]
  with self.assertRaises(ValueError):w.parse(data,self.catalogue,NOW)
 def test_complete_empty_feed_is_success_and_both_day_lists_are_deduplicated(self):
  empty=w.load_turkey(NOW,download=lambda url:b'[]');self.assertEqual(empty['records'],[]);self.assertEqual(empty['updatedAt'],NOW.isoformat())
  result=w.load_turkey(NOW,download=lambda url:json.dumps(self.payload).encode());self.assertEqual(len(result['records']),38)
  def fail(url):
   if url.endswith('tomorrow'):raise ValueError('feed unavailable')
   return json.dumps(self.payload).encode()
  with self.assertRaises(ValueError):w.load_turkey(NOW,download=fail)
 def test_unknown_level_malformed_list_and_future_issue_are_rejected(self):
  with self.assertRaises(ValueError):w.parse({'error':'feed unavailable'},self.catalogue,NOW)
  data=json.loads(json.dumps(self.payload));data[0]['insertDate']='2026-11-04T01:00:00Z'
  with self.assertRaises(ValueError):w.parse(data,self.catalogue,NOW)
  data=json.loads(json.dumps(self.payload));data[0]['towns']['orange']=[True]
  with self.assertRaises(ValueError):w.parse(data,self.catalogue,NOW)
