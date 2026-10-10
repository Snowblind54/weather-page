"""Add official NOAA/NDBC coastal wind stations to the shared Florida wind snapshot.

The main Florida adapter uses Aviation Weather METAR/SPECI stations. This small
post-processor adds a curated set of official NOAA coastal stations from NDBC's
standard-meteorological realtime feed. NDBC publishes WDIR/WSPD/GST in degrees
true and m/s, so no wind-unit conversion is needed.
"""
import datetime as dt
import json
import pathlib
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/official-wind.json'
NDBC_BASE = 'https://www.ndbc.noaa.gov/data/realtime2/'
STATIONS = {
    'CDRF1': ('Cedar Key', 29.136, -83.029),
    'KTNF1': ('Keaton Beach', 29.819, -83.593),
    'LONF1': ('Long Key', 24.844, -80.864),
    'SAUF1': ('St. Augustine', 29.857, -81.264),
    'VENF1': ('Venice', 27.072, -82.453),
}


def value(text, maximum=100):
    if text in ('MM', '', None):
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return round(number, 2) if 0 <= number <= maximum else None


def parse_ndbc(text, now):
    """Return ascending [unix, sustained, gust, direction] rows from NDBC text."""
    cutoff = int(now.timestamp()) - 24 * 3600
    limit = int(now.timestamp()) + 60
    rows = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            year, month, day, hour, minute = map(int, parts[:5])
            stamp = int(dt.datetime(year, month, day, hour, minute, tzinfo=dt.timezone.utc).timestamp())
        except (TypeError, ValueError):
            continue
        if stamp < cutoff or stamp > limit:
            continue
        direction = value(parts[5], 360)
        speed = value(parts[6])
        gust = value(parts[7])
        if speed is None and gust is None:
            continue
        rows[stamp] = [stamp, speed, gust, direction]
    return [rows[t] for t in sorted(rows)]


def fetch_station(code, now):
    request = urllib.request.Request(
        NDBC_BASE + code + '.txt',
        headers={'User-Agent': 'NorthernWeather/8.121 (github.com/Snowblind54/weather-page)'},
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        text = response.read(2 * 1024 * 1024 + 1).decode('ascii', errors='replace')
    if len(text) > 2 * 1024 * 1024:
        raise ValueError('NDBC response too large')
    return parse_ndbc(text, now)


def merge_rows(old_rows, new_rows, now):
    cutoff = int(now.timestamp()) - 24 * 3600
    limit = int(now.timestamp()) + 60
    merged = {row[0]: row for row in list(old_rows or []) + list(new_rows or [])
              if cutoff <= row[0] <= limit}
    return [merged[t] for t in sorted(merged)]


def main():
    now = dt.datetime.now(dt.timezone.utc)
    snapshot = json.loads(OUTPUT.read_text())
    stations = {(s['country'], s['code']): s for s in snapshot.get('stations', [])}
    fresh = 0

    for code, (name, lat, lon) in STATIONS.items():
        station_code = 'NDBC-' + code
        key = ('US', station_code)
        old = stations.get(key, {}).get('rows', [])
        try:
            rows = fetch_station(code, now)
            if rows:
                fresh += 1
        except Exception as error:
            print('NDBC', code, 'unavailable:', str(error)[:160], flush=True)
            rows = []
        merged = merge_rows(old, rows, now)
        if merged:
            stations[key] = {
                'country': 'US', 'code': station_code, 'name': name,
                'lat': lat, 'lon': lon, 'rows': merged,
            }

    source = snapshot.setdefault('sources', {}).setdefault('US', {})
    source.update({
        'name': 'NOAA / NWS Aviation Weather Center + NOAA/NDBC',
        'url': 'https://www.ndbc.noaa.gov/',
        'timeKind': 'observation',
        'period': ('Florida official observations: METAR/SPECI airport wind plus NOAA/NDBC '
                   'coastal-station wind speed, direction and gust. NDBC standard meteorological '
                   'wind values are reported in m/s.'),
    })
    if fresh:
        source['status'] = 'ok'
        source['fetchedAt'] = int(now.timestamp())

    snapshot['stations'] = sorted(stations.values(), key=lambda s: (s['country'], s['code']))
    with tempfile.NamedTemporaryFile(mode='w', dir=OUTPUT.parent, delete=False) as handle:
        json.dump(snapshot, handle, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        handle.write('\n')
        temporary = pathlib.Path(handle.name)
    temporary.replace(OUTPUT)
    print('Florida NOAA/NDBC coastal stations available:',
          sum(1 for code in STATIONS if ('US', 'NDBC-' + code) in stations),
          'fresh this run:', fresh, flush=True)


if __name__ == '__main__':
    main()
