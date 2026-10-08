import importlib.util
from pathlib import Path
import tempfile
import sys
import hashlib
import json
from io import BytesIO
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

spec = importlib.util.spec_from_file_location('r2', Path(__file__).resolve().parents[1] / 'scripts/sync_r2_data.py')
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)


class FakeStore:
    def __init__(self, initial=None, fail=None):
        self.objects, self.puts, self.deletes = initial or {}, [], []
        self.fail = fail
    def get_paginator(self, _): return self
    def paginate(self, **_):
        return [{'Contents': [{'Key': key, 'Size': len(value['Body']),
            'ETag': value['ETag'], 'LastModified': value['LastModified']}
            for key, value in self.objects.items()]}]
    def head_object(self, Bucket, Key):
        value = self.objects[Key]
        return {'ContentLength': len(value['Body']), 'ETag': value['ETag'], 'Metadata': value['Metadata']}
    def put_object(self, Bucket, Key, Body, **kwargs):
        self.puts.append(Key)
        if Key == self.fail: raise RuntimeError('simulated provider failure')
        body = Body.read() if hasattr(Body, 'read') else Body
        etag = '"' + hashlib.md5(body, usedforsecurity=False).hexdigest() + '"'
        self.objects[Key] = {'Body': body, 'ETag': etag,
            'Metadata': kwargs.get('Metadata', {}), 'LastModified': datetime.now(timezone.utc)}
        return {'ETag': etag}
    def delete_objects(self, Bucket, Delete):
        for item in Delete['Objects']:
            self.deletes.append(item['Key'])
            self.objects.pop(item['Key'], None)
        return {}


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

    def test_asset_failure_withholds_manifests_and_preserves_all_live_assets(self):
        now = datetime.now(timezone.utc)
        last = 'weather/data/radar-tiles/last.png'
        other = 'weather/data/snow-history/last.json'
        store = FakeStore({key: {'Body': b'old', 'ETag': 'old', 'Metadata': {},
            'LastModified': now - timedelta(days=30)} for key in [last, other]},
            fail='weather/data/radar-tiles/new.png')
        registry = {'files': {key: {'protected': True} for key in [last, other]}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/radar-tiles').mkdir(parents=True)
            (root / 'data/radar-tiles/new.png').write_bytes(b'new')
            (root / 'data/radar-tiles.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                r2.sync(store, 'b', root=root, selected=['data/radar-tiles', 'data/radar-tiles.json'], registry=registry)
            self.assertEqual(store.deletes, [])
            self.assertNotIn('weather/data/radar-tiles.json', store.puts)

    def test_intent_protects_assets_if_manifest_publication_fails(self):
        store = FakeStore(fail='weather/data/radar-tiles.json')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/radar-tiles').mkdir(parents=True)
            (root / 'data/radar-tiles/new.png').write_bytes(b'new')
            (root / 'data/radar-tiles.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                r2.sync(store, 'b', root=root)
            intent = json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertIn('weather/data/radar-tiles/new.png', intent['pending'])
            self.assertLess(store.puts.index('weather/data/radar-tiles/new.png'), store.puts.index('weather/data/radar-tiles.json'))

    def test_retired_assets_expire_only_after_replacement_succeeds(self):
        now = datetime.now(timezone.utc)
        old = 'weather/data/radar-tiles/old.png'
        other = 'weather/data/snow-history/active.json'
        store = FakeStore({key: {'Body': b'old', 'ETag': 'old', 'Metadata': {},
            'LastModified': now - timedelta(days=30)} for key in [old, other]})
        registry = {'files': {key: {'protected': True} for key in [old, other]}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/radar-tiles').mkdir(parents=True)
            (root / 'data/radar-tiles/new.png').write_bytes(b'new')
            (root / 'data/radar-tiles.json').write_text('{}')
            r2.sync(store, 'b', root=root, selected=['data/radar-tiles', 'data/radar-tiles.json'], registry=registry)
            self.assertEqual(store.deletes, [])
            next_registry = json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertFalse(next_registry['files'][old]['protected'])
            self.assertTrue(next_registry['files'][other]['protected'])
            r2.sync(store, 'b', root=root, registry=next_registry, cleanup_only=True)
            self.assertEqual(store.deletes, [old])
            self.assertIn(other, store.objects)

    def test_old_snapshot_cannot_replace_newer_r2_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data/latest.json').write_text('{"generatedAt":"2026-10-08T00:00:00Z"}')
            registry = {'files': {'weather/data/latest.json': {'generation': 9999999999}}}
            result = r2.sync(None, 'b', root=root, registry=registry)
            self.assertEqual(result['status'], 'retained-newer-snapshot')

    def test_cleanup_without_registry_cannot_delete_anything(self):
        with self.assertRaisesRegex(RuntimeError, 'publication registry'):
            r2.sync(None, 'b', cleanup_only=True)

    def test_reserve_includes_full_replacement_bytes(self):
        self.assertEqual(r2.plan_peak(100, [('replacement', 60, 'hash')]), 160)


if __name__ == '__main__':
    unittest.main()
