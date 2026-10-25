import copy
import datetime as dt
import io
import gzip
import json
from pathlib import Path
import sys
import tarfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import iberia_observations as ib
import update_official_temperature_all
import update_official_temperature as temperature
import update_official_wind as wind

FIXTURES=Path(__file__).with_name('fixtures')
NOW=dt.datetime(2026,10,22,9,30,tzinfo=dt.timezone.utc)
END=int(NOW.timestamp())


def archive(layers):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w:gz') as tar:
        for name,payload in layers.items():
            data=json.dumps(payload).encode();entry=tarfile.TarInfo(name);entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
    return output.getvalue()


class IberianOfficialObservations(unittest.TestCase):
    def fixture(self,name):return json.loads((FIXTURES/name).read_text())

    def test_aemet_native_utc_and_kmh_conversion_with_canary_islands(self):
        f=self.fixture('aemet-hourly.json');rows=ib.parse_aemet(archive(f['layers']),f['names'],NOW)
        mainland=next(s for s in rows if s['code']=='9051')
        self.assertEqual(mainland['rows'][-1],[END-1800,5.9,2/3.6,5/3.6,180])
        self.assertTrue(any(s['lat']<30 for s in rows))
        self.assertTrue(all(s['name']==f['names'][s['code']] for s in rows))
        self.assertEqual(rows,ib.parse_aemet(gzip.decompress(archive(f['layers'])),f['names'],NOW))

    def test_missing_gust_is_not_daily_maximum_and_real_zero_is_preserved(self):
        f=self.fixture('aemet-hourly.json');layers={k:v for k,v in f['layers'].items() if '/rach/' not in k}
        for path,payload in layers.items():
            if '/vien/' in path:
                for feature in payload['features']:feature['properties']['VV10m']=0
        sample=next(iter(layers.values()))
        layers['diarios/racha/fake.geojson']=sample
        rows=ib.parse_aemet(archive(layers),f['names'],NOW)
        self.assertTrue(all(r[3] is None for s in rows for r in s['rows']))
        self.assertTrue(any(r[2]==0 for s in rows for r in s['rows']))

    def test_ipma_uses_native_mps_and_hourly_temperature_with_utc_and_missing_sentinels(self):
        obs=self.fixture('ipma-observations.json');meta=self.fixture('ipma-stations.json')
        # Madeira's last valid capture is 07:00; the 08:00 record is null.
        rows=ib.parse_ipma(obs,meta,NOW-dt.timedelta(hours=1))
        self.assertTrue(any(s['lon']<-24 for s in rows));self.assertTrue(any(30<s['lat']<34 for s in rows))
        self.assertFalse(any(30<s['lat']<34 for s in ib.parse_ipma(obs,meta,NOW)))
        code='1210881';latest=max(obs);value=obs[latest][code]
        s=next(s for s in rows if s['code']==code)
        self.assertEqual(s['rows'][-1][0],ib.stamp(latest))
        self.assertEqual(s['rows'][-1][2],value['intensidadeVento'])
        self.assertTrue(all(r[3] is None for s in rows for r in s['rows']))
        fake={latest:{code:dict(temperatura=0,intensidadeVento=0,idDireccVento=0)}}
        row=ib.parse_ipma(fake,meta,NOW)[0]['rows'][0];self.assertEqual(row[1:],[0,0,None,None])
        fake[latest][code].update(temperatura=-99,intensidadeVento=-99)
        with self.assertRaises(ValueError):ib.parse_ipma(fake,meta,NOW)

    def test_stale_future_foreign_and_unknown_station_rows_do_not_publish(self):
        f=self.fixture('aemet-hourly.json')
        with self.assertRaises(ValueError):ib.parse_aemet(archive(f['layers']),f['names'],NOW+dt.timedelta(days=2))
        layers=copy.deepcopy(f['layers'])
        for payload in layers.values():
            for feature in payload['features']:feature['properties']['FINT']='2026-10-22T12:00:00'
        with self.assertRaises(ValueError):ib.parse_aemet(archive(layers),f['names'],NOW)
        with self.assertRaises(ValueError):ib.parse_aemet(archive(f['layers']),{},NOW)
        self.assertIsNone(ib.point(dict(geometry=dict(type='Point',coordinates=[24,59]),properties={}), 'ES'))

    def test_download_link_and_station_names_are_discovered_from_the_official_page(self):
        f=self.fixture('aemet-hourly.json');calls=[]
        page='var estaciones = ['+','.join('{id: '+json.dumps(c)+', nombre: '+json.dumps(n,ensure_ascii=False)+'}' for c,n in f['names'].items())+']; <a href="/es/geojson/download/udat/udat_descarga_123.tar.gz">Download</a>'
        def download(url):
            calls.append(url)
            return page if url==ib.AEMET else archive(f['layers'])
        self.assertTrue(ib.load('ES',NOW,download))
        self.assertEqual(calls,[ib.AEMET,'https://www.aemet.es/es/geojson/download/udat/udat_descarga_123.tar.gz'])
        self.assertEqual(ib.aemet_names(b'var estaciones = [{id: "A1", nombre: "Coru\xf1a"}];')['A1'],'Coruña')
        with self.assertRaises(ValueError):ib.load('ES',NOW,lambda u:'<html>unavailable</html>')

    def test_country_bounds_and_collectors_cover_mainland_and_islands(self):
        f=self.fixture('aemet-hourly.json');es=ib.parse_aemet(archive(f['layers']),f['names'],NOW)
        pt=ib.parse_ipma(self.fixture('ipma-observations.json'),self.fixture('ipma-stations.json'),NOW)
        for country,rows in [('ES',es),('PT',pt)]:
            with patch.object(ib,'load',return_value=rows):
                temps=ib.load_temperature(country,NOW,lambda url:b'');winds=ib.load_wind(country,NOW,lambda url:b'')
            self.assertTrue(temps);self.assertTrue(winds)
            self.assertTrue(all(s['country']==country for s in temps+winds))
            self.assertTrue(all('provisional' in s['source'] for s in temps))
            if country=='PT':self.assertTrue(all(r[2] is None for s in winds for r in s['rows']))
        for c,lat,lon in [('ES',28.3,-16.5),('ES',39.5,2.7),('PT',32.7,-16.9),('PT',39.4,-31.1)]:
            self.assertIsNotNone(temperature.make_station(c,c,c,lat,lon,[(END,0)]))
            self.assertTrue(wind.station(c,c,c,lat,lon,[(END,0,None,None)])['rows'])


    def test_spanish_airport_backup_uses_recent_metars_and_native_units(self):
        now=dt.datetime(2026,10,25,15,tzinfo=dt.timezone.utc)
        reports=self.fixture('spain-airport-metars.json')
        metadata=json.loads(Path(ib.__file__).with_name('spain_airport_stations.json').read_text())['stations']
        rows=ib.parse_spain_metars(reports,metadata,now)
        self.assertEqual({s['code'] for s in rows},{'METAR-LEMD','METAR-LEPA','METAR-GCLA'})
        self.assertTrue(any(s['lat']<30 for s in rows))
        first=next(r for r in reports if r['icaoId']=='LEMD')
        row=next(s for s in rows if s['code']=='METAR-LEMD')['rows'][-1]
        self.assertEqual(row[0],first['obsTime']);self.assertEqual(row[1],first['temp'])
        self.assertAlmostEqual(row[2],first['wspd']*1852/3600)
        zero={**first,'wspd':0,'temp':0,'wgst':None,'wdir':'VRB'}
        row=ib.parse_spain_metars([zero],metadata,now)[0]['rows'][0]
        self.assertEqual(row[1:],[0,0,None,None])
        for change in [{'icaoId':'EGLL'},{'metarType':'TAF'},{'obsTime':int(now.timestamp())-3*3600},
                       {'obsTime':int(now.timestamp())+600},{'temp':None,'wspd':None,'wgst':None}]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):ib.parse_spain_metars([{**first,**change}],metadata,now)

    def test_aemet_failure_falls_back_and_projects_honest_sources_without_invented_gusts(self):
        now=dt.datetime(2026,10,25,15,tzinfo=dt.timezone.utc)
        reports=self.fixture('spain-airport-metars.json');calls=[]
        def download(url):
            calls.append(url);self.assertTrue(url.startswith(ib.METAR+'?'));self.assertIn('hours=2',url)
            return json.dumps(reports)
        with patch.object(ib,'load_aemet',side_effect=ValueError('No current official AEMET observations')):
            temps=ib.load_temperature('ES',now,download);winds=ib.load_wind('ES',now,download)
        self.assertEqual(len(temps),3);self.assertEqual(len(winds),3);self.assertEqual(len(calls),2)
        self.assertTrue(all('METAR' in s['source'] for s in temps))
        self.assertTrue(all(s['observationNetwork']=='spain-airport-metar' for s in temps+winds))
        self.assertTrue(all(s['gustLabel']=='Reported METAR gust' and 'not an hourly maximum' in s['period'] for s in winds))
        self.assertTrue(any(r[2] is None for s in winds for r in s['rows']))
        with patch.object(ib,'load_aemet',side_effect=ValueError('stale')):
            with self.assertRaises(ValueError):ib.load('ES',now,lambda url:'[]')

    def test_recovered_aemet_is_preferred_and_switching_networks_removes_duplicates(self):
        now=dt.datetime(2026,10,25,15,tzinfo=dt.timezone.utc);end=int(now.timestamp())
        raw=[dict(code='A1',name='AEMET station',lat=40,lon=-4,rows=[[end,15,3,5,180]],observationNetwork='aemet-hourly')]
        with patch.object(ib,'load_aemet',return_value=raw):
            fresh=ib.load_temperature('ES',now,lambda url:self.fail('Backup must not be requested after AEMET recovers'))
        backup={**fresh[0],'code':'METAR-LEMD','observationNetwork':'spain-airport-metar'}
        merged=temperature.merge_country_history({'stations':[backup]},'ES',fresh,end-86400,end)
        self.assertEqual([s['code'] for s in merged],['A1'])
        merged=wind.merge([backup],[{**fresh[0],'rows':[[end,3,5,180]]}],now)
        self.assertEqual([s['code'] for s in merged],['A1'])


if __name__=='__main__':unittest.main()
