import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import rainfall_portugal as pt
import update_rainfall as rain
from rainfall_europe import complete_total

NOW = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
END = int(NOW.timestamp())


def metadata(code, lat, lon):
    return {'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {'idEstacao': code, 'localEstacao': 'Test gauge'}}


def hour(i):
    return (NOW - dt.timedelta(hours=i)).strftime('%Y-%m-%dT%H:%M')


class PortugalRainTests(unittest.TestCase):
    def test_hourly_values_and_exact_windows_exclude_sentinels_and_future_hours(self):
        rows = {hour(i): {'1': {'precAcumulada': 1}, '2': {'precAcumulada': 0},
                          '3': {'precAcumulada': -99 if i == 5 else 1},
                          '4': {'precAcumulada': 9}} for i in range(-1, 24)}
        stations = pt.parse_ipma(rows, [metadata(1,39,-8), metadata(2,32.6,-16.8),
                                        metadata(3,38,-28), metadata(4,34,-7)], NOW)
        self.assertEqual(len(stations),3)
        totals = [complete_total(dict(zip(s['times'],s['amounts'])),[],END,24) for s in stations]
        self.assertEqual(totals,[24,0,None])
        self.assertTrue(all(s['times'][-1] == END for s in stations))
        self.assertTrue(all(s['sourceName'] == pt.IPMA_NAME for s in stations))

    def test_48_hours_are_retained_across_collections_for_same_gauge_only(self):
        meta=[metadata(1,41,-8),metadata(2,32.7,-16.8)]
        current=pt.parse_ipma({hour(i):{'1':{'precAcumulada':.5},'2':{'precAcumulada':.5}} for i in range(24)},meta,NOW)
        previous=pt.parse_ipma({hour(i):{'1':{'precAcumulada':.5}} for i in range(24,48)},meta,NOW-dt.timedelta(hours=24))
        merged=rain.merge(previous,current,NOW)
        self.assertEqual([complete_total(dict(zip(s['times'],s['amounts'])),[],END,48) for s in merged],[24,None])

    def test_synop_48_hour_total_requires_adjacent_native_reports(self):
        gauge=rain.station('PT','SYNOP-08521','Madeira Airport',32.68,-16.77,[])
        gauge['periods']=[{'end':END-24*3600,'hours':24,'value':8.4},{'end':END,'hours':24,'value':1.1}]
        result=rain.merge([], [gauge], NOW)[0]
        self.assertIn({'end':END,'hours':48,'value':9.5},result['accumulations'])
        self.assertEqual(result['times'],[])
        gauge['periods'][0]['end']+=3600
        self.assertFalse(any(x['hours']==48 for x in rain.merge([], [gauge], NOW)[0]['accumulations']))
