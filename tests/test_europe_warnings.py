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

class WesternWarnings(unittest.TestCase):
 def setUp(self):
  self.regions=json.loads(gzip.decompress(w.REGIONS.read_bytes()))['regions']
 def cap(self,area,severity='Moderate',awareness='2'):
  return CAP.replace('AREA',area).replace('<severity>Severe</severity>',f'<severity>{severity}</severity><parameter><valueName>awareness_level</valueName><value>{awareness}; official level</value></parameter>')
 def test_german_yellow_minor_uses_exact_dwd_region(self):
  area='<geocode><valueName>WARNCELLID</valueName><value>903457002</value></geocode>'
  r=w.parse_cap(self.cap(area,'Minor'),'DE','url',NOW,regions=self.regions)[0]
  self.assertEqual(r['level'],'Moderate');self.assertEqual(r['officialSeverity'],'Minor')
  self.assertEqual(r['polygons'],self.regions['DE']['WARNCELLID:903457002'])
  self.assertFalse(r['geometryIncomplete']);self.assertFalse(r['marine']);self.assertEqual(r['timeZone'],'Europe/Berlin')
 def test_green_excluded_and_orange_red_preserved(self):
  for awareness,expected in [('1',None),('2','Moderate'),('3','Severe'),('4','Extreme')]:
   rows=w.parse_cap(self.cap('<polygon>50,6 51,6 51,7 50,6</polygon>','Minor',awareness),'DE','url',NOW)
   self.assertEqual(rows[0]['level'] if rows else None,expected)
 def test_belgian_province_and_coast_exact_codes(self):
  for kind,value in [('NUTS2','BE25'),('EMMA_ID','BE801')]:
   area=f'<geocode><valueName>{kind}</valueName><value>{value}</value></geocode>'
   r=w.parse_cap(self.cap(area),'BE','url',NOW,regions=self.regions)[0]
   self.assertEqual(r['polygons'],self.regions['BE'][kind+':'+value]);self.assertFalse(r['geometryIncomplete'])
 def test_supplied_polygon_takes_priority_and_unknown_areas_never_guessed(self):
  area='<geocode><valueName>NUTS2</valueName><value>BE25</value></geocode><polygon>50,6 51,6 51,7 50,6</polygon>'
  r=w.parse_cap(self.cap(area),'BE','url',NOW,regions=self.regions)[0]
  self.assertEqual(r['polygons'],[[[[50,6],[51,6],[51,7],[50,6]]]])
  r=w.parse_cap(self.cap(area.replace('BE25','BE999').split('<polygon>')[0]),'BE','url',NOW,regions=self.regions)[0]
  self.assertTrue(r['geometryIncomplete']);self.assertEqual(r['polygons'],[])
 def test_dutch_marine_and_luxembourg_supplied_polygons(self):
  area='<geocode><valueName>EMMA_ID</valueName><value>NL811</value></geocode><polygon>52,5 53,5 53,6 52,5</polygon>'
  r=w.parse_cap(self.cap(area),'NL','url',NOW)[0]
  self.assertTrue(r['marine']);self.assertTrue(r['polygons'])
  r=w.parse_cap(self.cap(area.replace('NL811','LU001')),'LU','url',NOW)[0]
  self.assertFalse(r['marine']);self.assertTrue(r['polygons']);self.assertEqual(r['timeZone'],'Europe/Luxembourg')
 def test_local_language_fallback_and_no_translated_duplicates(self):
  xml=self.cap('<polygon>50,6 51,6 51,7 50,6</polygon>')
  french=xml.replace('en-GB','fr-BE')
  self.assertEqual(w.parse_cap(french,'BE','url',NOW)[0]['language'],'fr-BE')
  combined=xml.replace('</alert>',french.split('<info>')[1].replace('</alert>','').join(['<info>','</alert>']))
  self.assertEqual(len(w.parse_cap(combined,'BE','url',NOW)),1)
 def test_empty_country_feed_is_a_successful_zero(self):
  feed='<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:meteoalarm.org:LU</id></feed>'
  with patch.object(w,'download',return_value=feed):r=w.load_europe('LU',NOW)
  self.assertEqual(r['records'],[]);self.assertEqual(r['country'],'Luxembourg');self.assertEqual(r['updatedAt'],NOW.isoformat())
 def test_boundary_catalogue_is_finite_closed_and_preserves_holes(self):
  import math
  self.assertEqual(len(self.regions['DE']),402);self.assertEqual(len(self.regions['BE']),12)
  holes=0
  for country in self.regions.values():
   for shapes in country.values():
    self.assertTrue(shapes)
    for shape in shapes:
     holes+=len(shape)-1
     for ring in shape:
      self.assertGreaterEqual(len(ring),4);self.assertEqual(ring[0],ring[-1])
      for lat,lon in ring:self.assertTrue(math.isfinite(lat) and math.isfinite(lon) and 47<lat<56 and 2<lon<16)
  self.assertGreater(holes,0)
 def test_transient_cap_failure_retried_but_permanent_errors_preserved(self):
  import urllib.error
  with patch.object(w,'download',side_effect=[urllib.error.HTTPError('url',503,'unavailable',{},None),b'ok']) as dl,patch.object(w.time,'sleep'):
   self.assertEqual(w.fetch_warning('url'),b'ok');self.assertEqual(dl.call_count,2)
  with patch.object(w,'download',side_effect=urllib.error.HTTPError('url',404,'not found',{},None)) as dl,patch.object(w.time,'sleep'):
   with self.assertRaises(urllib.error.HTTPError):w.fetch_warning('url')
   self.assertEqual(dl.call_count,1)
