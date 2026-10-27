import copy
import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import rainfall_alpine as a
import update_rainfall as core
import rainfall_europe as europe
UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,27,10,tzinfo=UTC)
END=int(NOW.timestamp())
META={'stations':[{'id':'11035','name':'Wien','lat':48.25,'lon':16.35,'is_active':True}]}

def austrian(values):
    return {'timestamps':[dt.datetime.fromtimestamp(END-(5-i)*600,UTC).isoformat() for i in range(6)],'features':[{'properties':{'station':'11035','parameters':{'RR':{'unit':'mm','data':values}}}}]}

class AlpineRainfallTests(unittest.TestCase):
    def test_austria_requires_all_six_intervals_and_preserves_zero(self):
        s=a.parse_austria(austrian([0,.1,.2,0,.3,.4]),META,NOW)[0]
        self.assertEqual(s['times'],[END]);self.assertEqual(s['amounts'],[1])
        for missing in (None,-999,True,''):
            self.assertEqual(a.parse_austria(austrian([0,0,missing,0,0,0]),META,NOW),[])
        self.assertEqual(a.parse_austria(austrian([0]*6),META,NOW)[0]['amounts'],[0])
    def test_austria_rejects_units_timezone_and_axis_change(self):
        p=austrian([0]*6);p['features'][0]['properties']['parameters']['RR']['unit']='cm'
        with self.assertRaises(ValueError):a.parse_austria(p,META,NOW)
        p=austrian([0]*6);p['timestamps'][0]=p['timestamps'][0].replace('+00:00','')
        with self.assertRaises(ValueError):a.parse_austria(p,META,NOW)
        p=austrian([0]*6);p['timestamps'].pop()
        with self.assertRaises(ValueError):a.parse_austria(p,META,NOW)
    def test_austria_unknown_inactive_and_future_do_not_form_hour(self):
        meta=copy.deepcopy(META);meta['stations'][0]['is_active']=False
        self.assertEqual(a.parse_austria(austrian([0]*6),meta,NOW),[])
        p=austrian([0]*6);p['timestamps'][-1]=(NOW+dt.timedelta(hours=1)).isoformat()
        self.assertEqual(a.parse_austria(p,META,NOW),[])
    def test_swiss_native_hourly_values_no_conversion_future_or_missing_fill(self):
        data='station_abbr;reference_timestamp;rre150h0\nBER;27.10.2026 08:00;0\nBER;27.10.2026 09:00;\nBER;27.10.2026 10:00;2.5\nBER;27.10.2026 11:00;100\n'
        s=a.parse_switzerland(data,'BER',{'name':'Bern','lat':46.99,'lon':7.46},NOW)
        self.assertEqual(s['times'],[END-7200,END]);self.assertEqual(s['amounts'],[0,2.5])
        self.assertIsNone(europe.complete_total(dict(zip(s['times'],s['amounts'])),[],END,24))
        with self.assertRaises(ValueError):a.parse_switzerland(data,'GEN',{'name':'Geneva','lat':46.2,'lon':6.1},NOW)
    def test_swiss_metadata_excludes_liechtenstein_and_foreign_coordinates(self):
        raw='station_abbr;station_name;station_canton;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon\nBER;Bern;BE;46.99;7.46\nVAD;Vaduz;FL;47.13;9.52\nBAD;Foreign;BE;59;24\n'
        self.assertEqual(set(a.swiss_metadata(raw,a.CH_DATASETS[0])),{'BER'})
    def test_long_windows_need_complete_hours_and_refresh_replaces_values(self):
        rows=[(END-i*3600,1,False) for i in range(49)]
        s=core.station('AT','11035','Wien',48.25,16.35,rows)
        self.assertEqual(europe.complete_total(dict(zip(s['times'],s['amounts'])),[],END,48),48)
        revised=core.station('AT','11035','Wien',48.25,16.35,[(END,3,False)])
        merged=core.merge([s],[revised],NOW)[0]
        self.assertEqual(europe.complete_total(dict(zip(merged['times'],merged['amounts'])),[],END,48),50)
        with self.assertRaises(ValueError):core.station('CH','X','Foreign',59,24,[])
    def test_registers_both_official_networks(self):
        class Target:SOURCES={};LOADERS={}
        a.install(Target)
        self.assertEqual(set(Target.LOADERS),{'AT','CH'})
        self.assertIn('MeteoSwiss',Target.SOURCES['CH'][0])

if __name__=='__main__':unittest.main()
