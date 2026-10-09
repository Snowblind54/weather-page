import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_radar_tiles as radar

class RadarTiles(unittest.TestCase):
    def test_geographic_tile_alignment_and_lossless_colours(self):
        self.assertEqual(radar.world(0,0,3),(1024,1024))
        image=Image.new('RGBA',(64,64),(255,42,42,210))
        with tempfile.TemporaryDirectory() as folder:
            indices,size=radar.make_tiles(image,[[55,20],[60,30]],pathlib.Path(folder))
            self.assertGreater(size,0)
            self.assertEqual(set(indices),set(map(str,range(3,8))))
            for path in pathlib.Path(folder).rglob('*.png'):
                pixels=np.array(Image.open(path).convert('RGBA'))
                solid=pixels[pixels[:,:,3]>0]
                self.assertTrue(np.all(solid==[255,42,42,210]))
                self.assertEqual(pixels.shape,(256,256,4))

    def test_dry_images_publish_empty_indices_not_false_rain(self):
        with tempfile.TemporaryDirectory() as folder:
            indices,size=radar.make_tiles(Image.new('RGBA',(20,20)),[[55,20],[60,30]],pathlib.Path(folder))
            self.assertEqual(size,0);self.assertTrue(all(not rows for rows in indices.values()))

    def test_partial_failure_retains_last_success_per_station(self):
        rows=[dict(station='fi',time=10),dict(station='fi',time=20),dict(station='se',time=5)]
        self.assertEqual(radar.retained(rows,15),rows[1:])
        self.assertEqual(radar.retained(rows,100),rows[1:])

    def test_future_observations_are_excluded_and_rate_gain_preserved(self):
        xml=b'''<root><GridSeriesObservation><fileReference>https://opendata.fmi.fi/geotiff/scan</fileReference><timePosition>2026-10-08T12:00:00Z</timePosition><NamedValue><name>linearTransformationGain</name><value>0.02</value></NamedValue></GridSeriesObservation></root>'''
        with patch.object(radar,'download',return_value=xml):
            rows=radar.discover('fi',radar.stamp('2026-10-08T11:00Z'),radar.stamp('2026-10-08T12:01Z'))
            self.assertEqual(rows[0]['gain'],.02)
            self.assertEqual(radar.discover('fi',0,1),[])

    def test_publish_preserves_previous_archive_when_all_providers_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);tiles=root/'data/radar-tiles';tiles.mkdir(parents=True)
            frame=dict(source='fi',station='fi',time=1,source_url='official',path='data/radar-tiles/kept',bytes=0)
            (root/frame['path']).mkdir();out=root/'data/radar-tiles.json';out.write_text(json.dumps(dict(frames=[frame])))
            with patch.multiple(radar,ROOT=root,OUT=out,TILES=tiles),patch.object(radar,'discover',side_effect=OSError('provider offline')):
                radar.main()
            result=json.loads(out.read_text());self.assertEqual(result['frames'],[frame]);self.assertEqual(len(result['errors']),7)

    def test_estonian_colour_opacity_matches_native_map(self):
        self.assertEqual(radar.estonia_colours(np.array([.05,.2,60.,np.nan])).tolist(),[[156,221,255,155],[54,170,255,175],[90,0,145,245],[0,0,0,0]])

    def test_colour_palette_matches_high_rain_rates(self):
        pixels=radar.archive.colour_rate_field(np.array([50.,70.,np.nan]))
        self.assertEqual(pixels.tolist(),[[255,126,218,225],[255,235,247,235],[0,0,0,0]])

if __name__=='__main__':unittest.main()

class RadarArchives(unittest.TestCase):
    def test_archive_keeps_every_png_byte_and_empty_frames(self):
        import struct
        from radar_archive import pack_tiles
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);directory=root/'frame';directory.mkdir()
            indices,_=radar.make_tiles(Image.new('RGBA',(64,64),(255,42,42,210)),[[55,20],[60,30]],directory)
            target=root/'fi-1000-0123456789ab.bin'
            meta=pack_tiles(directory,target,indices);body=target.read_bytes()
            self.assertEqual(body[:8],b'NWRAD001')
            length=struct.unpack('<I',body[8:12])[0];index=json.loads(body[12:12+length]);start=12+length
            self.assertEqual(meta['bytes'],len(body));self.assertEqual(meta['index_bytes'],start)
            for key,(offset,size) in index['tiles'].items():
                self.assertEqual(body[start+offset:start+offset+size],(directory/(key+'.png')).read_bytes())
            meta=pack_tiles(directory,target,{str(z):[] for z in range(3,8)})
            self.assertEqual(meta['bytes'],meta['index_bytes'])

    def test_conversion_is_incremental_and_retains_archives_on_provider_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);tiles=root/'data/radar-tiles';directory=tiles/'fi-1-0123456789ab';directory.mkdir(parents=True)
            indices,size=radar.make_tiles(Image.new('RGBA',(64,64),(255,42,42,210)),[[55,20],[60,30]],directory)
            frame=dict(source='fi',station='fi',time=1,source_url='official',path='data/radar-tiles/'+directory.name,bytes=size,tiles=indices)
            out=root/'data/radar-tiles.json';out.write_text(json.dumps(dict(frames=[frame])))
            with patch.multiple(radar,ROOT=root,OUT=out,TILES=tiles),patch.object(radar,'discover',side_effect=OSError('provider offline')):
                radar.main();record=json.loads(out.read_text())['frames'][0];body=(root/record['archive']['path']).read_bytes()
                self.assertFalse(directory.exists());radar.main()
                self.assertEqual((root/record['archive']['path']).read_bytes(),body)
                self.assertEqual(json.loads(out.read_text())['frames'][0],record)
