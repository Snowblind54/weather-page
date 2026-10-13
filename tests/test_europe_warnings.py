import datetime as dt
import json
import gzip
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_europe_warnings as w
NOW=dt.datetime(2026,10,13,15,tzinfo=dt.timezone.utc)
CAP='''<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>abc</identifier><sent>2026-10-13T07:00:00Z</sent><status>Actual</status><scope>Public</scope><msgType>Update</msgType><info><language>en-GB</language><severity>Severe</severity><onset>2026-10-14T09:00:00+01:00</onset><expires>2026-10-14T20:00:00+01:00</expires><event>Wind</event><headline>Official wind warning</headline><description>&lt;p&gt;Gusts 100 km/h&lt;/p&gt;</description><instruction>Take care</instruction><web>https://www.met.ie/warnings</web><area><areaDesc>Donegal</areaDesc>AREA</area></info></alert>'''
class EuropeWarnings(unittest.TestCase):
 def test_uk_polygon_and_original_details(self):
  xml=CAP.replace('AREA','<polygon>56,-7 57,-7 57,-6 56,-7</polygon>')
  r=w.parse_cap(xml,'UK','https://feeds.meteoalarm.org/cap',NOW)[0]
  self.assertEqual(r['polygons'][0][0][0],[56,-7]);self.assertEqual(r['level'],'Severe')
  self.assertEqual(r['timeZone'],'Europe/London');self.assertEqual(r['description'],'Gusts 100 km/h')
  self.assertEqual(r['onset'],'2026-10-14T09:00:00+01:00');self.assertEqual(r['instruction'],'Take care')
 def test_expired_cancel_test_and_nonpublic_excluded(self):
  for xml in [CAP.replace('Update','Cancel'),CAP.replace('Actual','Test'),CAP.replace('Public','Private')]:
   self.assertEqual(w.parse_cap(xml,'UK','url',NOW),[])
  self.assertEqual(w.parse_cap(CAP,'UK','url',NOW+dt.timedelta(days=2)),[])
 def test_irish_county_code_holes_and_no_guessed_marine_geometry(self):
  shape=[[[54,-8],[55,-8],[55,-7],[54,-8]],[[54.2,-7.8],[54.3,-7.8],[54.3,-7.7],[54.2,-7.8]]]
  counties={'geocodes':{'EI06':'Donegal'},'counties':{'Donegal':[shape]}}
  code='<geocode><valueName>FIPS</valueName><value>EI06</value></geocode>'
  r=w.parse_cap(CAP.replace('AREA',code),'IE','url',NOW,counties)[0]
  self.assertEqual(r['polygons'],[shape]);self.assertFalse(r['geometryIncomplete']);self.assertEqual(r['timeZone'],'Europe/Dublin')
  marine=w.parse_cap(CAP.replace('AREA',code.replace('EI06','EI805')),'IE','url',NOW,counties)[0]
  self.assertTrue(marine['marine']);self.assertEqual(marine['polygons'],[])
  unknown=w.parse_cap(CAP.replace('AREA',code.replace('EI06','EI061')),'IE','url',NOW,counties)[0]
  self.assertTrue(unknown['geometryIncomplete']);self.assertEqual(unknown['polygons'],[])
 def test_static_counties_complete_finite_and_holes_valid(self):
  import update_national_warnings as national
  d=json.loads(gzip.decompress(w.COUNTIES.read_bytes()));self.assertEqual(len(d['counties']),26);self.assertEqual(len(d['geocodes']),26)
  for name,shapes in d['counties'].items():
   self.assertTrue(shapes,name)
   for shape in shapes:
    for ring in shape:
     self.assertGreaterEqual(len(ring),4);self.assertEqual(ring[0],ring[-1])
 def test_feed_deduplicates_cap_links_and_applies_cancellation_references(self):
  url='https://feeds.meteoalarm.org/api/v1/warnings/feeds-united-kingdom/abc'
  cancel=url+'cancel'
  entry='<entry><link type="application/cap+xml" href="'+url+'"/></entry>'
  feed='<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:meteoalarm.org:UK</id>'+entry+entry+'<entry><link type="application/cap+xml" href="'+cancel+'"/></entry></feed>'
  cancellation=CAP.replace('<msgType>Update</msgType>','<msgType>Cancel</msgType><references>sender,abc,2026-10-13T07:00:00Z</references>')
  calls=[]
  def dl(u):
   calls.append(u)
   return feed if 'legacy-atom' in u else cancellation if u==cancel else CAP.replace('AREA','<polygon>56,-7 57,-7 57,-6 56,-7</polygon>')
  with patch.object(w,'download',side_effect=dl):result=w.load_europe('UK',NOW)
  self.assertEqual(result['records'],[]);self.assertEqual(calls.count(url),1)
