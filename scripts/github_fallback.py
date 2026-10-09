"""One current, independent GitHub snapshot for weather delivery during R2 outages."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request
import base64
from sync_r2_data import ROOT, scopes, generation

REPO = 'Snowblind54/weather-page'
BRANCH = 'weather-fallback'
GIT_URL = f'https://github.com/{REPO}.git'
RAW = f'https://raw.githubusercontent.com/{REPO}/{BRANCH}/'
BACKUP_SCOPES = ['data/'+name for name in (
    'official-temperature.json', 'temperature-americas-model.json', 'temperature-europe-model.json', 'official-wind.json',
    'model-wind.json', 'official-rainfall.json', 'official-snow-depth.json',
    'iceland-snow-stations.json', 'snow-history.json', 'snow-history',
    'forecast-map.json', 'forecast-cache', 'forecast-iceland.json', 'forecast-iceland-cache',
    'estonia-warnings.json', 'latvia-warnings.json', 'national-warnings.json',
    'cyclones.json', 'fronts.json', 'cyclone-ensemble.json', 'space-weather.json',
    'aurora-cloud.json', 'nordic-radar-cache.json', 'radar-cache',
    'radar-tiles.json', 'radar-tiles', 'cloud-tiles.json', 'cloud-tiles')]
MAX_BYTES = 1024 * 1024 * 1024


def eligible(path):
    p = Path(path)
    return (p.parts and p.parts[0] == 'data' and '..' not in p.parts
            and path != 'data/estonia-marine-warning-zones.geojson')


def owned(path, selected):
    return any(path == value or path.startswith(value+'/') for value in selected)


def local_files(root, selected):
    found = {}
    for value in scopes(selected):
        source = root/value
        for path in [source] if source.is_file() else source.rglob('*'):
            if path.is_file():
                if not path.resolve().is_relative_to((root/'data').resolve()):
                    raise ValueError('Fallback path escapes data/')
                relative = path.relative_to(root).as_posix()
                if eligible(relative):
                    size = path.stat().st_size
                    if size > 50*1024*1024:
                        raise RuntimeError('Fallback file exceeds GitHub delivery size limit')
                    found[relative] = {'size': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                       'generation': generation(path)}
    return found


def download(path):
    if path not in ['_fallback/index.json', '_fallback/status.json', '_fallback/budget.json'] and not eligible(path):
        raise ValueError('Unexpected fallback path')
    url = RAW+path+'?minute='+str(int(time.time()//60))
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(50*1024*1024+1)
    if len(data)>50*1024*1024:
        raise RuntimeError('Fallback response too large')
    return data


def restore(selected, root=ROOT, allow_empty=False):
    selected = scopes(selected)
    if not any(eligible(value) for value in selected):
        return
    index = json.loads(download('_fallback/index.json'))
    if index.get('version') != 1 or not isinstance(index.get('files'), dict):
        raise RuntimeError('Invalid GitHub fallback index')
    records = {p:r for p,r in index.get('files', {}).items() if eligible(p) and owned(p, selected)}
    if any(not isinstance(r, dict) or not isinstance(r.get('size'), int)
           or not 0 <= r['size'] <= 50*1024*1024
           or not isinstance(r.get('sha256'), str) or len(r['sha256']) != 64 for r in records.values()):
        raise RuntimeError('Invalid GitHub fallback file record')
    if sum(r['size'] for r in records.values()) > MAX_BYTES:
        raise RuntimeError('GitHub fallback restore exceeds size limit')
    if not records:
        if allow_empty: return
        raise RuntimeError('GitHub fallback scope has not been seeded')
    # Validate a complete restore before replacing any cached input.
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        def fetch(item):
            path, record = item
            local = root/path
            if local.is_file() and local.stat().st_size == record['size']:
                if hashlib.sha256(local.read_bytes()).hexdigest() == record['sha256']: return
            data = download(path)
            if len(data) != record['size'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise RuntimeError('Incomplete GitHub fallback input')
            target = stage/path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(fetch, records.items()))
        for path in stage.rglob('*'):
            if path.is_file():
                target = root/path.relative_to(stage); target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
        for value in selected:
            source = root/value
            for path in [source] if source.is_file() else source.rglob('*'):
                if path.is_file() and eligible(path.relative_to(root).as_posix()) and path.relative_to(root).as_posix() not in records:
                    path.unlink()
    print('Restored verified GitHub fallback inputs:', len(records), flush=True)


def publish(selected, root=ROOT, active=True, control=None):
    selected = scopes(selected) if control is None else []
    incoming = local_files(root, selected) if control is None else {}
    if not incoming and control is None:
        if all(not eligible(v) for v in selected):
            return
        raise RuntimeError('No fallback data; keeping previous GitHub snapshot')
    token = os.environ.get('GITHUB_TOKEN')
    if not token: raise RuntimeError('GitHub fallback publishing token is unavailable')
    env = dict(os.environ, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic '+base64.b64encode(('x-access-token:'+token).encode()).decode())
    url = GIT_URL
    for attempt in range(5):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            def git(*args, input=None, check=True):
                result = subprocess.run(['git', *args], cwd=work, env=env, input=input,
                                        capture_output=True, text=True)
                if check and result.returncode:
                    # Never echo authenticated process environment or provider responses.
                    raise RuntimeError('GitHub fallback git operation failed: '+args[0])
                return result
            git('init', '-q'); git('config', 'user.name', 'github-actions[bot]')
            git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
            # Preserve the full tree, but fetch/check out only this publisher's
            # scope. A station update must not download the satellite archive.
            git('remote', 'add', 'origin', url)
            git('config', 'remote.origin.promisor', 'true')
            git('config', 'remote.origin.partialclonefilter', 'blob:none')
            git('sparse-checkout', 'init', '--no-cone')
            patterns = ['/_fallback/'] + [f'/{value}' for value in selected] + [f'/{value}/**' for value in selected]
            git('sparse-checkout', 'set', '--no-cone', '--stdin', input='\n'.join(patterns)+'\n')
            remote = git('ls-remote', '--exit-code', url, 'refs/heads/'+BRANCH, check=False)
            if remote.returncode not in [0,2]: raise RuntimeError('GitHub fallback branch could not be read')
            previous = remote.stdout.split()[0] if remote.returncode == 0 else ''
            if previous:
                git('fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', 'refs/heads/'+BRANCH)
                # The observed SHA must match the tree used for the lease.
                previous = git('rev-parse', 'FETCH_HEAD').stdout.strip()
                git('checkout', '-q', '--detach', previous)
            index_path = work/'_fallback/index.json'
            old = json.loads(index_path.read_text()) if index_path.exists() else {'files': {}}
            records = dict(old.get('files', {}))
            if any(r['generation'] is not None and records.get(p, {}).get('generation') is not None
                   and r['generation'] < records[p]['generation'] for p,r in incoming.items()):
                print('Older fallback snapshot withheld.', flush=True); return
            for path in list(records):
                if owned(path, selected) and path not in incoming:
                    (work/path).unlink(missing_ok=True); del records[path]
            for path, record in incoming.items():
                target = work/path; target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root/path, target); records[path] = record
            if sum(r['size'] for r in records.values()) > MAX_BYTES:
                raise RuntimeError('GitHub fallback snapshot exceeds 1 GiB; previous snapshot retained')
            now = datetime.now(timezone.utc).isoformat()
            index_path.parent.mkdir(exist_ok=True)
            index_path.write_text(json.dumps({'version':1, 'generatedAt':now, 'files':records}, separators=(',',':')))
            budget_path = work/'_fallback/budget.json'
            if control is not None:
                budget_path.write_text(json.dumps(control))
            budget = json.loads(budget_path.read_text()) if budget_path.exists() else {}
            # A healthy hourly backup must not cancel a recent outage signal.
            status_path = work/'_fallback/status.json'
            status = json.loads(status_path.read_text()) if status_path.exists() else {}
            if budget.get('paused') and budget.get('until', 0) > time.time():
                status_path.write_text(json.dumps({'version':1,'mode':'active','until':budget['until'],
                    'reason':'budget_guard','updatedAt':now}))
            elif active or status.get('until', 0) < time.time() or status.get('reason') == 'budget_guard':
                status_path.write_text(json.dumps({'version':1, 'mode':'active' if active else 'standby',
                    'until':int(time.time()+1800) if active else 0, 'updatedAt':now}))
            git('add', '--all')
            tree = git('write-tree').stdout.strip()
            # A parentless snapshot keeps only one reachable data version.
            commit = git('commit-tree', tree, input='Current weather fallback snapshot\n').stdout.strip()
            pushed = git('push', '-q', '--force-with-lease=refs/heads/'+BRANCH+':'+previous,
                         url, commit+':refs/heads/'+BRANCH, check=False)
            if pushed.returncode == 0:
                print(json.dumps({'delivery':'github-fallback', 'files':len(records),
                    'bytes':sum(r['size'] for r in records.values()), 'active':active}), flush=True)
                return
        time.sleep(attempt+1)
    raise RuntimeError('Concurrent GitHub publications; keeping the previous fallback snapshot')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('command', choices=['publish','backup'])
    parser.add_argument('paths', nargs='*'); args=parser.parse_args()
    if args.command == 'backup':
        from hydrate_r2_data import restore_inputs
        restore_inputs(BACKUP_SCOPES)
        from r2_usage_guard import decision
        publish(BACKUP_SCOPES, active=decision()['paused'])
    else:
        publish(args.paths)
