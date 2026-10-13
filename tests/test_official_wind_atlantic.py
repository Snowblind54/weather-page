import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import official_wind_atlantic as a

NOW = dt.datetime(2026,10,13,9,tzinfo=dt.timezone.utc)


class AtlanticWind(unittest.TestCase):
    def test_uk_knots_calm_and_unreported_gusts(self):
        raw = ('raw_text,station_id,observation_time,wind_speed_kt,wind_gust_kt,wind_dir_degrees,metar_type\n'
               'test,EGLL,2026-10-13T09:00:00Z,10,30,270,METAR\n'
               'test,EGCC,2026-10-13T09:00:00Z,0,,VRB,METAR\n'
               'test,EIDW,2026-10-13T09:00:00Z,20,40,240,METAR\n')
        metadata = {code:{'country':country,'site':code,'lat':lat,'lon':lon}
                    for code,country,lat,lon in [('EGLL','GB',51.48,-.45),('EGCC','GB',53.35,-2.27),('EIDW','IE',53.42,-6.27)]}
        rows = a.parse_us_metars(raw, metadata, NOW, country='GB')
        self.assertEqual(len(rows),2)
        self.assertAlmostEqual(rows[0]['rows'][0][1],10*1852/3600, places=2)
        self.assertAlmostEqual(rows[0]['rows'][0][2],30*1852/3600, places=2)
        self.assertEqual(rows[1]['rows'][0][1:], [0,None,None])

    def test_irish_hourly_mean_converts_knots_and_never_pairs_different_times(self):
        metadata = {'1':{'properties':{'station_name':'Mullingar'},'geometry':{'coordinates':[-7.36,53.54]}}}
        features = [{'properties':{'station_id':1,'parameter_name':p,'observed_at':t,'value_num':v}}
                    for p,t,v in [('wind_speed_mean','2026-10-13T08:00:00Z',10),
                        ('wind_gust','2026-10-13T08:00:00Z',20),('wind_direction','2026-10-13T08:00:00Z',240),
                        ('wind_speed_mean','2026-10-13T09:00:00Z',0),('wind_gust','2026-10-13T09:00:00Z',-99),
                        ('wind_speed','2026-10-13T09:00:00Z',90)]]
        rows=a.parse_ireland(features,metadata)[0]['rows']
        self.assertAlmostEqual(rows[0][1],10*1852/3600, places=2)
        self.assertAlmostEqual(rows[0][2],20*1852/3600, places=2)
        self.assertEqual(rows[1][1:], [0,None,None])

    def test_faroes_include_official_municipal_stations_and_exclude_expired_or_private(self):
        def f(code, **p):
            return {'properties':{'stationId':code, **p},'geometry':{'coordinates':[-6.8,62]}}
        meta=[f('06011',name='Torshavn',owner='Havne Kommuner mv',country='FRO',status='Active'),
              f('06012',owner='Havne Kommuner mv',country='FRO',status='Active',validTo='2020-01-01T00:00:00Z'),
              f('private',owner='Private',country='FRO',status='Active')]
        payloads=[[f(code,parameterId=p,observed='2026-10-13T08:00:00Z',value=v)
                   for code in ('06011','06012','private')] for p,v in [('wind_speed',5),('wind_gust_always_past1h',12),('wind_dir',180)]]
        with patch.object(a,'features',side_effect=[meta,*payloads]):
            rows=a.load_faroes(NOW)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['country'],'FO')
        self.assertEqual(rows[0]['rows'][0][1:],[5,12,180])


if __name__=='__main__':
    unittest.main()
