import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import europe_synop as s
import latvia_observations as lv
import update_official_wind as wind

NOW=dt.datetime(2026,10,22,7,tzinfo=dt.timezone.utc)
FIXTURES=Path(__file__).with_name('fixtures')

class EuropeanOfficialObservations(unittest.TestCase):
    def test_french_and_southern_uk_native_hourly_gusts_and_utc_times(self):
        for fixture,code,speed,gust in [('france-synop.csv','07149',19,31),('southern-uk-synop.csv','03827',22,39)]:
            rows=s.parse((FIXTURES/fixture).read_bytes(),code,(s.SPEED,s.GUST,s.DIRECTION))
            t,v=rows[0];self.assertEqual(t,int(NOW.timestamp())-3600)
            self.assertEqual((v[s.SPEED],v[s.GUST]),(speed,gust))
        self.assertEqual(wind.station('FR','test','Corsica',41.92,8.8,[(NOW.timestamp(),0,0,0)])['rows'][0][1:],[0,0,0])

    def test_missing_gust_does_not_use_longer_period_or_maximum_mean(self):
        raw=(FIXTURES/'southern-uk-synop.csv').read_text(encoding='latin1');lines=raw.splitlines();header=lines[0].split(';');row=lines[3].split(';')
        row[header.index(s.GUST)]='---'
        row[header.index('maximum_wind_speed_during_last_6_hours')]='180'
        rows=s.parse('\n'.join(lines[:3]+[';'.join(row)]),'03827',(s.SPEED,s.GUST,s.DIRECTION))
        self.assertIsNone(rows[0][1][s.GUST])
        with self.assertRaises(ValueError):s.parse(raw,'07149',(s.SPEED,s.GUST,s.DIRECTION))
        with self.assertRaises(ValueError):s.parse(raw.replace('km/h','m/s'),'03827',(s.SPEED,s.GUST,s.DIRECTION))

    def test_verified_station_metadata_covers_southern_uk_and_all_france(self):
        meta=json.loads((Path(s.__file__).with_name('europe_synop_stations.json')).read_text())['stations']
        self.assertGreaterEqual(sum(x['country']=='FR' for x in meta.values()),30)
        for code in ['03808','03827','03781','03797','07761','07790']:
            self.assertIn(code,meta)
        self.assertAlmostEqual(meta['03827']['lat'],50.35,places=5)
        self.assertAlmostEqual(meta['07149']['lon'],2.4)
        self.assertNotIn('03953',meta) # Irish station, not UK.

    def test_latvian_current_feed_preserves_zero_missing_values_and_utc(self):
        metadata=[{'kods':'RIGA','nosaukums':'Rīga','lat':'56.95','lon':'24.1'}]
        obs=[{'station_code':'RIGA','time':'2026.10.22 07:00:00','air_temperature_actual':'0','wind_speed_actual':'0','wind_speed_maximum':'8.2','wind_speed_gust':'2.1','wind_direction_actual':'0'}]
        row=lv.parse(obs,metadata,NOW)[0]['rows'][0]
        self.assertEqual(row,[int(NOW.timestamp()),0,0,8.2,0])
        obs[0]['wind_speed_maximum']='---';self.assertIsNone(lv.parse(obs,metadata,NOW)[0]['rows'][0][3])
        obs[0]['time']='2024.12.14 14:00:00'
        with self.assertRaises(ValueError):lv.parse(obs,metadata,NOW)

    def test_latvian_wind_uses_independent_official_backup_during_portal_outage(self):
        fallback=[wind.station('LV','SYNOP-26422','Riga',56.97,24.06,[(NOW.timestamp(),5,9,180)])]
        with patch.object(lv,'load',side_effect=ValueError('unavailable')),patch.object(wind,'load_latvia_ckan',side_effect=ValueError('unavailable')),patch.object(s,'load_wind',return_value=fallback):
            self.assertEqual(wind.load_latvia(NOW),fallback)

if __name__=='__main__':unittest.main()
