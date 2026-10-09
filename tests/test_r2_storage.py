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
        self.scans = 0
    def get_paginator(self, _): return self
    def paginate(self, **_):
        self.scans += 1
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


def accounted(store, files=None, total=None, now=None):
    return {'version': 1, 'files': files or {}, 'accounting': {'version': 1,
        'bucket_bytes': sum(len(v['Body']) for v in store.objects.values()) if total is None else total,
        'audited_at': (now or datetime.now(timezone.utc)).timestamp()}}


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
                r2.sync(Client(), 'bucket', root=root, registry=accounted(FakeStore(), total=r2.BUDGET))

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
        registry = accounted(store, {key: {'protected': True, 'size': 3} for key in [last, other]})
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
                r2.sync(store, 'b', root=root, registry=accounted(store))
            intent = json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertIn('weather/data/radar-tiles/new.png', intent['pending'])
            self.assertLess(store.puts.index('weather/data/radar-tiles/new.png'), store.puts.index('weather/data/radar-tiles.json'))

    def test_retired_assets_expire_only_after_replacement_succeeds(self):
        now = datetime.now(timezone.utc)
        old = 'weather/data/radar-tiles/old.png'
        other = 'weather/data/snow-history/active.json'
        store = FakeStore({key: {'Body': b'old', 'ETag': 'old', 'Metadata': {},
            'LastModified': now - timedelta(days=30)} for key in [old, other]})
        registry = accounted(store, {key: {'protected': True, 'size': 3} for key in [old, other]})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/radar-tiles').mkdir(parents=True)
            (root / 'data/radar-tiles/new.png').write_bytes(b'new')
            (root / 'data/radar-tiles.json').write_text('{}')
            r2.sync(store, 'b', root=root, selected=['data/radar-tiles', 'data/radar-tiles.json'], registry=registry)
            self.assertEqual(store.deletes, [])
            next_registry = json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertNotIn(old, next_registry['files'])
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

    def test_publish_never_lists_or_deletes_and_unchanged_files_skip_puts(self):
        store = FakeStore()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'data').mkdir()
            (root / 'data/latest.json').write_text('{}')
            report = r2.sync(store, 'b', root=root, registry=accounted(store))
            self.assertEqual(report['inventoryScans'], 0)
            self.assertEqual(store.scans, 0)
            registry = json.loads(store.objects['_weather/control/registry.json']['Body'])
            report = r2.sync(store, 'b', root=root, registry=registry)
            self.assertEqual(report['uploadedFiles'], 0)
            self.assertEqual(store.puts.count('weather/data/latest.json'), 1)
            self.assertEqual(store.deletes, [])

    def test_cleanup_scans_once_counts_foreign_data_and_initializes_legacy_registry(self):
        now = datetime.now(timezone.utc)
        live, old = 'weather/data/live.json', 'weather/data/radar-tiles/old.png'
        store = FakeStore({k: {'Body': b'abc', 'ETag': 'old', 'Metadata': {},
            'LastModified': now-timedelta(days=30)} for k in [live, old, 'foreign']})
        with tempfile.TemporaryDirectory() as tmp:
            report = r2.sync(store, 'b', root=Path(tmp), now=now, cleanup_only=True,
                registry={'files': {live: {'protected': True, 'etag': 'old'}}})
            self.assertEqual(store.scans, 1)
            self.assertEqual(store.deletes, [old])
            self.assertEqual(report['bucketBytes'], 6)
            registry = json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertEqual(registry['accounting']['bucket_bytes'], 6)

    def test_missing_or_stale_audit_refuses_publication_without_scanning(self):
        store = FakeStore()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'data').mkdir(); (root / 'data/latest.json').write_text('{}')
            for registry in [{'files': {}}, accounted(store, now=datetime.now(timezone.utc)-timedelta(hours=3))]:
                with self.assertRaisesRegex(RuntimeError, 'central R2 storage audit'):
                    r2.sync(store, 'b', root=root, registry=registry)
            self.assertEqual(store.scans, 0); self.assertEqual(store.puts, [])

    def test_failed_asset_upload_reserves_budget_before_put_and_keeps_other_pending(self):
        new = 'weather/data/radar-tiles/new.png'
        store = FakeStore(fail=new)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root / 'data/radar-tiles').mkdir(parents=True)
            (root / 'data/radar-tiles/new.png').write_bytes(b'new')
            registry = accounted(store, total=r2.BUDGET-r2.INDEX_RESERVE-4)
            registry['pending'] = ['weather/data/cloud-tiles/previous.webp']
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                r2.sync(store, 'b', root=root, selected=['data/radar-tiles'], registry=registry)
            intent=json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertEqual(intent['accounting']['bucket_bytes'], registry['accounting']['bucket_bytes']+3)
            self.assertIn(new, intent['pending'])
            self.assertIn('weather/data/cloud-tiles/previous.webp', intent['pending'])
            self.assertEqual(store.puts[0], '_weather/control/registry.json')
            store.fail=None
            with self.assertRaisesRegex(RuntimeError, '8 GB storage guard'):
                r2.sync(store, 'b', root=root, selected=['data/radar-tiles'], registry=intent)
            self.assertEqual(store.scans, 0)

    def test_successful_replacement_subtracts_only_known_previous_bytes(self):
        key='weather/data/latest.json'
        store=FakeStore({key: {'Body': b'old', 'ETag': 'old', 'Metadata': {},
            'LastModified': datetime.now(timezone.utc)}})
        registry=accounted(store, {key: {'size':3, 'etag':'old', 'protected':True}})
        registry['pending']=['weather/data/cloud-tiles/pending.webp']
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root / 'data').mkdir(); (root / 'data/latest.json').write_text('{}')
            r2.sync(store, 'b', root=root, selected=['data/latest.json'], registry=registry)
            final=json.loads(store.objects['_weather/control/registry.json']['Body'])
            self.assertEqual(final['accounting']['bucket_bytes'], 2)
            self.assertEqual(final['accounting']['audited_at'], registry['accounting']['audited_at'])
            self.assertEqual(final['pending'], registry['pending'])

    def test_pending_asset_not_uploaded_yet_does_not_block_restoring_existing_live_inputs(self):
        from hydrate_r2_data import hydrate
        class Missing(Exception):
            response={'Error': {'Code': '404'}}
        class Store(FakeStore):
            def head_object(self, **args): raise Missing()
            def get_object(self, Bucket, Key, **kwargs):
                body=self.objects[Key]['Body']
                class Body:
                    def iter_chunks(self, **_): yield body
                    def close(self): pass
                return {'Body': Body(), 'ContentLength':len(body)}
        key='weather/data/latest.json'; data=b'{}'
        registry={'files': {key: {'protected':True, 'size':2, 'etag':'old',
            'sha256':hashlib.sha256(data).hexdigest()}}, 'pending':['weather/data/not-uploaded.json']}
        store=Store({'_weather/control/registry.json': {'Body':json.dumps(registry).encode(), 'ETag':'registry'},
            key: {'Body':data, 'ETag':'old'}})
        original=store.get_object
        def get(**args):
            if args['Key']=='_weather/control/registry.json':
                return {'Body':BytesIO(store.objects[args['Key']]['Body']), 'ETag':'registry'}
            return original(**args)
        store.get_object=get
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); hydrate(store, 'b', ['data'], root=root)
            self.assertEqual((root/'data/latest.json').read_bytes(), data)
            self.assertFalse((root/'data/not-uploaded.json').exists())


if __name__ == '__main__':
    unittest.main()
