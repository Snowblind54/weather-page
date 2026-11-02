"""Keep measured weather fresh between delayed GitHub schedule starts.

One bounded five-hour runner collects three independent feeds every ten minutes.
The workflow queues a successor hourly; a failed provider never stops other feeds.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
SCOPES = {
    'temperature': ['data/official-temperature.json', 'data/official-temperature-history.json'],
    'wind': ['data/official-wind.json', 'data/official-wind-history.json'],
    'rain': ['data/official-rainfall.json'],
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
    else:
        raise ValueError('Unknown observation feed')
    return prepare + [
        ['bash', 'scripts/publish_generated_data.sh', 'Refresh live '+kind+' observations', *SCOPES[kind]],
        ['python3', 'scripts/github_fallback.py', 'mirror', *SCOPES[kind]],
    ]


def restore(kind):
    # The mirror follows every successful publication. Private R2 can still
    # accept reads while its publisher is paused; that copy may be much older.
    from github_fallback import restore as github_restore
    try:
        github_restore(SCOPES[kind])
    except Exception:
        from hydrate_r2_data import restore_inputs
        restore_inputs(SCOPES[kind], allow_empty=kind == 'wind')


def collect(kind, deadline):
    for command in commands(kind):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Collector handover deadline reached')
        subprocess.run(command, cwd=ROOT, check=True, timeout=min(480, remaining))
    path = ROOT / SCOPES[kind][0]
    snapshot = json.loads(path.read_text())
    print(json.dumps({'feed': kind, 'generatedAt': snapshot.get('generatedAt'),
                      'stations': len(snapshot.get('stations', [])), 'published': True}), flush=True)


def run(cycles=30, interval=600, collect_feed=collect, restore_feed=restore,
        clock=time.monotonic, sleep=time.sleep):
    started = clock()
    deadline = started + 5 * 3600
    ready = set()
    for cycle in range(cycles):
        if clock() >= deadline:
            break
        print(f'Live observation cycle {cycle + 1}/{cycles}', flush=True)
        def work(kind):
            if kind not in ready:
                restore_feed(kind)
                ready.add(kind)
            collect_feed(kind, deadline)
        with ThreadPoolExecutor(max_workers=3) as pool:
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
    run(parser.parse_args().cycles)
