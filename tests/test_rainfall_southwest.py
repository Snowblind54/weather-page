import copy
import datetime as dt
import io
import json
import pathlib
import sys
import tarfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts'))
import update_rainfall as core
import rainfall_southwest as sw

UTC=dt.timezone.utc
NOW=dt.datetime(2026,10,27,10,tzinfo=UTC)
META={'name':'Aixàs','lat':42.475,'lon':1.462}

def archive(layers):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as tar:
        for name,features in layers.items():
            b=json.dumps({'type':'FeatureCollection','features':features}).encode();item=tarfile.TarInfo(name);item.size=len(b);tar.addfile(item,io.BytesIO(b))
    return out.getvalue()

def feature(properties,lat=40.4,lon=-3.7):return {'geometry':{'type':'Point','coordinates':[lon,lat]},'properties':properties}

def chart(values=None,labels=None):
    labels=labels or ['23h','27/10/2026','1h','2h','3h','4h','5h','6h','7h','8h','9h','10h']
    values=values or ['1']*len(labels)
    return '<chart><chart_data><row><null/>'+''.join('<string>'+x+'</string>' for x in labels)+'</row><row><string>prec</string>'+''.join('<null/>' if x is None else '<number>'+x+'</number>' for x in values)+'</row></chart_data><draw><text>mm</text><text>Hora UTC</text></draw></chart>'

class SouthwestRainTests(unittest.TestCase):
    def test_spain_hourly_daily_utc_dates_and_dst_offsets(self):
        layers={'horarios/prec/x.geojson':[feature({'IDEMA':'A','FINT':'2026-10-27T09:00:00','PREC':0})],
          'diarios/pre-0024/a.geojson':[feature({'IDEMA':'A','FINIT':'2026-10-25T00:00:00+02:00','pre-0024':2})],
          'diarios/pre-0024/b.geojson':[feature({'IDEMA':'A','FINIT':'2026-10-26T00:00:00+01:00','pre-0024':3})],
          'diarios/pre6/wrong.geojson':[feature({'IDEMA':'A','FINIT':'2026-10-26T00:00:00+01:00','pre6':999})]}
        s=core.merge([],sw.parse_spain(archive(layers),{'A':'Madrid'},NOW),NOW)[0]
        self.assertEqual(s['amounts'],[0])
        self.assertIn({'end':core.unix('2026-10-27T00:00:00Z'),'hours':48,'value':5},s['accumulations'])
        self.assertNotIn(999,[p['value'] for p in s['periods']])
    def test_spain_missing_future_foreign_and_not_hourly(self):
        raw=archive({'horarios/prec/x.geojson':[feature({'IDEMA':'A','FINT':'2026-10-27T09:00:00','PREC':-99}),feature({'IDEMA':'A','FINT':'2026-10-27T11:00:00','PREC':5}),feature({'IDEMA':'X','FINT':'2026-10-27T09:00:00','PREC':4})]})
        self.assertEqual(sw.parse_spain(raw,{'A':'Madrid'},NOW),[])
        with self.assertRaises(ValueError):core.station('ES','X','Foreign',59,24,[])
    def test_andorra_chart_absolute_date_and_missing_hour(self):
        values=['1']*12;values[3]=None
        s=sw.parse_andorra_chart(chart(values),'1',META,NOW)
        self.assertEqual(len(s['times']),10)
        self.assertNotIn(core.unix('2026-10-27T10:00:00Z'),s['times'])
        self.assertNotIn(core.unix('2026-10-27T02:00:00Z'),s['times'])
        self.assertEqual(s['times'][0],core.unix('2026-10-26T23:00:00Z'))
    def test_andorra_chart_units_sequence_and_missing_date_fail_closed(self):
        for raw in [chart().replace('Hora UTC','Hora local'),chart().replace('<text>mm','<text>cm'),chart().replace('27/10/2026','0h'),chart().replace('2h','3h')]:
            with self.assertRaises(ValueError):sw.parse_andorra_chart(raw,'1',META,NOW)
    def test_andorra_climate_day_ends_next_day_06utc(self):
        payload=[['1','<span>26/10/2026</span>','Aixàs','','2,5 mm']]
        a=sw.parse_andorra_day(payload,'26/10/2026',{'1':META},NOW)[0]
        self.assertEqual(a['times'],[])
        self.assertEqual(a['periods'],[{'end':core.unix('2026-10-27T06:00:00Z'),'hours':24,'value':2.5}])
        self.assertEqual(sw.parse_andorra_day(payload,'25/10/2026',{'1':META},NOW),[])
        self.assertEqual(sw.parse_andorra_day(payload,'26/10/2026',{'1':META},NOW.replace(hour=5)),[])
        previous=copy.deepcopy(a);previous['periods'][0]['end']-=86400
        s=core.merge([],[previous,a],NOW)[0]
        self.assertEqual(s['accumulations'][-1]['hours'],48);self.assertEqual(s['accumulations'][-1]['value'],5)
    def test_france_validity_time_native_intervals_and_gaps(self):
        rows='geo_id_wmo;validity_time;reference_time;rr1;rr3;rr6;rr12;rr24\n07149;2026-10-27T06:00:00Z;2026-10-27T07:10:00Z;0;2;;;3\n07149;2026-10-26T06:00:00Z;2026-10-26T07:00:00Z;;;;;4\n07149;2026-10-28T06:00:00Z;;100;;;;100\n99999;2026-10-27T06:00:00Z;;1;;;;1\n'
        meta={'07149':{'country':'FR','name':'Orly','lat':48.73,'lon':2.4}}
        s=core.merge([],sw.parse_france_archive(io.StringIO(rows),meta,NOW),NOW)[0]
        self.assertEqual(s['times'],[core.unix('2026-10-27T06:00:00Z')]);self.assertEqual(s['amounts'],[0])
        self.assertIn({'end':s['times'][0],'hours':48,'value':7},s['accumulations'])
        self.assertEqual(len(s['times']),1,'3-hour totals never become three hourly values')
    def test_install_adds_all_sources_and_loaders(self):
        class Target:SOURCES={};LOADERS={}
        sw.install(Target)
        self.assertEqual(set(Target.LOADERS),{'FR','AD','ES'})
        self.assertEqual(set(Target.SOURCES),{'FR','AD','ES'})

if __name__=='__main__':unittest.main()
