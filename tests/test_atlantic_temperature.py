import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import update_atlantic_temperature as a


class AtlanticTemperatures(unittest.TestCase):
    def test_uk_uses_recent_measured_temperatures_and_official_metadata(self):
        now = 1791878400
        time = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()
        raw = ('generation notes\nraw_text,station_id,observation_time,temp_c,metar_type\n'
               f'test,EGLL,{time},0,METAR\n'
               f'test,EGLL,{time},,SPECI\n'
               f'test,EGCC,{time},-99,METAR\n'
               f'test,EIDW,{time},12,METAR\n'
               'test,EGCC,2020-01-01T00:00:00Z,13,METAR\n')
        metadata = {'EGLL':{'country':'GB','site':'Heathrow','lat':51.48,'lon':-.45},
                    'EGCC':{'country':'GB','site':'Manchester','lat':53.35,'lon':-2.27},
                    'EIDW':{'country':'IE','lat':53.42,'lon':-6.27}}
        rows = a.parse_british_metars(raw, metadata, now)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['rows'], [[now, 0]])
        self.assertEqual(rows[0]['name'], 'Heathrow')

    def test_ireland_uses_air_temperature_without_missing_sentinel(self):
        metadata = {'1':{'geometry':{'coordinates':[-7.36,53.54]},'properties':{'station_name':'Mullingar'}}}
        features = [{'properties':{'station_id':1,'parameter_name':parameter,'observed_at':time,'value_num':value}}
                    for parameter,time,value in [('air_temperature','2026-10-13T06:00:00Z',0),
                        ('air_temperature','2026-10-13T07:00:00Z',-99),
                        ('grass_temperature','2026-10-13T08:00:00Z',4)]]
        rows = a.parse_irish_features(features, metadata)
        self.assertEqual(rows[0]['country'], 'IE')
        self.assertEqual(len(rows[0]['rows']), 1)
        self.assertEqual(rows[0]['rows'][0][1], 0)

    def test_faroes_reject_expired_metadata_and_other_parameters(self):
        def feature(code, **properties):
            return {'properties':{'stationId':code, **properties}, 'geometry':{'coordinates':[-6.8,62]}}
        metadata = [feature('06011', country='FRO',status='Active',name='Tórshavn'),
                    feature('06012', country='FRO',status='Active',validTo='2020-01-01T00:00:00Z')]
        observations = [feature(code, parameterId=parameter,observed='2026-10-13T08:00:00Z',value=9)
                        for code,parameter in [('06011','temp_dry'),('06012','temp_dry'),('06011','temp_dew')]]
        with patch.object(a, 'features', side_effect=[metadata, observations]):
            rows = a.parse_faroes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['country'], 'FO')
        self.assertEqual(rows[0]['code'], '06011')


if __name__ == '__main__':
    unittest.main()
