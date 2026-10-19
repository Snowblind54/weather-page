import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import update_central_temperature as provider


def table(header,values):return {'data':{'data':{'header':header,'values':values}}}


class CentralTemperatureTests(unittest.TestCase):
    def test_czech_metadata_uses_longitude_then_latitude_and_excludes_foreign_stations(self):
        payload=table('WSI,GH_ID,FULL_NAME,GEOGR1,GEOGR2,ELEVATION,BEGIN_DATE',[
            ['cz','L3CHEB01','Cheb',12.391389,50.068333,483,'1863-01-01'],
            ['foreign','ZIS04030','Reykjavik',-21.9,64.1,10,'2000-01-01']])
        metadata=provider.chmi_metadata(payload)
        self.assertEqual(set(metadata),{'cz'})
        self.assertEqual(metadata['cz']['lat'],50.068333)

    def test_czech_readings_preserve_zero_utc_and_only_measured_air_temperatures(self):
        payload=table('STATION,ELEMENT,DT,VAL,FLAG,QUALITY',[
            ['cz','T','2026-10-19T11:50:00Z',0,'',5],
            ['cz','T05','2026-10-19T11:50:00Z',-8,'',0],
            ['cz','TMA','2026-10-19T11:50:00Z',20,'',0],
            ['cz','T','2026-10-19T11:40:00Z',9,'',2],
            ['cz','T','2026-10-19T11:30:00Z',8,'',3],
            ['cz','T','2026-10-19T11:20:00Z',None,'',4],
            ['other','T','2026-10-19T11:50:00Z',25,'',0]])
        result=provider.chmi_station(payload,'cz',{'name':'Cheb','lat':50.068333,'lon':12.391389})
        self.assertEqual(result['rows'],[[1792410600,0]])
        self.assertEqual(result['country'],'CZ')

    def test_luxembourg_uses_2m_air_not_dewpoint_or_ground_and_observation_timestamp(self):
        observations={'timestamp':'2026-10-19T12:14:00Z','data':[{'id':'st','value':0},{'id':'stags','value':10},{'id':'std','value':-2}]}
        metadata={'data':{'id':'LUX0000001','shortName':'Luxembourg Findel Airport','location':[6.23301,49.63258]}}
        result=provider.meteolux_station(observations,metadata)
        self.assertEqual(result['rows'],[[1792412040,0]])
        self.assertEqual((result['lat'],result['lon']),(49.63258,6.23301))
        observations['data'][0]['value']=None
        with self.assertRaises(ValueError):provider.meteolux_station(observations,metadata)

    def test_old_and_future_readings_are_not_published_as_current(self):
        station={'country':'CZ','rows':[[10000,0]]}
        with self.assertRaises(ValueError):provider.recent_stations([station],now=20000)
        station={'country':'LU','rows':[[30000,0]]}
        with self.assertRaises(ValueError):provider.recent_stations([station],now=20000)

    def test_slovakia_uses_official_geometry_station_id_and_unix_observation_time(self):
        def feature(code,value,lon=17.105833,lat=48.167778):
            return {'properties':{'prop_name':'Bratislava - Koliba','prop_weather':{'station_id':code,'dt':1792411200,'ttt':value}},
                    'geometry':{'type':'Point','coordinates':[lon,lat]}}
        payload={'type':'FeatureCollection','features':[feature('11813',0),feature('missing',None),feature('foreign',5,6.23,49.63)]}
        stations=provider.shmu_stations(payload)
        self.assertEqual(len(stations),1)
        self.assertEqual(stations[0]['code'],'11813')
        self.assertEqual(stations[0]['rows'],[[1792411200,0]])
        self.assertEqual(stations[0]['country'],'SK')
        self.assertEqual(stations[0]['lat'],48.167778)
