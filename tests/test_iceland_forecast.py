import importlib.util
import tempfile
import json
from datetime import datetime,timezone
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

spec=importlib.util.spec_from_file_location('iceland',Path(__file__).resolve().parents[1]/'scripts/update_iceland_forecast.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class IcelandForecastTests(unittest.TestCase):
    def test_extended_bounds_cover_europe_svalbard_and_northeast_greenland(self):
        west,south,east,north=m.BOUNDS
        self.assertEqual(west,-30)
        for lat,lon in [(78.2,15.6),(82.,-25.),(40.4,-3.7),(41.9,12.5),(55.8,37.6),(30.,31.2)]:
            self.assertTrue(west<=lon<=east and south<=lat<=north)
        self.assertEqual(m.ASSET_VERSION,'euroatlantic-v3')

    def test_ecmwf_fills_the_nordic_domain_when_its_forecast_has_ended(self):
        exclusion=np.ones((16,16),dtype=bool)
        nordic={'images':{'temperature':{'2026-10-07T21:00:00.000Z':'temperature.webp'}}}
        self.assertIs(m.nordic_exclusion_for_time(nordic,'2026-10-07T21:00:00.000Z',exclusion),exclusion)
        self.assertIsNone(m.nordic_exclusion_for_time(nordic,'2026-10-10T21:00:00.000Z',exclusion))

    def test_missing_nordic_dependencies_restore_only_six_referenced_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths=['data/forecast-cache/current/temperature.webp',
                   *(f'data/forecast-cache/current/{kind}-legend.webp' for kind in m.FIELDS)]
            manifest={'images':{'temperature':{'now':paths[0]}},
                      'legends':dict(zip(m.FIELDS,paths[1:]))}
            calls=[]
            def restore(selected):
                calls.append(selected)
                for name in selected:
                    path=root/name;path.parent.mkdir(parents=True,exist_ok=True)
                    Image.new('RGBA',(2,2),(0,0,0,255)).save(path,format='WEBP')
            self.assertEqual(m.ensure_nordic_inputs(manifest,root,restore),root/paths[0])
            self.assertEqual(calls,[paths])
            m.ensure_nordic_inputs(manifest,root,restore)
            self.assertEqual(len(calls),1)
            (root/paths[0]).unlink()
            with self.assertRaises(FileNotFoundError):
                m.ensure_nordic_inputs(manifest,root,lambda paths:None)
            manifest['images']['temperature']['now']='../outside.webp'
            with self.assertRaises(ValueError):m.ensure_nordic_inputs(manifest,root,restore)

    def test_numeric_gust_grid_keeps_coordinates_zero_and_native_maximum_interval(self):
        lat=np.array([60.75,61.,61.25,69.,69.25]);lon=np.array([-28.25,-28.,-27.75,-12.,-11.75])
        values=np.arange(25,dtype=float).reshape(5,5);values[1,1]=0
        frames={3:{'lat':lat,'lon':lon,'10fg':values,'gust_start':2,'gust_end':3}}
        grid=m.gust_grid(frames,datetime(2026,10,7,12,tzinfo=timezone.utc))
        self.assertEqual(grid['latitudes'],[61.,61.25,69.]);self.assertEqual(grid['longitudes'],[-28.,-27.75,-12.])
        self.assertEqual(grid['samples'][0]['values'][0],0);self.assertEqual(len(grid['samples'][0]['values']),9)
        self.assertEqual(grid['samples'][0]['start'],'2026-10-07T14:00:00.000Z')
        self.assertEqual(grid['samples'][0]['end'],'2026-10-07T15:00:00.000Z')
    def test_europe_gust_tiles_cover_native_grid_and_preserve_intervals(self):
        lat=np.arange(18,84.01,.25);lon=np.arange(-30,60.01,.25)
        values=np.full((len(lat),len(lon)),12.345);values[0,0]=0
        run=datetime(2026,10,7,18,tzinfo=timezone.utc)
        frames={3:{'lat':lat,'lon':lon,'10fg':values,'gust_start':2,'gust_end':3}}
        manifest=m.europe_gust_manifest('20261007T18Z-euroatlantic-v3')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);m.write_europe_gusts(frames,run,root)
            self.assertEqual(len(list(root.glob('*.json'))),9)
            for entry in manifest:
                grid=json.loads((root/Path(entry['path']).name).read_text())
                self.assertEqual(grid['region'],'Europe')
                self.assertEqual(grid['bounds'],entry['bounds'])
                self.assertEqual(grid['grid_spacing_degrees'],.25)
                self.assertEqual(len(grid['samples'][0]['values']),len(grid['latitudes'])*len(grid['longitudes']))
                self.assertEqual(grid['samples'][0]['start'],'2026-10-07T20:00:00.000Z')
                self.assertEqual(grid['samples'][0]['end'],'2026-10-07T21:00:00.000Z')
            self.assertEqual(json.loads((root/Path(manifest[0]['path']).name).read_text())['samples'][0]['values'][0],0)
            rome=json.loads((root/Path(manifest[4]['path']).name).read_text())
            self.assertTrue(rome['latitudes'][0]<=41.9<=rome['latitudes'][-1])
            self.assertTrue(rome['longitudes'][0]<=12.5<=rome['longitudes'][-1])

    def test_hourly_wind_interpolates_components_not_speed(self):
        lower={'2t':np.array([[270.]]),'10u':np.array([[4.]]),'10v':np.array([[0.]]),
               'tp':np.array([[.003]]),'tcc':np.array([[.2]])}
        upper={'2t':np.array([[282.]]),'10u':np.array([[-4.]]),'10v':np.array([[0.]]),
               'tp':np.array([[.009]]),'tcc':np.array([[.8]]),'10fg':np.array([[12.]])}
        fields=m.hourly_fields(lower,upper,.5)
        self.assertAlmostEqual(fields['wind'][0,0],0)
        self.assertAlmostEqual(fields['temperature'][0,0],276)
        self.assertAlmostEqual(fields['clouds'][0,0],.5)
        self.assertAlmostEqual(fields['rain'][0,0],2)  # 6 mm over 3 hours, not 6 mm/h.

    def test_decreasing_accumulation_does_not_make_up_rain(self):
        a={k:np.array([[0.]]) for k in ['2t','10u','10v','tp','tcc']}
        b={**a,'tp':np.array([[-.001]]),'10fg':np.array([[5.]])}
        with self.assertRaises(ValueError):m.hourly_fields(a,b,.5)

    def test_grib_rounding_decrease_is_zero_within_both_error_bounds(self):
        a={k:np.array([[0.]]) for k in ['2t','10u','10v','tp','tcc']}
        a['tp_packing_error']=2**-18
        b={**a,'tp':np.array([[-1.52587890625e-5]]),'tp_packing_error':2**-17,'10fg':np.array([[5.]])}
        self.assertEqual(m.hourly_fields(a,b,.5)['rain'][0,0],0)
        b['tp']=np.array([[-3e-5]])
        with self.assertRaises(ValueError):m.hourly_fields(a,b,.5)

    def test_render_keeps_mercator_north_at_top_and_rain_transparent(self):
        palette=np.array([[i,i,i,255] for i in range(64)],dtype=np.uint8)
        lat=np.array([61.,69.]);lon=np.array([-28.,-12.])
        grid=np.array([[0.,0.],[30.,30.]])
        with tempfile.TemporaryDirectory() as directory,patch.object(m,'SIZE',16),patch.object(m,'BOUNDS',[-28,61,-12,69]):
            path=Path(directory)/'wind.webp';m.render(grid,lat,lon,'wind',palette,path)
            with Image.open(path) as im:
                self.assertEqual(im.getpixel((0,0))[0],63)
                self.assertEqual(im.getpixel((0,15))[0],0)
            m.render(np.zeros((2,2)),lat,lon,'rain',palette,path)
            with Image.open(path) as im:self.assertEqual(im.getpixel((4,4))[3],0)

    def test_expanded_temperature_range_retains_distinct_extremes_and_zero(self):
        palette=np.array([[i,i,i,255] for i in range(128)],dtype=np.uint8)
        lat=np.array([61.,69.]);lon=np.array([-28.,-12.])
        with tempfile.TemporaryDirectory() as directory:
            for celsius,expected in [(-60,0),(-40,21),(0,64),(30,96),(60,127)]:
                path=Path(directory)/'temperature.webp'
                m.render(np.full((2,2),celsius+273.15),lat,lon,'temperature',palette,path,
                         bounds=[-28,61,-12,69],size=4)
                with Image.open(path) as im:self.assertEqual(im.getpixel((1,1))[0],expected)

    def test_nordic_domain_mask_reprojects_north_and_excludes_only_coverage(self):
        with patch.object(m,'SIZE',5):
            alpha=np.array([[255,255],[0,0]],dtype=np.uint8)
            mask=m.nordic_exclusion(alpha,m.BOUNDS)
            self.assertTrue(mask[0].all())
            self.assertFalse(mask[-1].any())
            east=m.nordic_exclusion(np.full((2,2),255),[30,18,60,84])
            self.assertFalse(east[:,:3].any())
            self.assertTrue(east[:,-1].all())

    def test_all_fields_leave_nordic_pixels_clear_even_when_ecmwf_rains(self):
        palette=np.full((64,4),255,dtype=np.uint8)
        lat=np.array([m.BOUNDS[1],m.BOUNDS[3]]);lon=np.array([m.BOUNDS[0],m.BOUNDS[2]])
        with tempfile.TemporaryDirectory() as directory,patch.object(m,'SIZE',16):
            exclusion=np.zeros((16,16),dtype=bool);exclusion[:,8:]=True
            for kind in m.FIELDS:
                path=Path(directory)/(kind+'.webp')
                value=sum(m.RANGES[kind])/2
                m.render(np.full((2,2),value),lat,lon,kind,palette,path,exclusion)
                with Image.open(path) as im:
                    self.assertEqual(im.getpixel((4,4))[3],255)
                    self.assertEqual(im.getpixel((12,4))[3],0)

if __name__=='__main__':unittest.main()



