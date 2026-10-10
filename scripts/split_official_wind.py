"""Publish a small operational wind snapshot and keep 24 h history separate.

The wind map only needs recent rows to render labels and the short map timeline.
The larger 24-hour dataset is fetched by the browser only after a station popup
is opened.
"""
import json
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LATEST = ROOT / 'data/official-wind.json'
HISTORY = ROOT / 'data/official-wind-history.json'
RECENT_SECONDS = 3 * 3600


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        handle.write('\n')
        temporary = pathlib.Path(handle.name)
    temporary.replace(path)


def main():
    snapshot = json.loads(LATEST.read_text())
    if snapshot.get('version') != 1 or not isinstance(snapshot.get('stations'), list):
        raise ValueError('Invalid official wind snapshot')

    # Preserve the complete merged 24-hour snapshot for station popups and for
    # the next updater run, which uses it to continue accumulating observations.
    atomic_json(HISTORY, snapshot)

    cutoff = int(snapshot['generatedAt']) - RECENT_SECONDS
    recent = []
    for station in snapshot['stations']:
        rows = [row for row in station.get('rows', []) if row[0] >= cutoff]
        if rows:
            recent.append({**station, 'rows': rows})

    operational = {**snapshot, 'stations': recent, 'historyFile': 'data/official-wind-history.json'}
    atomic_json(LATEST, operational)
    print('Split official wind:', len(recent), 'recent stations;', LATEST.stat().st_size,
          'bytes operational;', HISTORY.stat().st_size, 'bytes history', flush=True)


if __name__ == '__main__':
    main()
