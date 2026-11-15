import datetime as dt
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from sync_r2_data import generation


class WarningGeneration(unittest.TestCase):
    def test_warning_times_order_publication_and_preserve_quiet_snapshots(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)/'data'
            data.mkdir()
            for name in ('national-warnings.json', 'latvia-warnings.json', 'estonia-warnings.json'):
                path = data/name
                previous = []
                for value in ('2026-11-15T03:12:10+00:00', '2026-11-15T09:00:00Z'):
                    path.write_text(json.dumps({'version':1,'updatedAt':value,'records':[]}))
                    previous.append(generation(path))
                self.assertEqual(previous[1]-previous[0], 20870)
            path = data/'unrelated.json'
            path.write_text('{"updatedAt":"2026-11-15T09:00:00Z"}')
            self.assertIsNone(generation(path))
            path.write_text('{"generatedAt":1234}')
            self.assertEqual(generation(path), 1234)
