import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import andorra_observations as ad
import europe_synop as synop
import update_official_temperature_all as temperatures
import update_official_temperature as core
import update_official_wind as wind

FIXTURES=Path(__file__).with_name('fixtures')
NOW=dt.datetime(2026,10,22,9,tzinfo=dt.timezone.utc)


class FranceAndorraObservations(unittest.TestCase):
    def fixture(self,name):
        return json.loads((FIXTURES/name).read_text())

    def test_native_utc_temperature_and_genuine_zero_wind(self):
        temps=ad.parse(self.fixture('andorra-temperature.json'),0,NOW)
        winds=ad.parse(self.fixture('andorra-wind.json'),4,NOW)
        self.assertGreaterEqual(len(temps),20)
        self.assertGreaterEqual(len(winds),10)
        pal=next(s for s in temps if s['code']=='7993')
        self.assertEqual(pal['temperature'],3.8)
        self.assertEqual(pal['time'],int(NOW.timestamp())-1800)
        calm=next(s for s in winds if s['code']=='99130002')
        self.assertEqual((calm['speed'],calm['direction']),(0,0))
        self.assertAlmostEqual(pal['lat'],42.536)

    def test_stale_missing_and_unknown_stations_are_not_current_observations(self):
        payload=self.fixture('andorra-temperature.json')
        for altered in ([],[['unknown',*payload[0][1:]]],[payload[0][:4]+['---']]):
            with self.assertRaises(ValueError):ad.parse(altered,0,NOW)
        with self.assertRaises(ValueError):ad.parse(payload,0,NOW+dt.timedelta(days=1))
        with self.assertRaises(ValueError):ad.parse(payload,5,NOW)

    def test_collectors_register_bounds_sources_and_preserve_missing_gusts_and_sensor_heights(self):
        rows=ad.load_temperature(NOW,lambda url:self.fixture('andorra-temperature.json'))
        self.assertTrue(rows);self.assertTrue(all(s['country']=='AD' and 'Servei' in s['source'] for s in rows))
        rows=ad.load_wind(NOW,lambda url:self.fixture('andorra-wind.json'))
        self.assertTrue(all(s['rows'][0][2] is None for s in rows))
        high=next(s for s in rows if s['code']=='99130027')
        self.assertEqual(high['windHeightM'],20)
        self.assertFalse(high['heatmapEligible'])
        self.assertTrue(next(s for s in rows if s['code']=='99130005')['heatmapEligible'])
        self.assertIn('daily maximum',high['period'])
        self.assertIn('FR',core.LOADERS);self.assertIn('AD',core.LOADERS)
        self.assertIsNone(core.make_station('AD','bad','France',48.8,2.3,[(NOW.timestamp(),12)]))

    def test_french_temperature_uses_observed_dry_bulb_not_forecast_or_wind(self):
        raw=(FIXTURES/'france-synop.csv').read_bytes()
        values=synop.parse(raw,'07149',(synop.TEMP,))
        meta={'country':'FR','name':'Paris','lat':48.733333,'lon':2.4}
        with patch.object(synop,'collect',return_value=[('07149',meta,values)]):
            rows=synop.load_temperature('FR',NOW,lambda url:raw)
        self.assertEqual(rows[0]['rows'][-1],[int(NOW.timestamp())-3*3600,values[0][1][synop.TEMP]])
        self.assertIn('Météo-France',rows[0]['source'])
        self.assertIsNotNone(core.make_station('FR','Corsica','Ajaccio',41.92,8.8,[(NOW.timestamp(),0)]))


if __name__=='__main__':unittest.main()
