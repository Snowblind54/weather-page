"""Exercise real branch publications and verified outage restores without R2."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import github_fallback as fallback
import hydrate_r2_data


class GitHubFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'inputs'; self.root.mkdir()
        self.remote = Path(self.tmp.name)/'backup.git'
        subprocess.run(['git','init','--bare','-q',str(self.remote)],check=True)
        self.enterContext(patch.object(fallback,'GIT_URL',str(self.remote)))
        self.enterContext(patch.dict(os.environ,{'GITHUB_TOKEN':'local-test-only'}))

    def put(self, path, value):
        target=self.root/path; target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(value if isinstance(value,bytes) else json.dumps(value).encode())

    def show(self,path):
        return subprocess.check_output(['git','--git-dir',str(self.remote),'show',fallback.BRANCH+':'+path])

    def test_scoped_updates_preserve_other_jobs_and_replace_history(self):
        self.put('data/model-wind.json',{'generatedAt':100,'wind':'initial'})
        self.put('data/forecast-cache/retired.webp',b'old')
        fallback.publish(['data/model-wind.json','data/forecast-cache'],root=self.root,active=False)
        self.put('data/official-temperature.json',{'generatedAt':101,'stations':[1]})
        fallback.publish(['data/official-temperature.json'],root=self.root)
        (self.root/'data/forecast-cache/retired.webp').unlink()
        self.put('data/forecast-cache/current.webp',b'new')
        fallback.publish(['data/forecast-cache'],root=self.root,active=False)
        index=json.loads(self.show('_fallback/index.json'))['files']
        self.assertIn('data/model-wind.json',index)
        self.assertIn('data/official-temperature.json',index)
        self.assertNotIn('data/forecast-cache/retired.webp',index)
        self.assertEqual(self.show('data/forecast-cache/current.webp'),b'new')
        self.assertEqual(json.loads(self.show('_fallback/status.json'))['mode'],'active')
        count=subprocess.check_output(['git','--git-dir',str(self.remote),'rev-list','--count',fallback.BRANCH])
        self.assertEqual(count.strip(),b'1')

    def test_concurrent_publisher_is_merged_after_rejected_lease(self):
        self.put('data/model-wind.json',{'generatedAt':200})
        self.put('data/official-temperature.json',{'generatedAt':201})
        run=subprocess.run
        intervened=False
        def concurrent(args,**kwargs):
            nonlocal intervened
            if args[:2]==['git','push'] and not intervened:
                intervened=True
                fallback.publish(['data/official-temperature.json'],root=self.root)
            return run(args,**kwargs)
        with patch.object(fallback.subprocess,'run',side_effect=concurrent),patch.object(fallback.time,'sleep'):
            fallback.publish(['data/model-wind.json'],root=self.root)
        records=json.loads(self.show('_fallback/index.json'))['files']
        self.assertEqual(set(records),{'data/model-wind.json','data/official-temperature.json'})

    def test_older_failed_or_oversized_publications_keep_successful_snapshot(self):
        self.put('data/model-wind.json',{'generatedAt':200})
        fallback.publish(['data/model-wind.json'],root=self.root)
        self.put('data/model-wind.json',{'generatedAt':100})
        fallback.publish(['data/model-wind.json'],root=self.root)
        self.assertEqual(json.loads(self.show('data/model-wind.json'))['generatedAt'],200)
        self.put('data/model-wind.json',{'generatedAt':300})
        with patch.object(fallback,'MAX_BYTES',1),self.assertRaises(RuntimeError):
            fallback.publish(['data/model-wind.json'],root=self.root)
        self.assertEqual(json.loads(self.show('data/model-wind.json'))['generatedAt'],200)
        with self.assertRaises(RuntimeError):fallback.publish(['data/missing.json'],root=self.root)

    def test_excludes_acceleration_tiles_and_static_geometry(self):
        for path in ['data/radar-tiles.json','data/radar-tiles/f/1.png',
                     'data/cloud-tiles.json','data/cloud-tiles/f/1.png',
                     'data/estonia-marine-warning-zones.geojson']:
            self.put(path,b'{}')
        self.put('data/radar-cache/iceland/frame.png',b'raw radar')
        files=fallback.local_files(self.root,['data'])
        self.assertEqual(list(files),['data/radar-cache/iceland/frame.png'])
        with patch.dict(os.environ,{'GITHUB_TOKEN':''}):
            fallback.publish(['data/cloud-tiles.json','data/cloud-tiles'],root=self.root)
        with self.assertRaises(ValueError):fallback.publish(['../secrets'],root=self.root)

    def test_verified_restore_is_atomic_on_corrupt_download(self):
        data=b'new wind'; path='data/model-wind.json'
        self.put(path,b'previous usable wind')
        record={'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        index=json.dumps({'version':1,'files':{path:record}}).encode()
        with patch.object(fallback,'download',side_effect=lambda p:index if p=='_fallback/index.json' else b'corrupt'):
            with self.assertRaises(RuntimeError):fallback.restore([path],root=self.root)
        self.assertEqual((self.root/path).read_bytes(),b'previous usable wind')
        with patch.object(fallback,'download',side_effect=lambda p:index if p=='_fallback/index.json' else data):
            fallback.restore([path],root=self.root)
        self.assertEqual((self.root/path).read_bytes(),data)

    def test_pause_skips_r2_and_restores_from_github(self):
        with patch.dict(os.environ,{'R2_PAUSED':'true'}),patch.object(hydrate_r2_data,'connect') as connect,patch.object(fallback,'restore') as restore:
            hydrate_r2_data.restore_inputs(['data/model-wind.json'])
        connect.assert_not_called()
        restore.assert_called_once_with(['data/model-wind.json'],allow_empty=False)

    def test_network_failure_restores_from_github(self):
        with patch.object(hydrate_r2_data,'connect',side_effect=RuntimeError('outage')),patch.object(fallback,'restore') as restore:
            hydrate_r2_data.restore_inputs(['data/model-wind.json'])
        restore.assert_called_once()


if __name__=='__main__':unittest.main()
