import copy
import datetime as dt
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]/'scripts'))
import official_wind_central as w

FIXTURE = json.loads(pathlib.Path(__file__).with_name('fixtures').joinpath('central-wind.json').read_text())


def table(rows):
    return {'data':{'data':{'header':'STATION,ELEMENT,DT,VAL,FLAG,QUALITY','values':rows}}}


class CentralWind(unittest.TestCase):
    def test_actual_czech_mean_uses_fprum_and_matches_gust_and_direction_at_their_time(self):
        f = FIXTURE['cz']
        s = w.chmi_wind_station(f['payload'], f['code'], f['metadata'], f['elements'])
        self.assertEqual(s['rows'][-1], [1792493400,3.2,5.1,95])
        self.assertEqual(s['name'],'Cheb')
        self.assertIn('10.15 m',s['period'])

    def test_czech_quality_flags_missing_values_and_different_times_are_preserved(self):
        f = FIXTURE['cz'];code=f['code'];stamp='2026-10-20T10:50:00Z'
        p = table([[code,'Fprum',stamp,0,'',0],[code,'Fmax',stamp,99,'',1],
                   [code,'F',stamp,88,'',0],[code,'Fmax','2026-10-20T10:40:00Z',5,'',5],
                   [code,'Fprum','2026-10-20T10:40:00Z',4,'',3],
                   ['foreign','Fmax',stamp,70,'',0],[code,'Dprum',stamp,360,'',5]])
        s=w.chmi_wind_station(p,code,f['metadata'],f['elements'])
        self.assertEqual([r[1:] for r in s['rows']],[[None,5,None],[0,None,360]])

    def test_czech_metadata_validates_units_and_ignores_other_observation_types(self):
        fields=['OBS_TYPE','WSI','EG_EL_ABBREVIATION','UN_DESCRIPTION','HEIGHT'];code=FIXTURE['cz']['code']
        p={'data':{'data':{'header':','.join(fields),'values':[['10M',code,'Fprum','m/s',10],['10M',code,'Fmax','m/s',10],['DLY',code,'F','m/s',10]]}}}
        result=w.chmi_wind_elements(p,{code:FIXTURE['cz']['metadata']})
        self.assertEqual(set(result[code]),{'Fprum','Fmax'})
        p['data']['data']['values'][1][3]='km/h'
        with self.assertRaises(ValueError):w.chmi_wind_elements(p,{code:FIXTURE['cz']['metadata']})

    def test_actual_slovak_mean_and_maximum_use_documented_fixed_cet_in_summer(self):
        f=FIXTURE['sk'];meta=w.shmu_station_metadata(f['locations'])
        s=w.shmu_minute_observations(f['payload'],meta,f['parameters'])[0]
        expected=int(dt.datetime(2026,10,20,11,25,tzinfo=dt.timezone.utc).timestamp())
        self.assertEqual(s['rows'][0],[expected,8,9.4,139.8])
        self.assertEqual(s['name'],'Holíč')
        self.assertEqual(w.shmu_observation_time('2026-01-20T12:25:00'),int(dt.datetime(2026,1,20,11,25,tzinfo=dt.timezone.utc).timestamp()))
        self.assertEqual(w.shmu_observation_time('2026-10-20T11:25:00Z'),expected)

    def test_slovak_unknown_stations_missing_maxima_and_negative_values_do_not_invent_gusts(self):
        f=copy.deepcopy(FIXTURE['sk']);meta=w.shmu_station_metadata(f['locations'])
        p=f['payload'];p['data']=p['data'][:1];p['data'][0].update(vie_pr_rych=0,vie_max_rych=None,vie_vp_rych=70)
        p['data'].append({**p['data'][0],'ind_kli':99999,'vie_max_rych':99})
        s=w.shmu_minute_observations(p,meta,f['parameters'])
        self.assertEqual(len(s),1);self.assertEqual(s[0]['rows'][0][1:],[0,None,139.8])
        p['data'][0].update(vie_pr_rych=-999,vie_max_rych=7)
        self.assertEqual(w.shmu_minute_observations(p,meta,f['parameters'])[0]['rows'][0][1:],[None,7,139.8])

    def test_slovak_units_and_foreign_coordinates_are_rejected(self):
        f=copy.deepcopy(FIXTURE['sk']);meta=w.shmu_station_metadata(f['locations'])
        for p in f['parameters']['data']:
            if p['m_column_name']=='vie_max_rych':p['unit']='knots'
        with self.assertRaises(ValueError):w.shmu_minute_observations(f['payload'],meta,f['parameters'])
        f['locations']['features'][0]['geometry']['coordinates']=[12,50]
        with self.assertRaises(ValueError):w.shmu_station_metadata(f['locations'])

    def test_archive_selection_uses_modification_order_across_autumn_clock_repeat(self):
        def row(clock,modified):return '<tr><td><a href="aws1min%20-%202026-10-25%20'+clock+'-00.json">file</a></td><td>'+modified+'</td></tr>'
        listing=row('02-55','2026-10-25 00:54')+row('02-05','2026-10-25 01:04')
        self.assertIn('02-05',w.shmu_archive_files(listing)[-1])



if __name__=='__main__':unittest.main()
