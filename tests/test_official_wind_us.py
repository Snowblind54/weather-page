import csv,datetime as dt,io,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import official_wind_us as us

class USWindTests(unittest.TestCase):
    def setUp(self):
        self.now=dt.datetime(2026,10,12,14,tzinfo=dt.timezone.utc);self.stamp=int(self.now.timestamp())
        self.meta={code:{'country':country,'state':state,'lat':lat,'lon':lon,'site':code} for code,country,state,lat,lon in [('KJFK','US','NY',40.6,-73.8),('PANC','US','AK',61.2,-150),('PHNL','US','HI',21.3,-157.9),('PASY','US','AK',52.7,174.1),('CYVR','CA','BC',49,-123),('BAD','US','FL',0,0)]}
    def cache(self,rows):
        out=io.StringIO();w=csv.DictWriter(out,fieldnames=['raw_text','station_id','observation_time','wind_speed_kt','wind_gust_kt','wind_dir_degrees','metar_type']);w.writeheader()
        for code,speed,gust,direction,offset,kind in rows:
            w.writerow({'raw_text':'METAR '+code,'station_id':code,'observation_time':(self.now+dt.timedelta(seconds=offset)).isoformat(),'wind_speed_kt':speed,'wind_gust_kt':gust,'wind_dir_degrees':direction,'metar_type':kind})
        return 'generation notes\n'+out.getvalue()
    def test_country_metadata_bounds_units_and_real_observation_times(self):
        raw=self.cache([(c,10,20,90,0,'METAR') for c in self.meta]+[('MISSING',10,20,90,0,'METAR')])
        rows=us.parse_us_metars(raw,self.meta,self.now);self.assertEqual({s['code'] for s in rows},{'KJFK','PANC','PHNL','PASY'})
        self.assertTrue(all(s['rows']==[[self.stamp,5.14,10.29,90]] for s in rows))
    def test_calm_missing_variable_stale_and_gust_only_are_not_fabricated(self):
        raw=self.cache([('KJFK',0,'','VRB',0,'METAR'),('PANC','',20,'',0,'SPECI'),('PHNL','','',90,0,'METAR'),('PASY',5,'NaN',400,0,'METAR'),('KJFK',20,30,90,-12000,'METAR'),('KJFK',20,30,90,120,'METAR'),('KJFK',20,30,90,-60,'TAF')])
        rows={s['code']:s for s in us.parse_us_metars(raw,self.meta,self.now)}
        self.assertEqual(rows['KJFK']['rows'],[[self.stamp,0,None,None]])
        self.assertEqual(rows['PANC']['rows'],[[self.stamp,None,10.29,None]])
        self.assertEqual(rows['PASY']['rows'],[[self.stamp,2.57,None,None]])
        self.assertNotIn('PHNL',rows)
    def test_duplicate_corrections_replace_values_and_preserve_sorted_history(self):
        raw=self.cache([('KJFK',10,20,90,-3600,'METAR'),('KJFK',12,'',90,0,'METAR'),('KJFK',13,25,100,0,'SPECI')])
        rows=us.parse_us_metars(raw,self.meta,self.now)[0]['rows']
        self.assertEqual(rows,[[self.stamp-3600,5.14,10.29,90],[self.stamp,6.69,12.86,100]])
        with self.assertRaisesRegex(ValueError,'header'):us.parse_us_metars('broken',self.meta,self.now)
        with self.assertRaisesRegex(ValueError,'No recent'):us.parse_us_metars(self.cache([('CYVR',10,20,90,0,'METAR')]),self.meta,self.now)

if __name__=='__main__':unittest.main()
