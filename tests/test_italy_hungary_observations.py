import datetime as dt
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
import italy_hungary_observations as s
import update_official_wind as wind

NOW=dt.datetime(2026,10,27,15,tzinfo=dt.timezone.utc)
END=int(NOW.timestamp())

def archive(rows,header='Time;StationNumber;StationName;Latitude;Longitude;t;fs;fx;fsd;ta;fxd'):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w') as z:z.writestr('HABP_10M_SYNOP_20261027150804.csv',header+'\n'+'\n'.join(rows))
    return b.getvalue()

class ItalyHungaryTests(unittest.TestCase):
    def test_hungarian_native_units_utc_and_correct_measurements(self):
        r=s.parse_hungary(archive(['202610271450;44527;Budapest;47.43;19.18;13.8;1.7;3.4;351;14.9;17']),NOW)[0]
        self.assertEqual(r['rows'],[[END-600,13.8,1.7,3.4,351]])
        self.assertIn('2-sec',r['gustLabel']);self.assertEqual(r['name'],'Budapest')

    def test_missing_zero_future_and_foreign_stations(self):
        rows=['202610271450;44527;Budapest;47.43;19.18;0;0;-999;-999;20;0',
              '202610271450;44528;Not Hungary;59;24;20;3;5;90;20;90',
              '202610281450;44529;Future;47;19;10;3;5;90;20;90',
              '202510271450;44530;Old;47;19;10;3;5;90;20;90']
        r=s.parse_hungary(archive(rows),NOW)
        self.assertEqual(len(r),1);self.assertEqual(r[0]['rows'][0][1:],[0,0,None,None])
        with self.assertRaises(ValueError):s.parse_hungary(archive(['202610270100;44527;Budapest;47.43;19.18;1;2;3;0;4;5']),NOW)
        with self.assertRaises(ValueError):s.parse_hungary(archive([],header='bad;columns'),NOW)

    def test_italian_metar_knots_missing_gusts_and_country_identity(self):
        metadata={'LIRF':dict(country='IT',name='Roma Fiumicino',lat=41.8,lon=12.2),'LMML':dict(country='MT',name='Malta',lat=35.8,lon=14.3)}
        reports=[dict(icaoId='LIRF',metarType='METAR',obsTime=END-600,temp=18,wspd=10,wgst=20,wdir=270),
                 dict(icaoId='LIRF',metarType='SPECI',obsTime=END,temp=0,wspd=0,wdir='VRB'),
                 dict(icaoId='LMML',metarType='METAR',obsTime=END,temp=20,wspd=5,wgst=10)]
        r=s.parse_italian_metars(reports,metadata,NOW)
        self.assertEqual(len(r),1);self.assertAlmostEqual(r[0]['rows'][0][2],10*1852/3600)
        self.assertAlmostEqual(r[0]['rows'][0][3],20*1852/3600)
        self.assertEqual(r[0]['rows'][1][1:],[0,0,None,None]);self.assertIn('METAR',r[0]['gustLabel'])
        with self.assertRaises(ValueError):s.parse_italian_metars([reports[0]]*400,metadata,NOW)

    def test_sicily_sardinia_and_hungarian_country_bounds(self):
        for country,lat,lon in [('IT',35.5,12.6),('IT',39,8.5),('IT',46.7,12),('HU',48.5,21.5)]:
            self.assertTrue(s.location(country,lat,lon))
            self.assertTrue(wind.station(country,'test','station',lat,lon,[(END,0,12,360)])['rows'])
        self.assertFalse(s.location('HU',41,12));self.assertFalse(s.location('IT',48,19))

    def test_same_airport_deduplicated_without_mixing_gust_definitions(self):
        def row(code,gust):return dict(code=code,identity='LIRF',name='Roma',lat=41.8,lon=12.2,rows=[[END,0,1,gust,180]],sourceName=code,gustLabel=code,period=code)
        with patch.object(s,'load',return_value=[row('SYNOP-16242',12),row('METAR-LIRF',None)]):
            t=s.load_temperature('IT',NOW,None);w=s.load_wind('IT',NOW,None)
        self.assertEqual(len(t),1);self.assertEqual(len(w),1);self.assertEqual(w[0]['rows'][0][2],12)
        self.assertEqual(w[0]['gustLabel'],'SYNOP-16242')

    def test_italian_metadata_does_not_include_malta_and_uses_decimal_coordinates(self):
        m=json.loads((Path(s.__file__).with_name('europe_synop_stations.json')).read_text())['stations']
        self.assertEqual(m['16080']['country'],'IT');self.assertAlmostEqual(m['16080']['lat'],45+26/60,5)
        self.assertNotIn('16597',m)
        a=json.loads((Path(s.__file__).with_name('italy_airport_stations.json')).read_text())['stations']
        self.assertIn('LIRF',a);self.assertTrue(all(v['country']=='IT' and s.location('IT',v['lat'],v['lon']) for v in a.values()))

if __name__=='__main__':unittest.main()
