import datetime as dt
import io
import pathlib
import sys
import unittest
import zipfile
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import update_snow_depth as core
from snow_depth_expansion import SnowDepthExpansion
from snow_depth_central import CentralSnowDepth
NOW=dt.datetime(2026,10,27,10,tzinfo=dt.timezone.utc)
META={'name':'Potsdam','lat':52.38,'lon':13.06}

def archive(rows):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w') as z:z.writestr('produkt_klima_tag_20261001_20261026_03987.txt','STATIONS_ID;MESS_DATUM;SHK_TAG\n'+rows)
    return b.getvalue()

class CentralSnowTests(unittest.TestCase):
    def setUp(self):self.x=CentralSnowDepth(SnowDepthExpansion(None,core.record,core.latest,core.NoRecentSnowData))
    def test_polish_total_depth_not_new_snow_or_water_equivalent(self):
        meta={'code':'349190650','name':'Kasprowy Wierch','latitude':49.23,'longitude':19.98}
        p={'snowCoverSize':[{'date':'2026-10-27T06:00:00Z','value':24}], 'newSnowSize':[{'date':'2026-10-27T06:00:00Z','value':14}], 'waterLevelInSnow':[{'date':'2026-10-27T06:00:00Z','value':46}]}
        r=self.x.parse_poland(p,meta,NOW)[0];self.assertEqual(r['depthCm'],24);self.assertEqual(r['time'],core.timestamp('2026-10-27T06:00:00Z'));self.assertIn('IMGW',r['sourceName'])
        for missing in (None,True,-1,999):
            p['snowCoverSize'][0]['value']=missing;self.assertEqual(self.x.parse_poland(p,meta,NOW),[])
    def test_polish_trace_patchy_zero_and_stale_dates(self):
        meta={'code':'349190650','name':'Kasprowy Wierch','latitude':49.23,'longitude':19.98}
        for value,state,depth in [(0,'bare',0),(997,'trace',None),(998,'patchy',None),(906,'patchy',None)]:
            p={'snowCoverSize':[{'date':'2026-10-27T06:00:00Z','value':value}]};r=self.x.parse_poland(p,meta,NOW)[0];self.assertEqual((r['state'],r['depthCm']),(state,depth))
        for date in ('2026-10-13T06:00:00Z','2026-10-28T06:00:00Z','2026-10-27T06:00:00'):
            self.assertEqual(self.x.parse_poland({'snowCoverSize':[{'date':date,'value':2}]},meta,NOW),[])

    def test_german_daily_values_zero_and_native_observation_day(self):
        out=self.x.parse_germany(archive('3987;20261025;5\n3987;20261026;0'), '03987',META,NOW)
        self.assertEqual(len(out),1);self.assertEqual(out[0]['depthCm'],0);self.assertEqual(out[0]['state'],'bare');self.assertEqual(out[0]['timePrecision'],'day');self.assertEqual(out[0]['time'],core.timestamp('2026-10-26T00:00:00Z'))
    def test_german_missing_special_old_future_values_not_snow_free(self):
        for date,value in [('20261026','-999'),('20261026','999'),('20261028','2'),('20261001','2')]:
            self.assertEqual(self.x.parse_germany(archive('3987;'+date+';'+value),'03987',META,NOW),[])
        with self.assertRaises(ValueError):self.x.parse_germany(archive('3999;20261026;3'),'03987',META,NOW)
    def test_country_bounds_cover_france_corsica_and_germany(self):
        for country,lat,lon in [('DE',47.4,10.9),('FR',42,9.1)]:self.assertIsNotNone(core.record(country,'x','Station',lat,lon,'2026-10-27T06:00:00Z',0))
        self.assertIsNone(core.record('DE','x','Foreign',59,24,'2026-10-27T06:00:00Z',0))
    def test_nivo_metres_to_centimetres_and_validity_time(self):
        meta={'07499':{'name':'Chamonix','lat':45.92,'lon':6.86}}
        raw='geo_id_wmo;validity_time;insert_time;ht_neige;ssfrai;ht_neige_alti\n7499;2026-10-26T06:15:00Z;2026-10-27T10:00:00Z;0.35;0.1;2.5\n'
        r=self.x.parse_nivo(raw,meta,NOW)[0];self.assertEqual(r['depthCm'],35);self.assertEqual(r['time'],core.timestamp('2026-10-26T06:15:00Z'));self.assertEqual(r['code'],'NIVO-07499')
        self.assertIn('not fresh snowfall',r['note'])
    def test_nivo_missing_unknown_stale_negative_and_future_rejected(self):
        meta={'07499':{'name':'Chamonix','lat':45.92,'lon':6.86}}
        for code,date,val in [('7499','2026-10-26T06:00:00Z',''),('7499','2026-10-26T06:00:00Z','-1'),('9999','2026-10-26T06:00:00Z','2'),('7499','2026-10-13T06:00:00Z','1'),('7499','2026-10-28T06:00:00Z','2')]:
            raw='geo_id_wmo;validity_time;ht_neige\n'+code+';'+date+';'+val+'\n';self.assertEqual(self.x.parse_nivo(raw,meta,NOW),[])
    def test_nivo_catalogue_and_explicit_zero(self):
        meta=self.x.nivo_metadata('Latitude,Longitude,ID,Nom\n45.92,6.86,07499,Chamonix\n59,24,12345,Foreign\n')
        self.assertEqual(set(meta),{'07499'});r=self.x.parse_nivo('geo_id_wmo;validity_time;ht_neige\n7499;2026-10-26T06:00:00Z;0\n',meta,NOW)[0]
        self.assertEqual(r['depthCm'],0)

if __name__=='__main__':unittest.main()
