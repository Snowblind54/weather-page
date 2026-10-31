import datetime as dt
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import rainfall_balkans as b
NOW=dt.datetime(2026,10,31,15,tzinfo=dt.timezone.utc);T=int(NOW.timestamp())

class BalkanRain(unittest.TestCase):
 def test_daily_synop_section_3_is_24h_not_present_weather_or_national_group(self):
  meta={'14241':dict(name='Zagreb',lat=45.73,lon=16.06)}
  raw='SMRH21 LDZM 311200\nAAXX 31121\n14241 12682 70503 60001 71234 333 70012 555 79997=\n99999 12682 70503 60001 333 79997='
  s=b.parse_bulletin(raw,NOW,('SMRH21','LDZM'),meta,'HR',NOW,include_daily=True)[0]
  self.assertFalse(s['times']);self.assertIn(dict(end=T-10800,hours=24,value=1.2),s['periods']);self.assertEqual(len(s['periods']),2)
  s=b.parse_bulletin(raw.replace('70012','70000'),NOW,('SMRH21','LDZM'),meta,'HR',NOW,include_daily=True)[0];self.assertEqual(s['periods'][-1]['value'],0)
  for special in ['79999','79998']:
   s=b.parse_bulletin(raw.replace('70012',special),NOW,('SMRH21','LDZM'),meta,'HR',NOW,include_daily=True)[0];self.assertFalse(any(p['hours']==24 for p in s['periods']))
  s=b.parse_bulletin(raw,NOW,('SMRH21','LDZM'),meta,'HR',NOW)[0];self.assertFalse(any(p['hours']==24 for p in s['periods']))
 def test_dhmz_daily_date_join_and_omitted_wet_only_gauges_not_zero(self):
  raw='<dnevna_oborina><datumtermin><datum>31.10.2026.</datum><termin>7</termin></datumtermin><grad><ime>Dubrovnik</ime><kolicina>5.6</kolicina></grad><grad><ime>Unknown</ime><kolicina>90</kolicina></grad></dnevna_oborina>'
  stations='<Hrvatska><Grad><GradIme>Dubrovnik</GradIme><Lat>42.65</Lat><Lon>18.08</Lon></Grad><Grad><GradIme>Zadar</GradIme><Lat>44.1</Lat><Lon>15.2</Lon></Grad></Hrvatska>'
  s=b.parse_croatia_daily(raw,stations,NOW);self.assertEqual(len(s),1);self.assertEqual(s[0]['periods'],[dict(end=T-9*3600,hours=24,value=5.6)]);self.assertFalse(s[0]['times'])
  self.assertFalse(b.parse_croatia_daily(raw.replace('31.10.2026','01.11.2026'),stations,NOW))
  ambiguous=stations.replace('</Hrvatska>','<Grad><GradIme>Dubrovnik</GradIme><Lat>42.7</Lat><Lon>18.1</Lon></Grad></Hrvatska>');self.assertFalse(b.parse_croatia_daily(raw,ambiguous,NOW))
 def rs(self,value='6.4'):
  return '<h1>Main meteorological stations 31.10.2026</h1><p>Precipitation mm for 24 hour; 07:00 local time (06:00 UTC) last day</p><table><tr><td><a href="padavine_grafik.php?id=13289">Crni Vrh</a></td><td>'+value+'</td><td>Timok</td><td>Bor</td></tr></table><h1>Climatological meteorological stations</h1>'
 def test_rhmz_actual_daily_window_blank_is_not_zero_and_same_gauge_48h(self):
  meta={'13289':dict(name='Crni Vrh',lat=44.12,lon=21.95)}
  current=b.parse_serbia_daily(self.rs(),meta,NOW);self.assertEqual(current[0]['periods'][0],dict(end=T-9*3600,hours=24,value=6.4))
  self.assertFalse(b.parse_serbia_daily(self.rs(''),meta,NOW));self.assertFalse(b.parse_serbia_daily(self.rs('-999'),meta,NOW))
  previous=b.parse_serbia_daily(self.rs('2').replace('31.10.2026','30.10.2026'),meta,NOW)
  s=b.core.merge([],previous+current,NOW)[0];self.assertIn(dict(end=T-9*3600,hours=48,value=8.4),s['accumulations'])
  with self.assertRaises(ValueError):b.parse_serbia_daily(self.rs().replace('06:00 UTC','unknown'),meta,NOW)
 def test_country_coordinates_and_station_membership(self):
  data=json.loads(Path(b.__file__).with_name('balkan_rain_stations.json').read_text())
  for c in ['RS','BG','HR']:
   self.assertTrue(data['stations'][c]);self.assertTrue(all(b.location(c,m['lat'],m['lon']) for m in data['stations'][c].values()));self.assertTrue(all(k in data['stations'][c] for k in data['poi'][c]))
   self.assertFalse(b.location(c,59,25))
 def test_native_hourly_report_is_kept_but_six_hour_rain_does_not_become_hourly(self):
  for c,code,header,lat,lon in [('RS','13289',('SMYG10','LYBM'),44.12,21.95),('BG','15502',('SMBU01','LZSO'),43.98,22.85)]:
   raw=header[0]+' '+header[1]+' 311200\nAAXX 31121\n'+code+' 12682 70503 60015='
   s=b.parse_bulletin(raw,NOW,header,{code:dict(name=c,lat=lat,lon=lon)},c,NOW,include_daily=True)[0];self.assertEqual(s['amounts'],[1])
   s=b.parse_bulletin(raw.replace('60015','60011'),NOW,header,{code:dict(name=c,lat=lat,lon=lon)},c,NOW,include_daily=True)[0];self.assertFalse(s['times']);self.assertEqual(s['periods'][0]['hours'],6)

if __name__=='__main__':unittest.main()
