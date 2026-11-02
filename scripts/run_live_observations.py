"""Keep measured weather fresh between delayed GitHub schedule starts.

One bounded five-hour runner collects four independent feeds every ten minutes.
The workflow queues a successor hourly; a failed provider never stops other feeds.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SCOPES = {
    'temperature': ['data/official-temperature.json', 'data/official-temperature-history.json'],
    'wind': ['data/official-wind.json', 'data/official-wind-history.json'],
    'rain': ['data/official-rainfall.json'],
    'space': ['data/space-weather.json'],
}


def commands(kind):
    if kind == 'temperature':
        prepare = [['python3', 'scripts/split_official_temperature.py', '--restore'],
                   ['python3', 'scripts/update_official_temperature_all.py'],
                   ['python3', 'scripts/split_official_temperature.py']]
    elif kind == 'wind':
        # run_official_wind restores the full history before collecting.
        prepare = [['python3', 'scripts/run_official_wind.py', '--cycles', '1']]
        # The existing wind runner already publishes its two output files.
        return prepare
    elif kind == 'rain':
        prepare = [['python3', 'scripts/update_rainfall.py']]
    elif kind == 'space':
        prepare = [['python3', 'scripts/update_space_weather.py']]
    else:
        raise ValueError('Unknown observation feed')
    return prepare + [
        ['bash', 'scripts/publish_generated_data.sh', 'Refresh live '+kind+' observations', *SCOPES[kind]],
        ['python3', 'scripts/github_fallback.py', 'mirror', *SCOPES[kind]],
    ]


def restore(kind):
    # The mirror follows every successful publication. Private R2 can still
    # accept reads while its publisher is paused; that copy may be much older.
    from github_fallback import restore as github_restore, download
    from sync_r2_data import generation
    paths=[ROOT/p for p in SCOPES[kind]]
    if all(p.is_file() for p in paths):
        try:
            records=json.loads(download('_fallback/index.json'))['files']
            if all(generation(p) is not None and records.get(path,{}).get('generation') is not None and generation(p)>=records[path]['generation'] for path,p in zip(SCOPES[kind],paths)):
                return
        except Exception:
            # Locally retained, valid histories are preferable to an old R2 copy.
            if all(generation(p) is not None for p in paths):return
    try:
        github_restore(SCOPES[kind])
    except Exception:
        from hydrate_r2_data import restore_inputs
        restore_inputs(SCOPES[kind], allow_empty=kind == 'wind')


def execute(command, timeout):
    process = subprocess.Popen(command, cwd=ROOT, start_new_session=True)
    try:
        result = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Wind has nested updater processes. Stop the whole process group so
        # a timed-out collection cannot race the next cycle's publication.
        for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, None)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                break
            try:
                process.wait(timeout=grace)
                break
            except subprocess.TimeoutExpired:
                continue
        raise
    if result:
        raise subprocess.CalledProcessError(result, command)


def collect(kind, deadline):
    for command in commands(kind):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Collector handover deadline reached')
        execute(command, timeout=min(480, remaining))
    path = ROOT / SCOPES[kind][0]
    snapshot = json.loads(path.read_text())
    print(json.dumps({'feed': kind, 'generatedAt': snapshot.get('generatedAt'),
                      'stations': len(snapshot.get('stations', [])), 'published': True}), flush=True)


def cyclone_run_recent(payload, now):
    """Avoid duplicating a recently successful or already running cyclone job."""
    for run in payload.get('workflow_runs', []):
        try:
            stamp = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00')).timestamp()
        except (ValueError, KeyError, TypeError):
            continue
        if 0 <= now-stamp < 55*60 and (
                run.get('status') != 'completed' or run.get('conclusion') == 'success'):
            return True
    return False


def dispatch_cyclones():
    """An hourly heartbeat independent of GitHub's frequently delayed cron."""
    token, repo = os.environ.get('GITHUB_TOKEN'), os.environ.get('GITHUB_REPOSITORY')
    if not token or not repo:
        return
    base = f'https://api.github.com/repos/{repo}/actions/workflows/update-cyclones.yml'
    headers = {'Authorization': 'Bearer '+token, 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NorthernWeather'}
    with urllib.request.urlopen(urllib.request.Request(
            base+'/runs?per_page=10', headers=headers), timeout=15) as response:
        recent = json.load(response)
    if cyclone_run_recent(recent, time.time()):
        return
    request = urllib.request.Request(base+'/dispatches', data=b'{"ref":"main"}',
                                     headers={**headers, 'Content-Type':'application/json'},
                                     method='POST')
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 204:
            raise RuntimeError('Cyclone dispatch was not accepted')
    print(json.dumps({'feed':'cyclones','action':'hourly-dispatch'}),flush=True)


def run(cycles=30, interval=600, collect_feed=collect, restore_feed=restore,
        clock=time.monotonic, sleep=time.sleep, cyclone_dispatch=None):
    started = clock()
    deadline = started + 5 * 3600
    for cycle in range(cycles):
        if clock() >= deadline:
            break
        print(f'Live observation cycle {cycle + 1}/{cycles}', flush=True)
        if cyclone_dispatch is not None and cycle % 6 == 0:
            try:
                cyclone_dispatch()
            except Exception as error:
                print(json.dumps({'feed':'cyclones','action':'dispatch-failed',
                                  'error':type(error).__name__}),flush=True)
        def work(kind):
            restore_feed(kind)
            collect_feed(kind, deadline)
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = {pool.submit(work, kind): kind for kind in SCOPES}
            for job in as_completed(jobs):
                try:
                    job.result()
                except Exception as error:
                    # Retain the successful previous publication and retry on
                    # the next cycle; never relabel its observation timestamps.
                    print(json.dumps({'feed': jobs[job], 'published': False,
                                      'error': type(error).__name__}), flush=True)
        if cycle + 1 < cycles:
            target = min(started + (cycle + 1) * interval, deadline)
            while clock() < target:
                sleep(min(30, target - clock()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cycles', type=int, choices=range(1, 31), default=30)
    run(parser.parse_args().cycles, cyclone_dispatch=dispatch_cyclones)
