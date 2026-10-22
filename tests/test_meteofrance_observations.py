"""Representative contract fixtures, not a captured authenticated API response."""
import copy
import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import meteofrance_observations as mf
import update_official_temperature_all as temperature
import update_official_temperature as core
import update_official_wind as wind
import europe_synop

NOW=dt.datetime(2026,10,22,9,tzinfo=dt.timezone.utc)
END=int(NOW.timestamp())


class MeteoFranceObservations(unittest.TestCase):
    def payload(self):
        return json.loads((Path(__file__).with_name('fixtures')/'meteofrance-6m.geojson').read_text())

    def test_kelvin_native_mps_actual_time_corsica_and_zero(self):
        rows=mf.parse(self.payload(),NOW,{'01014002':'Arbent'})
        first=next(s for s in rows if s['code']=='01014002')
        self.assertEqual(first['name'],'Arbent')
        self.assertEqual(first['rows'],[[END-12*60,0,0,0,0]])
        corsica=next(s for s in rows if s['code']=='20004002')
        self.assertEqual(corsica['rows'][0][1:],[10.6,2,3.9,210])

    def test_missing_gust_never_uses_maximum_mean_or_different_schema_field(self):
        rows=mf.parse(self.payload(),NOW)
        paris=next(s for s in rows if s['code']=='91027002')
        self.assertIsNone(paris['rows'][0][1]);self.assertIsNone(paris['rows'][0][3])
        old=self.payload()['features'][0];old['properties'].pop('raf10');old['properties']['fxi10']=8
        self.assertEqual(mf.parse([old],NOW)[0]['rows'][0][3],8)
        old['properties'].pop('fxi10');self.assertIsNone(mf.parse([old],NOW)[0]['rows'][0][3])

    def test_future_stale_overseas_foreign_coordinates_and_invalid_values_are_excluded(self):
        sample=self.payload()['features'][0]
        for key,value in [('validity_time','2026-10-21T08:48:00Z'),('validity_time','2026-10-22T09:06:00Z'),('validity_time',None),('geo_id_insee','97101001'),('geo_id_insee','99138001')]:
            row=copy.deepcopy(sample);row['properties'][key]=value
            with self.assertRaises(ValueError):mf.parse([row],NOW)
        row=copy.deepcopy(sample);row['geometry']['coordinates']=[-61,16]
        with self.assertRaises(ValueError):mf.parse([row],NOW)
        row=copy.deepcopy(sample);row['properties'].update(t=True,ff=-1,raf10=float('nan'))
        with self.assertRaises(ValueError):mf.parse([row],NOW)

    def test_bulk_request_is_one_package_with_header_key_and_utc_six_minute_date(self):
        calls=[]
        def fetch(url,key):calls.append((url,key));return self.payload()
        metadata=b'Id_station;Nom_usuel;Latitude;Longitude\n01014002;ARBENT;46.2;5.6\n'
        with tempfile.TemporaryDirectory() as directory,patch.dict(mf.os.environ,{'METEOFRANCE_API_KEY':'test-only-placeholder'}),patch.object(mf,'CACHE',Path(directory)/'names.csv'):
            rows=mf.load(NOW,lambda url:metadata,fetch)
            self.assertEqual(len(rows),4);self.assertEqual(len(calls),1)
            self.assertIn('date=2026-10-22T08%3A48%3A00Z',calls[0][0]);self.assertNotIn('placeholder',calls[0][0])
            self.assertEqual(rows[0]['code'],'01014002')
        with patch.dict(mf.os.environ,{},clear=True):
            with self.assertRaisesRegex(ValueError,'not configured'):mf.load(NOW,lambda url:metadata,fetch)

    def test_request_errors_discard_response_secrets_and_do_not_put_key_in_url(self):
        observed=[]
        def fail(request,timeout):
            observed.append(request)
            raise urllib.error.HTTPError(request.full_url,401,'bad token',{},io.BytesIO(b'private-body'))
        with patch.object(mf.urllib.request,'urlopen',side_effect=fail):
            with self.assertRaisesRegex(ValueError,'HTTP 401') as error:mf.request_json(mf.BASE+'test','test-only-placeholder')
        self.assertNotIn('private-body',str(error.exception));self.assertNotIn('placeholder',str(error.exception))
        self.assertEqual(observed[0].get_header('Apikey'),'test-only-placeholder')
        self.assertNotIn('placeholder',observed[0].full_url)

    def test_temperature_and_wind_projections_do_not_invent_missing_observations(self):
        parsed=mf.parse(self.payload(),NOW)
        with patch.object(mf,'load',return_value=parsed):
            temps=mf.load_temperature(NOW,lambda url:b'');winds=mf.load_wind(NOW,lambda url:b'')
        self.assertEqual(len(temps),3);self.assertEqual(len(winds),3)
        self.assertTrue(all(s['code'].startswith('MF-') and s['observationNetwork']==mf.NETWORK for s in temps+winds))
        self.assertTrue(all(s['gustLabel']=='Gust max · 10 min' for s in winds))

    def test_auth_failure_keeps_true_synop_backup_without_claiming_national_coverage(self):
        old=[wind.station('FR','SYNOP-07149','Paris',48.73,2.4,[(END,2,5,180)])]
        with patch.object(mf,'load_wind',side_effect=ValueError('not configured')),patch.object(europe_synop,'load_wind',return_value=copy.deepcopy(old)):
            rows=wind.load_france(NOW)
        self.assertEqual(rows[0]['observationNetwork'],'france-synop')
        with patch.object(mf,'load_temperature',side_effect=ValueError('not configured')),patch.object(europe_synop,'load_temperature',return_value=copy.deepcopy(old)):
            self.assertEqual(temperature.parse_france()[0]['observationNetwork'],'france-synop')

    def test_provider_switch_does_not_duplicate_stations_or_mix_native_gust_periods(self):
        old=dict(country='FR',code='SYNOP-07149',name='Paris',lat=48.73,lon=2.4,rows=[[END-3600,2,5,180]])
        fresh={**old,'code':'MF-91027002','observationNetwork':mf.NETWORK,'rows':[[END-600,3,6,180]]}
        self.assertEqual([s['code'] for s in wind.merge([old],[fresh],NOW)],['MF-91027002'])
        self.assertEqual([s['code'] for s in core.merge_country_history({'stations':[old]},'FR',[fresh],END-86400,END)],['MF-91027002'])
        backup={**old,'observationNetwork':'france-synop'}
        self.assertEqual([s['code'] for s in wind.merge([fresh],[backup],NOW)],['SYNOP-07149'])


if __name__=='__main__':unittest.main()
