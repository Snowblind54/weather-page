import base64, datetime as dt, gzip, importlib.util, io, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image
spec=importlib.util.spec_from_file_location('history',Path(__file__).parents[1]/'scripts/update_snow_history.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

class SnowHistoryTests(unittest.TestCase):
    def test_ascii_orientation_and_invalid_grid(self):
        grid=h.read_grid(gzip.compress(b'header\n12\n34\n'),2)
        self.assertEqual(grid.tolist(),[[3,4],[1,2]])
        with self.assertRaises(ValueError):h.read_grid(gzip.compress(b'12\n3x\n'),2)

    def test_projection_known_locations_and_northern_bounds(self):
        row,col,valid=h.pixel_indices(0)
        self.assertTrue(valid[:128].any());self.assertFalse(valid[128:].any())
        # Greenland at 70N/40W lies northeast of the projection origin.
        x,y=h.Transformer.from_crs('EPSG:4326',h.PROJECTION,always_xy=True).transform(-40,70)
        self.assertGreater(x,0);self.assertLess(y,0)
        self.assertAlmostEqual((h.EDGE-0)/h.CELL,3072)

    def test_tiles_keep_categories_and_missing_values_transparent(self):
        grid=np.array([[0,3],[4,2]],dtype=np.uint8)
        row=np.zeros((256,256),dtype=np.int32);col=row.copy();valid=np.ones_like(row,dtype=bool)
        row[128:]=1;col[:,128:]=1
        tiles=h.encode_tiles(grid,[(row,col,valid)])
        image=Image.open(io.BytesIO(base64.b64decode(tiles['0/0/0']))).convert('RGBA')
        self.assertEqual(image.getpixel((0,0))[3],0)
        self.assertEqual(image.getpixel((255,0)),(77,205,245,255))
        self.assertEqual(image.getpixel((0,255)),(245,250,255,255))
        self.assertEqual(image.getpixel((255,255))[3],0)

    def test_window_crosses_year_and_leap_day(self):
        days=h.window(dt.date(2026,1,3));self.assertEqual(len(days),14)
        self.assertEqual(days[0],dt.date(2025,12,21))
        self.assertIn(dt.date(2024,2,29),h.window(dt.date(2024,3,1)))

    def test_outage_keeps_cached_dates_and_omits_missing_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);target=directory/'snow-history';target.mkdir()
            day=dt.date(2026,10,4);cached=day-dt.timedelta(days=1)
            name=f'{cached}-abc.json.gz';(target/name).write_bytes(b'existing')
            frame={'date':cached.isoformat(),'url':'data/snow-history/'+name,'bytes':8}
            (directory/'snow-history.json').write_text(json.dumps({'frames':[frame]}))
            with patch.object(h,'download',side_effect=OSError('offline')):h.update(day,directory)
            data=json.loads((directory/'snow-history.json').read_text())
            self.assertEqual(data['frames'],[frame]);self.assertIn(day.isoformat(),data['missingDates'])
            self.assertTrue((target/name).exists())

    def test_complete_failure_preserves_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);manifest=directory/'snow-history.json';manifest.write_text('{"frames":[]}')
            with patch.object(h,'download',side_effect=OSError('offline')):
                with self.assertRaises(RuntimeError):h.update(dt.date(2026,10,4),directory)
            self.assertEqual(manifest.read_text(),'{"frames":[]}')

if __name__=='__main__':unittest.main()
