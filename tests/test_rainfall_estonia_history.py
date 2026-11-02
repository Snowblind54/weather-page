import copy
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import rainfall_estonia_history as history

NOW=dt.datetime(2026,11,2,16,tzinfo=dt.timezone.utc)
END=int(NOW.timestamp())


class EstoniaHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.state=Path(self.tmp.name)/'state.json'
        self.station={'country':'EE','code':'26038','name':'Tallinn-Harku','lat':59.398,'lon':24.603,'times':[END],'amounts':[7.],'traces':[]}
        self.manifest={'dataset':'station_xml','source':'ilmateenistus observations XML',
            'variables':[{'key':'precip','unit':'mm','label':'Precipitation (last hour)'}],
            'stations':[{'id':'tallinn-harku','name':'Tallinn-Harku','lat':59.398,'lon':24.603,'fields':['precip']}],
            'periods':[{'key':'2026-11','start':'2026-11-01','end':'2026-11-30','stations':['tallinn-harku']}]}
        self.series={'precip':[[dt.datetime.fromtimestamp(END-i*3600,dt.timezone.utc).isoformat(),1.] for i in range(60)]}
        self.calls=[]
    def reader(self,path):
        self.calls.append(path)
        return copy.deepcopy(self.manifest if path=='manifest.json.gz' else self.series)
    def recover(self,previous=None):
        return history.recover(NOW,[self.station],previous or [],reader=self.reader,state_path=self.state)
    def test_archive_fills_real_hours_without_replacing_live_or_existing_readings(self):
        previous={**self.station,'times':[END-3600],'amounts':[3.]}
        result=self.recover([previous])[0]
        values=dict(zip(result['times'],result['amounts']))
        self.assertNotIn(END,values);self.assertNotIn(END-3600,values)
        values.update(zip(previous['times'],previous['amounts']));values[END]=7.
        self.assertEqual(sum(values[END-i*3600] for i in range(24)),32.)
        self.assertEqual(sum(values[END-i*3600] for i in range(48)),56.)
    def test_rejects_invalid_future_and_non_hourly_measurements_without_zero_filling(self):
        self.series={'precip':[['bad',1.],[None,1.],['2026-11-02T15:00:00',1.],
            ['2026-11-02T15:30:00+00:00',1.],['2026-11-02T17:00:00+00:00',1.],
            ['2026-11-02T15:00:00+00:00',None],['2026-11-02T15:00:00+00:00',-1.],
            ['2026-11-02T15:00:00+00:00',True],['2026-11-02T14:00:00+00:00',0.]]}
        result=self.recover()[0]
        self.assertEqual(result['times'],[END-7200]);self.assertEqual(result['amounts'],[0.])
    def test_complete_current_history_needs_no_archive_request_but_stale_history_does(self):
        self.station.update(times=[END-i*3600 for i in range(48)],amounts=[0.]*48)
        self.assertEqual(self.recover(),[]);self.assertEqual(self.calls,[])
        self.station['times']=[t-86400 for t in self.station['times']]
        self.assertTrue(self.recover());self.assertIn('manifest.json.gz',self.calls)
    def test_wrong_source_or_units_rejected(self):
        self.manifest['variables'][0]['unit']='cm'
        with self.assertRaises(ValueError):self.recover()
        self.manifest['variables'][0]['unit']='mm';self.manifest['source']='estimated'
        with self.assertRaises(ValueError):self.recover()
    def test_coordinate_mismatch_cannot_attach_different_gauge(self):
        self.manifest['stations'][0]['lat']=58.
        self.assertEqual(self.recover(),[])
        self.assertEqual(self.calls,['manifest.json.gz'])
    def test_cooldown_avoids_repeated_archive_reads_for_incomplete_station(self):
        self.series={'precip':[]}
        self.assertEqual(self.recover(),[])
        self.calls.clear();self.assertEqual(self.recover(),[]);self.assertEqual(self.calls,[])
