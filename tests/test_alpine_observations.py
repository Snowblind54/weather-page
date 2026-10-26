import copy
import datetime as dt
import json
import pathlib
import sys
import unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import alpine_observations as p
import update_official_temperature_all as temperature
import update_official_wind as wind

NOW=dt.datetime(2026,10,26,14,40,tzinfo=dt.timezone.utc)
STAMP=int(dt.datetime(2026,10,26,14,30,tzinfo=dt.timezone.utc).timestamp())

class AlpineTests(unittest.TestCase):
    def setUp(self):
        self.metadata={'stations':[{'id':'11035','name':'Wien','lat':48.25,'lon':16.35,'is_active':True}]}
        self.payload={'timestamps':['2026-10-26T14:30+00:00'],'features':[{'properties':{'station':'11035','parameters':{k:{'unit':u,'data':[v]} for k,u,v in [('TL','°C',0),('FF','m/s',0),('FFX','m/s',6.8),('DD','°',360)]}}}]}
        self.swissmeta='station_abbr;station_name;station_canton;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon\nBER;Bern;BE;46.99;7.46\nVAD;Vaduz;FL;47.13;9.52\n'
        self.swiss='Station/Location;Date;tre200s0;fu3010z0;fu3010z1;dkl010z0\nBER;202610261430;0;36;72;360\nVAD;202610261430;10;36;72;90\n'
    def test_austria_native_utc_units_and_zero(self):
        s=p.parse_austria(self.payload,self.metadata,NOW)[0]
        self.assertEqual(s['rows'],[[STAMP,0,0,6.8,0]])
    def test_austria_missing_gust_does_not_become_zero(self):
        self.payload['features'][0]['properties']['parameters']['FFX']['data']=[None]
        self.assertIsNone(p.parse_austria(self.payload,self.metadata,NOW)[0]['rows'][0][3])
    def test_reject_changed_units_or_axis(self):
        self.payload['features'][0]['properties']['parameters']['FF']['unit']='km/h'
        with self.assertRaises(ValueError):p.parse_austria(self.payload,self.metadata,NOW)
    def test_filter_unknown_inactive_outside_stale_future(self):
        for stamp in ['2026-10-26T11:00+00:00','2026-10-26T15:00+00:00','2026-10-26T14:30']:
            self.payload['timestamps']=[stamp]
            self.assertEqual(p.parse_austria(self.payload,self.metadata,NOW),[])
        self.payload['timestamps']=['2026-10-26T14:30+00:00']
        self.metadata['stations'][0]['is_active']=False
        self.assertEqual(p.parse_austria(self.payload,self.metadata,NOW),[])
    def test_swiss_kmh_conversion_and_exclude_liechtenstein(self):
        s=p.parse_switzerland(self.swiss,self.swissmeta,NOW)
        self.assertEqual(len(s),1)
        self.assertEqual(s[0]['rows'],[[STAMP,0,10,20,0]])
    def test_swiss_missing_invalid_and_stale(self):
        data=self.swiss.replace(';36;72;360',';-;-;-').replace(';0;',';-;')
        self.assertEqual(p.parse_switzerland(data,self.swissmeta,NOW),[])
        self.assertEqual(p.parse_switzerland(self.swiss.replace('202610261430','202610261000'),self.swissmeta,NOW),[])
    def test_swiss_does_not_use_tower_wind(self):
        data='Station/Location;Date;tre200s0;fu3010z0;fu3010z1;dkl010z0;fu3towz0\nBER;202610261430;4;-;-;-;100\n'
        self.assertEqual(p.parse_switzerland(data,self.swissmeta,NOW)[0]['rows'][0],[STAMP,4,None,None,None])
    def test_projections_keep_channels_times_and_country_bounds(self):
        def download(url):return self.swissmeta.encode() if url==p.SWISS_META else self.swiss.encode()
        t=p.load_temperature('CH',NOW,download)[0]
        w=p.load_wind('CH',NOW,download)[0]
        self.assertEqual(t['rows'],[[STAMP,0]])
        self.assertEqual(w['rows'],[[STAMP,10,20,0]])
        self.assertIn('MeteoSwiss',t['source'])
        self.assertIn('AT',temperature.core.LOADERS)
        self.assertIn('CH',temperature.core.LOADERS)

if __name__=='__main__':unittest.main()
