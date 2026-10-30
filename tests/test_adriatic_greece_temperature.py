import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import adriatic_greece_temperature as a
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,30,10,20,tzinfo=UTC)
META=json.loads(Path('scripts/adriatic_greece_temperature_stations.json').read_text())['stations']
RAW=b'SIAB30 ZATI 300900 RRC\nAAXX 30094\n13600 42770 82206 10160 20112 30148 40200 50008 885// 333 10000 20000=\n'
REF=dt.datetime(2026,10,30,9,43,tzinfo=UTC)

class AdriaticGreeceTemperatures(unittest.TestCase):
 def test_native_utc_tenths_and_exact_station_identity(self):
  m,t,v=a.parse_bulletin(RAW,REF,('SIAB30','ZATI'),META['AL'],NOW)[0]
  self.assertEqual(m['code'],'SYNOP-13600');self.assertEqual(t,int(dt.datetime(2026,10,30,9,tzinfo=UTC).timestamp()));self.assertEqual(v,16)
 def test_zero_negative_and_missing_temperature_not_section_three_maximum(self):
  for text,value in [(b'10000',0),(b'11025',-2.5)]:
   row=a.parse_bulletin(RAW.replace(b'10160',text),REF,('SIAB30','ZATI'),META['AL'],NOW)[0];self.assertEqual(row[2],value)
  for text in [b'1////',b'10999',b'11999',b'20160']:
   self.assertEqual(a.parse_bulletin(RAW.replace(b'10160',text),REF,('SIAB30','ZATI'),META['AL'],NOW),[])
 def test_unknown_nil_foreign_and_ambiguous_temperature_are_not_measurements(self):
  for raw in [RAW.replace(b'13600',b'99999'),RAW.replace(b'13600 42770 82206 10160',b'13600 NIL'),RAW.replace(b'10160',b'10160 10161')]:
   self.assertEqual(a.parse_bulletin(raw,REF,('SIAB30','ZATI'),META['AL'],NOW),[])
  with self.assertRaises(ValueError):a.parse_bulletin(RAW.replace(b'AAXX',b'BBXX'),REF,('SIAB30','ZATI'),META['AL'],NOW)
 def test_absolute_file_date_prevents_old_bulletin_becoming_current(self):
  for reference in [REF.replace(year=2012),REF.replace(tzinfo=None),NOW+dt.timedelta(hours=1)]:
   with self.assertRaises(ValueError):a.parse_bulletin(RAW,reference,('SIAB30','ZATI'),META['AL'],NOW)
  with self.assertRaises(ValueError):a.parse_bulletin(RAW,REF,('SIAB30','LATI'),META['AL'],NOW)
  with self.assertRaises(ValueError):a.parse_bulletin(RAW.replace(b'30094',b'30064'),REF,('SIAB30','ZATI'),META['AL'],NOW)
 def test_month_year_rollover_uses_source_file_date(self):
  ref=dt.datetime(2027,1,1,0,10,tzinfo=UTC)
  t=a.observation_time(31,18,ref);self.assertEqual(dt.datetime.fromtimestamp(t,UTC),dt.datetime(2026,12,31,18,tzinfo=UTC))
  with self.assertRaises(ValueError):a.observation_time(15,12,ref)
 def test_six_hourly_ground_freshness_is_not_applied_to_airports(self):
  ground=META['ME']['13463'];airport=META['ME']['13462'];t=int(NOW.timestamp())-6*3600
  self.assertEqual(len(a.finalize('ME',[(ground,t,0,'official'),(airport,t,1,'official')],NOW)),1)
  self.assertEqual(a.finalize('ME',[(ground,t-3601,0,'official')],NOW),[])
 def test_airport_synop_metar_merge_keeps_native_precision_and_one_station(self):
  m=META['GR']['16622'];self.assertEqual(m['code'],'AIRPORT-LGTS');self.assertEqual(m['lat'],META['GR']['LGTS']['lat'])
  t=int(NOW.timestamp())-600
  out=a.finalize('GR',[(m,t,14,'METAR'),(m,t,14.4,'SYNOP')],NOW)
  self.assertEqual(len(out),1);self.assertEqual(out[0]['rows'],[[t,14.4]])
 def test_albanian_extension_preserves_airports_and_adds_shkoder(self):
  previous=[dict(country='AL',code='AIRPORT-LATI',name='Tirana',lat=41.419,lon=19.716,rows=[[int(NOW.timestamp())-600,17]],source='Official airport')]
  import southeast_temperature
  with patch.object(southeast_temperature,'load',return_value=previous):
   out=a.load('AL',NOW,lambda u:b'[]',lambda u:(RAW,REF))
  self.assertEqual({x['code'] for x in out},{'AIRPORT-LATI','SYNOP-13600'})
 def test_catalogue_bounds_and_long_cadence_playback(self):
  for country,entries in META.items():
   south,north,west,east=a.BOUNDS[country]
   self.assertTrue(all(south<=m['lat']<=north and west<=m['lon']<=east for m in entries.values()))
  import split_official_temperature as split
  end=int(NOW.timestamp())
  with tempfile.TemporaryDirectory() as d:
   latest=Path(d)/'latest.json';history=Path(d)/'history.json'
   latest.write_text(json.dumps(dict(version=1,generatedAt=end,stations=[dict(country=c,code=c,rows=[[end-8*3600,0],[end-3600,1]]) for c in ['ME','GR','AL']])))
   with patch.object(split,'LATEST',latest),patch.object(split,'HISTORY',history):split.split()
   self.assertEqual([len(x['rows']) for x in json.loads(latest.read_text())['stations']],[2,2,1])

if __name__=='__main__':unittest.main()
