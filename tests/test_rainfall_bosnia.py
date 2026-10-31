import datetime as dt
from pathlib import Path
import sys
import unittest
from zoneinfo import ZoneInfo
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import rainfall_bosnia as b
NOW=dt.datetime(2026,10,31,16,tzinfo=dt.timezone.utc);T=int(NOW.timestamp())

class BosniaRain(unittest.TestCase):
 def page(self,hour='1',daily='24',date='31.10.2026',clock='17',history=True):
  hours=[];dates=[]
  for i in range(24):
   t=dt.datetime.fromtimestamp(T-(23-i)*3600,dt.timezone.utc).astimezone(ZoneInfo('Europe/Sarajevo'));hours.append("'"+t.strftime('%H')+"'");dates.append("'"+(t.strftime('%d.%m.%Y.') if i%4==3 else '')+"'")
  values=','.join(['1']*24) if history else ','.join(['null']*24)
  return '''satne padavine (mm) S padavina 24sata
const amsGK = L.marker([44.797846,16.542816],{icon:pIcon}).bindPopup('automatska padavinska<br>stanica Gornji Kamengrad');
<table><tr><td>'''+date+'''</td><td>'''+clock+'''</td><td><a href="javascript:padavinske('stanice11')">G.Kamengrad</a></td><td>99</td><td>'''+hour+'''</td><td>'''+daily+'''</td></tr></table>
<div class="stanice" id="stanice11"><script>
var graf11={data:{datasets:[{type:'bar',label:'padavine',data:['''+values+''']}]},options:{title:{text:'automatska stanica Gornji Kamengrad '},scales:{xAxes:[{id:'xAxis1',labels:['''+','.join(hours)+''']},{id:'xAxis2',labels:['''+','.join(dates)+''']}]}}};
</script></div>'''
 def test_hourly_chart_native_units_coordinates_time_and_24h_total(self):
  s=b.parse(self.page(),NOW)[0];self.assertEqual(s['country'],'BA');self.assertEqual(s['name'],'Gornji Kamengrad');self.assertEqual(len(s['times']),24);self.assertEqual(s['times'][-1],T);self.assertEqual(s['amounts'],[1]*24);self.assertAlmostEqual(s['lat'],44.797846)
  self.assertEqual(s['periods'],[dict(end=T,hours=24,value=24)])
  merged=b.core.merge([],[s],NOW)[0];self.assertFalse(any(p['hours']==48 for p in merged['accumulations']))
 def test_explicit_zero_missing_blank_and_future_are_distinct(self):
  s=b.parse(self.page(hour='0',daily='0'),NOW)[0];self.assertEqual(s['amounts'],[0]);self.assertEqual(s['periods'][0]['value'],0)
  s=b.parse(self.page(hour='',daily='2'),NOW)[0];self.assertFalse(s['times']);self.assertEqual(s['periods'][0]['value'],2)
  for raw in [self.page(hour='',daily=''),self.page(hour='-999',daily=''),self.page(date='01.11.2026'),self.page(date='25.10.2026',clock='02')]:
   with self.assertRaises(ValueError):b.parse(raw,NOW)
 def test_wrong_chart_anchor_does_not_publish_guessed_history(self):
  raw=self.page().replace("'30.10.2026.'","'29.10.2026.'")
  s=b.parse(raw,NOW)[0];self.assertEqual(s['times'],[T]);self.assertEqual(s['amounts'],[1])
  raw=self.page(history=False);s=b.parse(raw,NOW)[0];self.assertEqual(s['times'],[T])
 def test_unknown_or_conflicting_station_coordinates_units_and_injected_array_rejected(self):
  for raw in [self.page().replace('44.797846,16.542816','59,25'),self.page().replace('satne padavine (mm)','satne padavine (m)'),self.page()+"const amsOther = L.marker([44.8,16.55],{icon:pIcon}).bindPopup('Gornji Kamengrad');"]:
   with self.assertRaises(ValueError):b.parse(raw,NOW)
  with self.assertRaises(ValueError):b.decode_array('1,doSomething(),2')
 def test_48h_requires_two_adjacent_totals_from_the_same_gauge(self):
  s=b.parse(self.page(),NOW)[0];prior={**s,'times':[],'amounts':[],'periods':[dict(end=T-86400,hours=24,value=3)]}
  merged=b.core.merge([],[prior,s],NOW)[0];self.assertIn(dict(end=T,hours=48,value=27),merged['accumulations'])

if __name__=='__main__':unittest.main()
