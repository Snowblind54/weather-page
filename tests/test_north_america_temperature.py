import sys,pathlib,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_north_america_temperature as mod

class NorthAmericaTemperatureTests(unittest.TestCase):
    def test_canada_only_accepts_msc_metadata_and_quality_checked_celsius(self):
        meta={'features':[{'properties':{'msc_id':'A','name':'Vancouver','data_provider':'MSC'}}]}
        def row(code='A',value=7,quality=100,unit='°C'):
            return {'geometry':{'coordinates':[-123,49]},'properties':{'msc_id-value':code,'air_temp':value,'air_temp-qa':quality,'air_temp-uom':unit,'obs_date_tm':'2026-10-08T09:00:00Z'}}
        data={'features':[row(),row('other'),row(quality=-10),row(value=None),row(unit='K')]}
        with patch.object(mod.core,'download_json',side_effect=[meta,data]):stations=mod.parse_canada()
        self.assertEqual(len(stations),1);self.assertEqual(stations[0]['rows'][0][1],7)
        self.assertEqual(stations[0]['country'],'CA')

    def test_greenland_uses_current_metadata_and_actual_temperature_parameter(self):
        meta={'features':[{'properties':{'country':'GRL','status':'Active','stationId':'A','name':'Nuuk'}},
                          {'properties':{'country':'GRL','status':'Active','stationId':'B','validTo':'2000-01-01'}}]}
        def row(code='A',param='temp_dry'):
            return {'geometry':{'coordinates':[-51,64]},'properties':{'stationId':code,'parameterId':param,'observed':'2026-10-08T09:00:00Z','value':-8}}
        with patch.object(mod.core,'download_json',side_effect=[meta,{'features':[row(),row('B'),row(param='pressure')]}]):stations=mod.parse_greenland()
        self.assertEqual(len(stations),1);self.assertEqual(stations[0]['name'],'Nuuk');self.assertEqual(stations[0]['rows'][0][1],-8)

    def test_country_bounds_do_not_leak_into_existing_sources(self):
        self.assertIsNone(mod.core.make_station('EE','A','A',64,-51,[('2026-10-08',0)]))
        self.assertIsNotNone(mod.core.make_station('GL','A','A',83,-30,[('2026-10-08',-72)]))
        self.assertIsNone(mod.core.make_station('CA','A','A',20,-123,[('2026-10-08',1)]))

    def test_pagination_collects_all_pages(self):
        pages=[{'features':[{'id':'a'}],'links':[{'rel':'next','href':mod.GEOMET+'swob-realtime/items?offset=1'}]}, {'features':[{'id':'b'}]}]
        with patch.object(mod.core,'download_json',side_effect=pages):rows=list(mod.features(mod.GEOMET+'swob-realtime/items',{'limit':1}))
        self.assertEqual([r['id'] for r in rows],['a','b'])

if __name__=='__main__':unittest.main()
