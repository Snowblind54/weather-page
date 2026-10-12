import csv, datetime as dt, io, json, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_us_temperature as us

class USTemperatureTests(unittest.TestCase):
    def setUp(self):
        self.now=int(dt.datetime.now(dt.timezone.utc).timestamp())
        self.metadata={code:{'country':country,'state':state,'lat':lat,'lon':lon,'site':code} for code,country,state,lat,lon in [
            ('KJFK','US','NY',40.64,-73.78),('PANC','US','AK',61.17,-150),('PHNL','US','HI',21.32,-157.92),('PASY','US','AK',52.7,174.1),('CYVR','CA','BC',49.2,-123.2),('KOUT','US','FL',0,0)]}
    def cache(self,rows):
        f=io.StringIO();w=csv.DictWriter(f,fieldnames=['raw_text','station_id','observation_time','latitude','longitude','temp_c','metar_type']);w.writeheader()
        for code,temp,offset,kind in rows:
            w.writerow({'raw_text':'METAR '+code,'station_id':code,'observation_time':dt.datetime.fromtimestamp(self.now+offset,dt.timezone.utc).isoformat(),'latitude':-99.99,'longitude':-99.99,'temp_c':temp,'metar_type':kind})
        return 'generation notes\n'+f.getvalue()
    def test_official_metadata_and_observation_validation(self):
        raw=self.cache([('KJFK',0,0,'METAR'),('PANC',-12,0,'METAR'),('PHNL',27,0,'SPECI'),('PASY',4,0,'METAR'),('CYVR',8,0,'METAR'),('UNKNOWN',8,0,'METAR'),('KOUT',8,0,'METAR'),('KJFK','',-10,'METAR'),('KJFK','nan',-20,'METAR'),('KJFK',-99,-30,'METAR'),('KJFK',9,-20000,'METAR'),('KJFK',9,1000,'METAR'),('KJFK',9,-50,'TAF')])
        # KOUT has a US country code but lies outside the supported US domain.
        out=us.parse_us_metars(raw,self.metadata,self.now)
        self.assertEqual({s['code'] for s in out},{'KJFK','PANC','PHNL','PASY'})
        jfk=next(s for s in out if s['code']=='KJFK');self.assertEqual(jfk['rows'],[[self.now,0]])
        self.assertEqual(jfk['lat'],40.64);self.assertIn('NOAA',jfk['source'])
    def test_corrections_replace_the_same_timestamp_and_history_is_sorted(self):
        out=us.parse_us_metars(self.cache([('KJFK',10,-3600,'METAR'),('KJFK',11,0,'METAR'),('KJFK',12,0,'SPECI')]),self.metadata,self.now)
        self.assertEqual(out[0]['rows'],[[self.now-3600,10],[self.now,12]])
        with self.assertRaisesRegex(ValueError,'header'):us.parse_us_metars('bad csv',self.metadata,self.now)
        with self.assertRaisesRegex(ValueError,'No recent'):us.parse_us_metars(self.cache([('KJFK','',0,'METAR')]),self.metadata,self.now)
    def test_metadata_is_downloaded_once_daily_and_reused_on_short_outage(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(us,'METADATA_CACHE',pathlib.Path(tmp)/'stations.json'), patch.object(us.core,'download_json',return_value=list(self.metadata.values())+[{'icaoId':'KJFK',**self.metadata['KJFK']}]) as download:
            first=us.station_metadata();self.assertIn('KJFK',first);us.station_metadata();self.assertEqual(download.call_count,1)
            data=json.loads(us.METADATA_CACHE.read_text());data['generatedAt']=self.now-2*86400;us.METADATA_CACHE.write_text(json.dumps(data))
            download.side_effect=OSError('provider unavailable');self.assertEqual(us.station_metadata(),first)
    def test_shared_updater_reuses_us_data_until_30_minutes_then_fetches(self):
        station=us.core.make_station('US','KJFK','JFK',40.64,-73.78,[(self.now,12)])
        with tempfile.TemporaryDirectory() as tmp, patch.object(us.core,'OUTPUT',pathlib.Path(tmp)/'official-temperature.json'), patch.object(us.core,'LOADERS',{'US':lambda:[station]}):
            old={'stations':[station],'sources':{'US':{'ok':True,'count':1,'lastFetch':self.now}}}
            us.core.OUTPUT.write_text(json.dumps(old));us.core.main();data=json.loads(us.core.OUTPUT.read_text())
            self.assertTrue(data['sources']['US']['cached']);self.assertEqual(data['sources']['US']['lastFetch'],self.now)
            data['sources']['US']['lastFetch']=self.now-1900;us.core.OUTPUT.write_text(json.dumps(data));us.core.main()
            self.assertEqual(json.loads(us.core.OUTPUT.read_text())['sources']['US']['lastFetch'],self.now)

if __name__=='__main__':unittest.main()
