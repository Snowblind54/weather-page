import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import adriatic_observations as a

NOW=dt.datetime(2026,10,29,14,10,tzinfo=dt.timezone.utc)
ARSO='''<data id="MeteoSI_WebMet_observationAms_xml"><metData>
<domain_meteosiId>LJUBLJANA</domain_meteosiId><domain_longTitle>Ljubljana</domain_longTitle><domain_meteosiType>SI_RNSTATION_B</domain_meteosiType><domain_lat>46.06</domain_lat><domain_lon>14.51</domain_lon>
<valid_UTC>29.10.2026 14:00 UTC</valid_UTC><validStart>29.10.2026 13:50 UTC</validStart><validEnd>29.10.2026 14:00 UTC</validEnd>
<t_var_unit>°C</t_var_unit><t>0</t><t_state>0</t_state><ffavg_var_unit>m/s</ffavg_var_unit><ffavg_val>2</ffavg_val><ffavg_state>0</ffavg_state><ffmax_var_unit>m/s</ffmax_var_unit><ffmax_val>5.5</ffmax_val><ffmax_state>0</ffmax_state><ddavg_var_unit>°</ddavg_var_unit><ddavg_val>0</ddavg_val><ddavg_state>0</ddavg_state></metData></data>'''
DHMZ='''<Hrvatska><DatumTermin><Datum>29.10.2026</Datum><Termin>15</Termin></DatumTermin><Grad><GradIme>Zagreb-Maksimir</GradIme><Lat>45.822</Lat><Lon>16.034</Lon><Podatci><Temp>0</Temp><VjetarBrzina>0</VjetarBrzina><VjetarSmjer>C</VjetarSmjer></Podatci></Grad></Hrvatska>'''

class Adriatic(unittest.TestCase):
 def test_arso_native_interval_units_and_zero(self):
  s=a.parse_slovenia(ARSO,NOW)[0]
  self.assertEqual(s['rows'][0],[int(NOW.timestamp())-600,0,2,5.5,0])
  self.assertEqual(s['gustLabel'],'Gust max · 10 min')
 def test_arso_missing_suspect_not_zero_and_no_instantaneous_substitute(self):
  raw=ARSO.replace('<ffmax_state>0','<ffmax_state>2').replace('<ffavg_val>2</ffavg_val>','<ffavg_val/><ff_val>9</ff_val>')
  row=a.parse_slovenia(raw,NOW)[0]['rows'][0]
  self.assertEqual(row[1],0);self.assertIsNone(row[2]);self.assertIsNone(row[3])
 def test_arso_rejects_wrong_units_and_non_observations(self):
  for raw in [ARSO.replace('>m/s<','>km/h<'),ARSO.replace('MeteoSI_WebMet_observationAms_xml','forecast'),ARSO.replace('13:50 UTC','13:00 UTC'),ARSO.replace('<domain_lat>46.06','<domain_lat>59.06')]:
   with self.assertRaises(ValueError):a.parse_slovenia(raw,NOW)
 def test_rejects_stale_future_and_no_numeric_measurements(self):
  for now in [NOW+dt.timedelta(hours=4),NOW-dt.timedelta(hours=1)]:
   with self.assertRaises(ValueError):a.parse_slovenia(ARSO,now)
  with self.assertRaises(ValueError):a.parse_croatia(DHMZ.replace('<Temp>0','<Temp>-').replace('<VjetarBrzina>0','<VjetarBrzina>-'),NOW)
 def test_croatia_local_time_and_no_fabricated_gust(self):
  row=a.parse_croatia(DHMZ,NOW)[0]['rows'][0]
  self.assertEqual(row,[int(NOW.timestamp())-600,0,0,None,None])
  summer=DHMZ.replace('29.10.2026','29.07.2026')
  n=dt.datetime(2026,7,29,13,10,tzinfo=dt.timezone.utc)
  self.assertEqual(a.parse_croatia(summer,n)[0]['rows'][0][0],int(n.timestamp())-600)
  with self.assertRaises(ValueError):a.parse_croatia(DHMZ.replace('29.10.2026','25.10.2026').replace('<Termin>15','<Termin>02'),NOW)
 def test_metar_only_reported_gust_and_known_croatian_airports(self):
  m={'14241':{'icao':'LDZA','lat':45.73,'lon':16.06,'name':'Zagreb'}}
  reports=[dict(icaoId='LDZA',metarType='METAR',obsTime=int(NOW.timestamp())-300,temp=0,wspd=10,wgst=20,wdir='VRB'),dict(icaoId='OTHER',metarType='METAR',obsTime=int(NOW.timestamp()),temp=30,wspd=80)]
  row=a.croatian_metars(reports,m,NOW)[0]['rows'][0]
  self.assertAlmostEqual(row[2],5.1444444);self.assertAlmostEqual(row[3],10.2888889);self.assertIsNone(row[4])
  reports[0]['wgst']=None;self.assertIsNone(a.croatian_metars(reports,m,NOW)[0]['rows'][0][3])
 def test_shared_temperature_and_wind_schemas(self):
  t=a.load_temperature('SI',NOW,lambda u:ARSO)[0];w=a.load_wind('SI',NOW,lambda u:ARSO)[0]
  self.assertEqual(t['country'],'SI');self.assertEqual(t['rows'][0][1],0)
  self.assertEqual(w['rows'][0][1:],[2,5.5,0]);self.assertIn('ARSO',w['sourceName'])
 def test_croatian_catalogue_stays_in_country(self):
  stations=json.loads(Path('scripts/croatia_synop_stations.json').read_text())['stations']
  self.assertGreaterEqual(len(stations),10)
  self.assertTrue(all(14200<=int(code)<=14499 and a.within('HR',s['lat'],s['lon']) for code,s in stations.items()))

if __name__=='__main__':unittest.main()
