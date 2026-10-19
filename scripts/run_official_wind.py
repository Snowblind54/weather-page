"""Publish bounded ten-minute wind cycles inside one scheduled Actions run.

GitHub may delay individual cron triggers. Once a runner starts, do not wait
for another cron event for every collection. Manual and push runs use one cycle.
"""
import argparse
import pathlib
import shutil
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def publish_cycle():
    # The preceding cycle split the live snapshot down to three hours. Restore
    # its full history before merging, including on cycles within this same job.
    history = ROOT / 'data/official-wind-history.json'
    if history.exists():
        shutil.copyfile(history, ROOT / 'data/official-wind.json')
    commands = [
        ['python3', 'scripts/update_official_wind.py'],
        ['python3', 'scripts/add_florida_coastal_wind.py'],
        ['python3', 'scripts/split_official_wind.py'],
        ['bash', 'scripts/publish_generated_data.sh', 'Refresh official Northern Europe wind observations',
         'data/official-wind.json', 'data/official-wind-history.json'],
    ]
    for command in commands:
        subprocess.run(command, cwd=ROOT, check=True)


def run(cycles, interval=600):
    for index in range(cycles):
        next_start = time.monotonic() + interval
        print('Official wind collection cycle', index + 1, 'of', cycles, flush=True)
        publish_cycle()
        if index + 1 < cycles:
            time.sleep(max(0, next_start - time.monotonic()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cycles', type=int, choices=range(1, 7), default=1)
    run(parser.parse_args().cycles)
