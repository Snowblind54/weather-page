import copy
import datetime as dt
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import update_rainfall as core
import rainfall_europe as europe

FIX=pathlib.Path(__file__).with_name('fixtures')
SAMPLE=json.loads((FIX/'rainfall-europe.json').read_text())
UTC=dt.timezone.utc


class EuropeanRainfallTests(unittest.TestCase):
    def test_synop_real_native_periods_do_not_become_hourly(self):
        meta={'country':'LU','name':'Luxembourg-Findel','lat':49.616667,'lon':6.216667}
        s=europe.parse_synop((FIX/'rainfall-poi-lu.csv').read_bytes(),'06590',meta)
        self.assertEqual(s['times'],[])
        self.assertTrue(any(p['hours']==12 for p in s['periods']))
        self.assertTrue(any(p['hours']==6 for p in s['periods']))
        now=dt.datetime(2026,10,20,16,tzinfo=UTC)
        merged=core.merge([], [s], now)[0]
        total=next(p for p in merged['accumulations'] if p['hours']==24)
        self.assertEqual(total,{'end':core.unix('2026-10-20T06:00:00Z'),'hours':24,'value':0})
        self.assertFalse(any(p['hours']==48 for p in merged['accumulations']))
        raw=(FIX/'rainfall-poi-lu.csv').read_text().splitlines()
        units=raw[1].split(';');units[33]='inch';raw[1]=';'.join(units);raw='\n'.join(raw)
        with self.assertRaises(ValueError):europe.parse_synop(raw,'06590',meta)

    def test_synop_exact_times_commas_and_station_identity(self):
        meta={'country':'GB','name':'Lerwick','lat':60.133333,'lon':-1.183333}
        s=europe.parse_synop((FIX/'rainfall-poi-sample.csv').read_bytes(),'03005',meta)
        self.assertIn(0.4,s['amounts'])
        self.assertIn({'end':core.unix('2026-10-20T06:00:00Z'),'hours':24,'value':0.8},s['periods'])
        self.assertNotIn(core.unix('2026-10-20T12:00:00Z'),s['times'],'missing hour remains missing')
        with self.assertRaises(ValueError):europe.parse_synop((FIX/'rainfall-poi-sample.csv').read_bytes(),'03006',meta)
        s=europe.parse_synop((FIX/'rainfall-poi-sk.csv').read_bytes(),'11934',{'country':'SK','name':'Poprad','lat':49.066667,'lon':20.25})
        self.assertEqual(len(s['times']),9)
        self.assertEqual(len([p for p in s['periods'] if p['hours']==24]),1)

    def test_interval_composition_never_counts_overlaps_or_missing_time(self):
        end=core.unix('2026-10-20T12:00:00Z')
        periods=[{'end':end,'hours':12,'value':3},{'end':end-12*3600,'hours':12,'value':2},
                 {'end':end,'hours':6,'value':99}]
        self.assertEqual(europe.complete_total({},periods,end,24),5)
        self.assertIsNone(europe.complete_total({},periods,end,48))
        self.assertIsNone(europe.complete_total({},[periods[0]],end,24))
        hours={end-i*3600:1 for i in range(48)}
        self.assertEqual(europe.complete_total(hours,[],end,48),48)
        del hours[end-8*3600]
        self.assertIsNone(europe.complete_total(hours,[],end,24))
        # Native 24-hour totals are authoritative; overlapping hourly data is not added.
        periods=[{'end':end,'hours':24,'value':4},{'end':end-24*3600,'hours':24,'value':7}]
        self.assertEqual(europe.complete_total(hours,periods,end,48),11)

    def test_merge_keeps_raw_periods_and_recomputes_corrected_totals(self):
        end=core.unix('2026-10-20T12:00:00Z');now=dt.datetime.fromtimestamp(end,UTC)
        s=core.station('LU','06590','Findel',49.62,6.22,[])
        s['periods']=[{'end':end-12*3600,'hours':12,'value':2},{'end':end,'hours':12,'value':3}]
        old=core.merge([], [s],now)
        revised=copy.deepcopy(s);revised['periods'][-1]['value']=4
        out=core.merge(old,[revised],now)[0]
        self.assertEqual(out['accumulations'][-1]['value'],6)
        self.assertEqual(core.merge(old,[],now)[0]['accumulations'],old[0]['accumulations'])
        future=copy.deepcopy(s);future['periods']=[{'end':end+3600,'hours':24,'value':100}]
        self.assertFalse(core.merge([], [future],now))

    def test_irish_hourly_parameter_preserves_gaps_and_native_units(self):
        fixture=SAMPLE['ie'];metadata={str(f['properties']['station_id']):f for f in fixture['metadata']}
        features=copy.deepcopy(fixture['observations'])
        out=europe.parse_ireland(features,metadata)
        self.assertEqual(len(out),1);self.assertEqual(len(out[0]['times']),3)
        features[1]['properties']['value_num']=-99
        event=copy.deepcopy(features[0]);event['properties']['parameter_name']='precipitation_amount_event';event['properties']['value_num']=100
        out=europe.parse_ireland(features+[event],metadata)[0]
        self.assertEqual(len(out['times']),2)
        self.assertNotIn(100,out['amounts'])
        offhour=copy.deepcopy(features[0]);offhour['properties']['observed_at']='2026-10-19T00:10:00Z'
        self.assertFalse(europe.parse_ireland([offhour],metadata))

    def test_irish_loader_uses_collection_url_without_trailing_slash(self):
        fixture=SAMPLE['ie'];seen=[]
        def download(url,*args):
            seen.append(url)
            if url==europe.IRELAND.rstrip('/')+'?f=json':
                return {'parameter_names':{'precipitation_amount':{'unit':{'symbol':'mm'}}}}
            if url==europe.IRELAND+'locations?f=json':return {'features':fixture['metadata']}
            if url.startswith(europe.IRELAND+'items?'):return {'features':fixture['observations']}
            raise ValueError('Unexpected Irish URL: '+url)
        with patch.object(core,'download',side_effect=download):
            rows=europe.load_ireland(dt.datetime(2026,10,20,16,tzinfo=UTC),[])
        self.assertEqual(len(rows),1)
        self.assertFalse(any('/?f=json' in url for url in seen))

    def test_polish_country_scope_excludes_hungarian_wmo_prefixes(self):
        now=dt.datetime(2026,10,20,16,tzinfo=UTC);end=int(now.timestamp())
        foreign=core.station('PL','12843','Budapest',47.43,19.18,[(end,1,False)])
        domestic=core.station('PL','12375','Warsaw',52.16,20.96,[(end,2,False)])
        out=core.merge([foreign],[domestic],now)
        self.assertEqual([s['code'] for s in out],['12375'])
        metadata=json.loads((pathlib.Path(__file__).parents[1]/'scripts/rainfall_synop_stations.json').read_text())['stations']
        self.assertTrue(all(12100<=int(code)<12700 for code,s in metadata.items() if s['country']=='PL'))
        self.assertEqual(metadata['03917']['country'],'GB')

    def test_knmi_tenths_trace_and_hour_24_at_next_utc_midnight(self):
        raw=(FIX/'rainfall-knmi.txt').read_bytes()
        out=europe.parse_netherlands(raw)
        self.assertTrue(out)
        # Metadata and declaration are real; controlled rows verify scaling and midnight.
        prefix='\n'.join(l for l in raw.decode().splitlines() if l.startswith('#'))+'\n'
        raw=prefix+'260,20261019,24,15\n260,20261020,1,-1\n260,20261020,2,\n260,20261020,3,-99\n'
        s=europe.parse_netherlands(raw)[0]
        self.assertEqual(s['times'],[core.unix('2026-10-20T00:00:00Z'),core.unix('2026-10-20T01:00:00Z')])
        self.assertEqual(s['amounts'],[1.5,0]);self.assertEqual(s['traces'],[s['times'][1]])
        with self.assertRaises(ValueError):europe.parse_netherlands(raw.replace('0.1 mm','inches'))

    def test_complete_short_intervals_no_duplicates_missing_zero_or_hour_shift(self):
        end=core.unix('2026-10-20T12:00:00Z')
        samples=[(end-i*600,0.2) for i in range(6)]
        self.assertEqual(europe.complete_hours(samples+samples,600),[(end,1.2,False)])
        self.assertEqual(europe.complete_hours(samples[:-1],600),[])
        self.assertEqual(europe.complete_hours([(t,None) for t,v in samples],600),[])
        self.assertEqual(europe.complete_hours([(t,0) for t,v in samples],600),[(end,0,False)])
        self.assertEqual(europe.complete_hours([(t+1,v) for t,v in samples],600),[])

    def test_belgian_complete_hours_and_station_metadata(self):
        metadata=SAMPLE['be']['metadata'];code=metadata[0]['properties']['code']
        end=core.unix('2026-10-20T12:00:00Z')
        features=[{'properties':{'code':code,'timestamp':dt.datetime.fromtimestamp(end-i*600,UTC).isoformat(),'precip_quantity':0.2}} for i in range(6)]
        s=europe.parse_belgium(features,metadata)[0];self.assertEqual(s['amounts'],[1.2])
        self.assertEqual(europe.parse_belgium(features[:-1],metadata)[0]['times'],[])

    def test_czech_hourly_quality_parameter_and_real_station_bounds(self):
        fixture=SAMPLE['cz'];payload=copy.deepcopy(fixture['payload']);code='0-20000-0-11406'
        rows=payload['data']['data']['values'];self.assertEqual(len(rows),4)
        s=europe.parse_czechia(payload,code,fixture['metadata']);self.assertEqual(len(s['times']),4)
        rows[0][-1]=3;rows[1][-1]=1;rows[2][-1]=True;rows[3][1]='SRA10M'
        self.assertEqual(europe.parse_czechia(payload,code,fixture['metadata'])['times'],[])
        south=core.station('SK','1','South Slovakia',47.75,18.5,[(core.unix('2026-10-20T12:00:00Z'),0,False)])
        self.assertEqual(south['lat'],47.75)

    def test_national_catalogue_is_wmo_verified_not_decimal_minutes(self):
        p=json.loads((pathlib.Path(__file__).parents[1]/'scripts/rainfall_synop_stations.json').read_text())
        self.assertEqual(p['stations']['11934']['country'],'SK')
        self.assertAlmostEqual(p['stations']['11934']['lat'],49+4/60,places=5)
        self.assertAlmostEqual(p['stations']['06590']['lat'],49+37/60,places=5)
        self.assertEqual({s['country'] for s in p['stations'].values()},{'GB','DE','PL','SK','LU'})


if __name__=='__main__':unittest.main()
