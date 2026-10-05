import datetime as dt
import pathlib
import sys
import unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_official_wind as w
STAMP=1791183600
class OfficialWind(unittest.TestCase):
    def test_missing_values_are_not_calm_and_gust_only_stations_survive(self):
        for value in [None,'',False,'NaN',-1,999]:self.assertIsNone(w.number(value))
        self.assertEqual(w.number('0'),0)
        s=w.station('EE','A','Station',59,25,[(STAMP,0,'',360),(STAMP+3600,'',8,None),(STAMP+7200,'','',None)])
        self.assertEqual(s['rows'],[[STAMP,0,None,360],[STAMP+3600,None,8,None]])
    def test_estonia_keeps_feed_time_and_exact_values_without_missing_stations(self):
        raw=f'<observations timestamp="{STAMP}"><station><name>Test &amp; shore</name><wmocode>EE1</wmocode><latitude>59</latitude><longitude>25</longitude><windspeed>2.1</windspeed><windspeedmax>4.7</windspeedmax><winddirection>230</winddirection></station><station><name>No wind</name><windspeed></windspeed><windspeedmax></windspeedmax></station></observations>'
        s=w.parse_estonia(raw);self.assertEqual(len(s),1);self.assertEqual(s[0]['name'],'Test & shore');self.assertEqual(s[0]['rows'],[[STAMP,2.1,4.7,230]]);self.assertEqual(w.SOURCES['EE']['timeKind'],'feed')
    def fixture(self,values='7.2 3.4 230',positions=None):
        return f'<root xmlns:g="g" xmlns:x="x"><Point g:id="p"><pos>60 25</pos></Point><Location><identifier codeSpace="fmisid">FI1</identifier><name codeSpace="location/name">Helsinki &amp; shore</name><representativePoint x:href="#p"/></Location><MultiPointCoverage><DataRecord><field name="wg_10min"/><field name="ws_10min"/><field name="wd_10min"/></DataRecord><positions>{positions or "60 25 "+str(STAMP)}</positions><doubleOrNilReasonTupleList>{values}</doubleOrNilReasonTupleList></MultiPointCoverage></root>'
    def test_finland_resolves_real_names_and_field_order(self):
        s=w.parse_finland(self.fixture())[0];self.assertEqual(s['name'],'Helsinki & shore');self.assertEqual(s['code'],'FI1');self.assertEqual(s['rows'],[[STAMP,3.4,7.2,230]])
    def test_finland_rejects_bad_grids_and_api_errors_and_preserves_missing_gusts(self):
        with self.assertRaises(ValueError):w.parse_finland(self.fixture(values='3.4 5'))
        with self.assertRaises(ValueError):w.parse_finland('<root><ExceptionText>Down</ExceptionText></root>')
        self.assertEqual(w.parse_finland(self.fixture(values='NaN 0 NaN'))[0]['rows'],[[STAMP,0,None,None]])
    def test_retained_history_keeps_a_failed_country_and_never_invents_missing_hours(self):
        now=dt.datetime.fromtimestamp(STAMP+3600,dt.timezone.utc)
        old=[w.station('EE','EE1','EE',59,25,[(STAMP,2,4,None),(STAMP-25*3600,1,1,None)])]
        current=[w.station('FI','FI1','FI',60,25,[(STAMP+3600,3,5,None),(STAMP+7200,8,9,None)])]
        rows=w.merge(old,current,now);self.assertEqual(len(rows),2);self.assertEqual([r[0] for s in rows for r in s['rows']],[STAMP,STAMP+3600])
if __name__=='__main__':unittest.main()
