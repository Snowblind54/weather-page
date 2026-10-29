import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import rainfall_adriatic as a
import rainfall_europe as europe
import update_rainfall as core

UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,29,14,tzinfo=UTC)
END=int(NOW.timestamp())
META={'name':'Ljubljana','lat':46.06,'lon':14.51}
CODE='LJUBL-ANA_BEZIGRAD_'
def xml(rows):return '<data id="MeteoSI_WebMet_observationAms_xml">'+''.join(rows)+'</data>'
def row(t=END,rain='1',hour=None,day=None,state='0',unit='mm',code=CODE,seconds=600):
 stamp=lambda t:dt.datetime.fromtimestamp(t,UTC).strftime('%d.%m.%Y %H:%M UTC')
 return f'''<metData><domain_meteosiId>{code}</domain_meteosiId><domain_meteosiType>SI_RNSTATION_B</domain_meteosiType><domain_longTitle>Ljubljana</domain_longTitle><domain_lat>46.06</domain_lat><domain_lon>14.51</domain_lon><valid_UTC>{stamp(t)}</valid_UTC><validStart>{stamp(t-seconds)}</validStart><validEnd>{stamp(t)}</validEnd><rr_var_unit>{unit}</rr_var_unit><rr_val>{rain}</rr_val><rr_state>{state}</rr_state><tp_1h_acc_var_unit>{unit}</tp_1h_acc_var_unit><tp_1h_acc>{'' if hour is None else hour}</tp_1h_acc><tp_1h_acc_state>0</tp_1h_acc_state><tp_24h_acc_var_unit>{unit}</tp_24h_acc_var_unit><tp_24h_acc>{'' if day is None else day}</tp_24h_acc><tp_24h_acc_state>0</tp_24h_acc_state></metData>'''

class AdriaticRainfall(unittest.TestCase):
 def test_six_ten_minute_intervals_form_one_hour_not_rolling_duplicates(self):
  raw=xml([row(END-i*600,rain='0.5') for i in range(6)])
  s=a.parse_slovenia(raw,CODE,META,NOW)
  self.assertEqual(s['times'],[END]);self.assertEqual(s['amounts'],[3])
  s=a.parse_slovenia(xml([row(END-i*600,rain='0') for i in range(6)]),CODE,META,NOW)
  self.assertEqual(s['amounts'],[0])
 def test_missing_suspect_and_future_tips_never_fill_a_clock_hour(self):
  for middle in [row(END-1200,rain=''),row(END-1200,rain='-999'),row(END-1200,state='2'),row(END+600)]:
   raw=xml([row(END-i*600) if i!=2 else middle for i in range(6)])
   self.assertEqual(a.parse_slovenia(raw,CODE,META,NOW)['times'],[])
 def test_native_hour_is_not_added_to_its_component_tips(self):
  raw=xml([row(END,hour='2.5')]+[row(END-i*600) for i in range(1,6)])
  s=a.parse_slovenia(raw,CODE,META,NOW)
  self.assertEqual(s['amounts'],[2.5])
 def test_rolling_hour_at_non_clock_time_is_not_relabelled(self):
  s=a.parse_slovenia(xml([row(END-600,hour='9')]),CODE,META,NOW)
  self.assertEqual(s['times'],[])
 def test_two_native_days_make_48_hours_without_inventing_hourly_rain(self):
  s=a.parse_slovenia(xml([row(END,rain='',day='2'),row(END-86400,rain='',day='3')]),CODE,META,NOW)
  s=core.merge([],[s],NOW)[0]
  self.assertEqual(s['times'],[])
  self.assertIn({'end':END,'hours':48,'value':5},s['accumulations'])
  s=a.parse_slovenia(xml([row(END,rain='',day='2')]),CODE,META,NOW)
  self.assertIsNone(europe.complete_total({},s['periods'],END,48))
 def test_station_identity_units_location_and_product_are_checked(self):
  for raw in [xml([row(code='FOREIGN')]),xml([row(unit='inch')]),xml([row()]).replace('observationAms_xml','forecast_xml'),xml([row()]).replace('46.06','46.5')]:
   with self.assertRaises(ValueError):a.parse_slovenia(raw,CODE,META,NOW)
 def test_catalogues_exclude_neighbours_and_cover_southern_italy(self):
  self.assertGreater(len(a.metadata('IT')),20);self.assertEqual(len(a.metadata('HR')),10)
  self.assertTrue(all(a.location(c,m['lat'],m['lon']) for c in ('IT','HR') for m in a.metadata(c).values()))
  s=core.station('IT','16420','Palermo',38.1,13.3,[(END,0,False)])
  self.assertEqual(s['amounts'],[0])
  for c in ('IT','HR','SI'):
   with self.assertRaises(ValueError):core.station(c,'X','Foreign',59,24,[])
 def test_bootstrap_fetches_history_even_if_current_hour_is_available(self):
  current=xml([row(hour='1')]);history=xml([row(hour='1',day='3'),row(END-86400,rain='',day='2')]);calls=[]
  def get(url,json_data=False):calls.append(url);return history if '/recent/' in url else current
  with patch.object(core,'download',side_effect=get):s=a.load_slovenia(NOW,[])
  self.assertTrue(any('/recent/' in u for u in calls));self.assertTrue(any(x['periods'] for x in s))
  prior=core.merge([],s,NOW);calls.clear()
  with patch.object(core,'download',side_effect=get):a.load_slovenia(NOW,prior)
  self.assertEqual(len(calls),1,'same completed hour reuses the shared history')
 def test_sources_are_registered(self):
  class Target:SOURCES={};LOADERS={}
  a.install(Target);self.assertEqual(set(Target.LOADERS),{'IT','HR','SI'})

if __name__=='__main__':unittest.main()
