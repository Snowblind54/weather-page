"""Keep map playback small; load the full measured history only on demand."""
import argparse
import json
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LATEST = ROOT / 'data/official-temperature.json'
HISTORY = ROOT / 'data/official-temperature-history.json'
# Two hours of playback plus Norway's maximum three-hour observation age.
RECENT_SECONDS = 5 * 3600


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        handle.write('\n')
        temporary = pathlib.Path(handle.name)
    temporary.replace(path)


def read_snapshot(path):
    snapshot = json.loads(path.read_text(encoding='utf-8'))
    if snapshot.get('version') != 1 or not isinstance(snapshot.get('stations'), list):
        raise ValueError('Invalid official temperature snapshot')
    return snapshot


def restore():
    if not HISTORY.exists():
        return  # First deployment still has the full history in LATEST.
    history = read_snapshot(HISTORY)
    current = read_snapshot(LATEST) if LATEST.exists() else history
    grouped = {}
    # Merge both inputs: publication interruption must not lose newer rows.
    for station in history['stations'] + current['stations']:
        key = (station['country'], station['code'])
        previous = grouped.get(key, {})
        rows = {row[0]: row for row in previous.get('rows', []) + station.get('rows', [])}
        grouped[key] = {**station, 'rows': [rows[t] for t in sorted(rows)]}
    restored = {**current, 'stations': list(grouped.values()), 'historyHours': 24}
    restored.pop('historyFile', None)
    atomic_json(LATEST, restored)


def split():
    snapshot = read_snapshot(LATEST)
    atomic_json(HISTORY, snapshot)
    cutoff = int(snapshot['generatedAt']) - RECENT_SECONDS
    recent = []
    for station in snapshot['stations']:
        rows = [row for row in station.get('rows', []) if row[0] >= cutoff]
        if rows:
            recent.append({**station, 'rows': rows})
    operational = {**snapshot, 'stations': recent, 'historyHours': 5,
                   'historyFile': 'data/official-temperature-history.json'}
    atomic_json(LATEST, operational)
    print('Split official temperatures:', LATEST.stat().st_size, 'bytes map;',
          HISTORY.stat().st_size, 'bytes full history', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', action='store_true')
    restore() if parser.parse_args().restore else split()
