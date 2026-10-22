import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('split_temperature', pathlib.Path(__file__).parents[1] / 'scripts/split_official_temperature.py')
splitter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(splitter)


class TemperatureSplitTest(unittest.TestCase):
    def test_split_keeps_playback_and_full_archive_then_restores_for_next_collection(self):
        now = 100000
        rows = [[now - age, age / 10000] for age in (86400, 36000, 18000, 7200, 0)]
        snapshot = dict(version=1, generatedAt=now, historyHours=24,
                        stations=[dict(country='NO', code='1', name='Station', rows=rows)])
        with tempfile.TemporaryDirectory() as directory:
            latest = pathlib.Path(directory) / 'latest.json'
            history = pathlib.Path(directory) / 'history.json'
            latest.write_text(json.dumps(snapshot))
            with patch.object(splitter, 'LATEST', latest), patch.object(splitter, 'HISTORY', history):
                splitter.restore()  # First deployment needs no archive.
                splitter.split()
                operational = json.loads(latest.read_text())
                self.assertEqual(operational['stations'][0]['rows'], rows[-3:])
                self.assertEqual(json.loads(history.read_text()), snapshot)
                self.assertEqual(operational['historyHours'], 6)
                # A newer live snapshot must survive even if history upload lagged.
                operational['stations'][0]['rows'].append([now + 600, 12])
                latest.write_text(json.dumps(operational))
                splitter.restore()
                restored = json.loads(latest.read_text())
                self.assertEqual(restored['stations'][0]['rows'], rows + [[now + 600, 12]])
                self.assertNotIn('historyFile', restored)
                self.assertEqual(restored['historyHours'], 24)

    def test_french_three_hourly_reports_remain_available_for_two_hour_playback(self):
        now=100000
        rows=[[now-22000,8],[now-20000,9],[now-10000,10]]
        with tempfile.TemporaryDirectory() as directory:
            latest=pathlib.Path(directory)/'latest.json';history=pathlib.Path(directory)/'history.json'
            latest.write_text(json.dumps(dict(version=1,generatedAt=now,stations=[dict(country=c,code=c,rows=rows) for c in ('FR','LV','NO')])))
            with patch.object(splitter,'LATEST',latest),patch.object(splitter,'HISTORY',history):splitter.split()
            self.assertEqual([len(s['rows']) for s in json.loads(latest.read_text())['stations']],[2,2,1])

    def test_invalid_snapshot_never_replaces_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            latest, history = (pathlib.Path(directory) / name for name in ('latest.json', 'history.json'))
            latest.write_text('{"version":2,"stations":[]}')
            history.write_text('original archive')
            with patch.object(splitter, 'LATEST', latest), patch.object(splitter, 'HISTORY', history):
                with self.assertRaises(ValueError):
                    splitter.split()
            self.assertEqual(history.read_text(), 'original archive')
