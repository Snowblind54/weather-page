import importlib.util
from pathlib import Path
import tempfile
import sys
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

spec = importlib.util.spec_from_file_location('r2', Path(__file__).resolve().parents[1] / 'scripts/sync_r2_data.py')
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)


class StorageSafety(unittest.TestCase):
    def test_expiry_keeps_active_last_good_and_foreign_objects(self):
        now = datetime.now(timezone.utc)
        old = {'Size': 10, 'LastModified': now - timedelta(days=30)}
        objects = {'weather/data/radar-tiles/old.png': old,
                   'weather/data/radar-tiles/last-good.png': old,
                   'personal-file.txt': old,
                   'weather/data/snow-history/recent.json': {'Size': 10, 'LastModified': now - timedelta(days=14)}}
        self.assertEqual(r2.expired_keys(objects, {'weather/data/radar-tiles/last-good.png'}, now),
                         ['weather/data/radar-tiles/old.png'])

    def test_over_budget_does_not_upload_any_files(self):
        class Client:
            def get_paginator(self, _): return self
            def paginate(self, **_):
                return [{'Contents': [{'Key': 'foreign', 'Size': r2.BUDGET, 'LastModified': datetime.now(timezone.utc)}]}]
            def put_object(self, **_): raise AssertionError('Upload must be refused')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data/latest.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, '8 GB storage guard'):
                r2.sync(Client(), 'bucket', root=root)

    def test_empty_source_cannot_delete_remote_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, 'No source data'):
                r2.sync(None, 'bucket', root=Path(tmp))

    def test_reserve_includes_full_replacement_bytes(self):
        self.assertEqual(r2.plan_peak(100, [('replacement', 60, 'hash')]), 160)


if __name__ == '__main__':
    unittest.main()
