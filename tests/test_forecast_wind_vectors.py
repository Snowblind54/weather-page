import json
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import forecast_wind_vectors as wind


class WindDirectionTests(unittest.TestCase):
    def grid(self,u,v):
        return {'lat':np.array([40.,60.]),'lon':np.array([-10.,10.]),
                '10u':np.full((2,2),u),'10v':np.full((2,2),v)}

    def generate(self,a,b=None,fraction=0):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'directions.json'
            wind.write_ecmwf(a,b or a,fraction,[-10,40,10,60],'2026-11-02T13:00:00.000Z',path)
            return json.loads(path.read_text())

    def test_cardinal_from_bearings_and_calm_mask(self):
        for u,v,expected in [(4,0,270),(-4,0,90),(0,4,180),(0,-4,0),(.1,.1,None)]:
            self.assertEqual(set(self.generate(self.grid(u,v))['values']),{expected})

    def test_interpolate_components_before_direction_and_handle_cancellation(self):
        result=self.generate(self.grid(4,0),self.grid(0,4),.5)
        self.assertEqual(set(result['values']),{225})
        self.assertEqual(set(self.generate(self.grid(4,0),self.grid(-4,0),.5)['values']),{None})

    def test_nordic_direction_request_uses_matching_instant_and_mercator(self):
        from urllib.parse import urlparse,parse_qs
        m={'endpoint':'https://example.org/wms','bounds':[-11,52,42,74]}
        valid='2026-11-02T13:00:00.000Z'
        p=parse_qs(urlparse(wind.nordic_url(m,valid)).query)
        self.assertEqual(p['time'],[valid])
        self.assertEqual(p['layers'],['wind_direction_10m'])
        self.assertEqual(p['srs'],['EPSG:3857'])
        self.assertEqual(p['colorscalerange'],['0,360'])

    def test_descriptors_are_small_immutable_hourly_assets(self):
        t='2026-11-02T13:00:00.000Z'
        d=wind.descriptor('forecast-cache','20261102T06Z-precipitation-v2',[t])
        self.assertEqual(d['frames'][t],'data/forecast-cache/20261102T06Z-precipitation-v2/wind-vectors-20261102T13Z.json')
