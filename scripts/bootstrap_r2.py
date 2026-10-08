"""Pause Git publishers while recording a consistent R2 publication registry."""
import json
import os
import subprocess
import time
import urllib.request
import urllib.error

API = 'https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY']


def request(path, method='GET'):
    req = urllib.request.Request(API + path, method=method, headers={
        'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read()
        return json.loads(body) if body else None


def main():
    paused = []
    try:
        workflows = request('/actions/workflows?per_page=100')['workflows']
        for workflow in workflows:
            path = workflow['path']
            if workflow['state'] == 'active' and (path.startswith('.github/workflows/update-') or path.endswith('/sync-r2-data.yml')):
                request('/actions/workflows/' + str(workflow['id']) + '/disable', 'PUT')
                paused.append(workflow['id'])
        print('Paused weather publishers:', len(paused), flush=True)
        deadline = time.monotonic() + 600
        while True:
            running = []
            for status in ['queued', 'in_progress', 'waiting']:
                runs = request('/actions/runs?per_page=100&status=' + status)['workflow_runs']
                running.extend(run for run in runs if run['workflow_id'] in paused)
            if not running:
                break
            for run in running:
                try:
                    request('/actions/runs/' + str(run['id']) + '/cancel', 'POST')
                except urllib.error.HTTPError as exc:
                    if exc.code not in [409, 422]:
                        raise
            if time.monotonic() >= deadline:
                raise RuntimeError('Publishers did not drain; bootstrap withheld')
            time.sleep(10)
        subprocess.run(['git', 'fetch', '--depth', '1', 'origin', 'main'], check=True)
        subprocess.run(['git', 'reset', '--hard', 'FETCH_HEAD'], check=True)
        subprocess.run(['python3', 'scripts/sync_r2_data.py'], check=True)
        subprocess.run(['python3', 'scripts/check_r2_public.py'], check=True)
        print('R2 publication registry initialized and public access verified.', flush=True)
    finally:
        failures = []
        for workflow_id in paused:
            try:
                request('/actions/workflows/' + str(workflow_id) + '/enable', 'PUT')
            except Exception:
                failures.append(workflow_id)
        if failures:
            raise RuntimeError('Could not resume workflows: ' + str(failures))
        print('Resumed weather publishers:', len(paused), flush=True)


if __name__ == '__main__':
    main()
