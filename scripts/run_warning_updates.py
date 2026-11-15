"""Refresh warning snapshots on a bounded runner between delayed cron starts."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
FEEDS = {
    'latvia': ('scripts/update_latvia_warnings.py', 'data/latvia-warnings.json'),
    'national': ('scripts/update_national_warnings.py', 'data/national-warnings.json'),
}


def execute(command, timeout):
    process = subprocess.Popen(command, cwd=ROOT, start_new_session=True)
    try:
        result = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
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


def collect(deadline, execute_command=execute, clock=time.monotonic,
            wall_clock=time.time, root=ROOT):
    ready = []
    for kind, (script, output) in FEEDS.items():
        remaining = deadline - clock()
        if remaining <= 0:
            break
        started = wall_clock()
        path = root / output
        previous = path.read_bytes() if path.is_file() else None
        try:
            execute_command(['python3', script], min(240, remaining))
            data = json.loads(path.read_text())
            updated = dt.datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00'))
            if (data.get('version') != 1 or updated.tzinfo is None or
                    not started - 5 <= updated.timestamp() <= wall_clock() + 300):
                raise ValueError('Warning collector did not produce a new snapshot')
            ready.append(output)
        except Exception as error:
            # Never freshen or publish the old file after a failed collection.
            # A failure in Latvia must not prevent the other countries updating.
            # A timeout during a write must not poison the next cycle's inputs.
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                temporary = path.with_suffix('.restore-tmp')
                temporary.write_bytes(previous)
                temporary.replace(path)
            print(f'{kind} warning collection failed: {type(error).__name__}', flush=True)
    if not ready:
        return False
    published = False
    for command in [
        ['bash', 'scripts/publish_generated_data.sh', 'Refresh official warning snapshots', *ready],
        ['python3', 'scripts/github_fallback.py', 'mirror', *ready],
    ]:
        remaining = deadline - clock()
        if remaining <= 0:
            break
        try:
            execute_command(command, min(240, remaining))
            published = True
        except Exception as error:
            print(f'Warning publication failed: {type(error).__name__}', flush=True)
    return published


def run(cycles=30, interval=600, collect_cycle=collect,
        clock=time.monotonic, sleep=time.sleep):
    started = clock()
    deadline = started + 5 * 3600
    for cycle in range(cycles):
        if clock() >= deadline:
            break
        print(f'Warning collection cycle {cycle + 1}/{cycles}', flush=True)
        try:
            collect_cycle(deadline)
        except Exception as error:
            print(f'Warning cycle failed: {type(error).__name__}', flush=True)
        if cycle + 1 < cycles:
            target = min(started + (cycle + 1) * interval, deadline)
            while clock() < target:
                sleep(min(30, target - clock()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cycles', type=int, choices=range(1, 31), default=30)
    run(parser.parse_args().cycles)
