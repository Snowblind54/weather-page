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


if __name__=='__main__':unittest.main()
