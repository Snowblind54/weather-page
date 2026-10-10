"""Add official NOAA/NDBC coastal wind stations to the shared Florida wind snapshot.

The main Florida adapter uses Aviation Weather METAR/SPECI stations. This small
post-processor adds official NOAA/NDBC and NOAA/NOS coastal stations from
NDBC's standard-meteorological realtime feed. The feed publishes WDIR/WSPD/GST
in degrees true and m/s, so no wind-unit conversion is needed.
"""
import concurrent.futures as futures
import datetime as dt
import json
import pathlib
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/official-wind.json'
NDBC_BASE = 'https://www.ndbc.noaa.gov/data/realtime2/'

# Active Florida coastal/C-MAN/NOS stations whose NDBC realtime2 feeds expose
# standard meteorological wind speed and gust fields. Keep this curated rather
# than adding inactive historical stations that no longer report.
STATIONS = {
    # Florida Panhandle / northeast Gulf
    'PCLF1': ('Pensacola', 30.404, -87.211),
    'PCBF1': ('Panama City Beach', 30.213, -85.880),
    'PACF1': ('Panama City', 30.150, -85.664),
    'APCF1': ('Apalachicola', 29.724, -84.980),
    'CDRF1': ('Cedar Key', 29.136, -83.029),
    'KTNF1': ('Keaton Beach', 29.819, -83.593),

    # Tampa Bay / southwest Florida
    'VENF1': ('Venice', 27.072, -82.453),
    'TPAF1': ('Tampa Cruise Terminal 2', 27.933, -82.433),
    'OPTF1': ('Old Port Tampa', 27.858, -82.553),
    'SAPF1': ('St. Petersburg', 27.761, -82.627),
    'FMRF1': ('Fort Myers', 26.647, -81.871),

    # Florida Keys / southeast Florida
    'SANF1': ('Sand Key', 24.456, -81.877),
    'KYWF1': ('Key West', 24.556, -81.808),
    'SMKF1': ('Sombrero Key', 24.628, -81.109),
    'LONF1': ('Long Key', 24.844, -80.864),
    'VAKF1': ('Virginia Key', 25.731, -80.162),
    'PEGF1': ('Port Everglades', 26.086, -80.116),
    'LKWF1': ('Lake Worth Pier', 26.613, -80.034),

    # Atlantic coast
    'TRDF1': ('Trident Pier', 28.416, -80.593),
    'SAUF1': ('St. Augustine', 29.857, -81.264),
    'MYPF1': ('Mayport', 30.398, -81.428),
    'FRDF1': ('Fernandina Beach', 30.675, -81.465),
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
        headers={'User-Agent': 'NorthernWeather/8.127 (github.com/Snowblind54/weather-page)'},
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

    def collect(item):
        code, meta = item
        try:
            return code, meta, fetch_station(code, now), None
        except Exception as error:
            return code, meta, [], error

    # These are independent NOAA files. Fetching them concurrently keeps the
    # 10-minute updater quick even as the curated Florida coastal set grows.
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(collect, STATIONS.items()))

    for code, (name, lat, lon), rows, error in results:
        station_code = 'NDBC-' + code
        key = ('US', station_code)
        old = stations.get(key, {}).get('rows', [])
        if error is not None:
            print('NDBC', code, 'unavailable:', str(error)[:160], flush=True)
        if rows:
            fresh += 1
        merged = merge_rows(old, rows, now)
        if merged:
            stations[key] = {
                'country': 'US', 'code': station_code, 'name': name,
                'lat': lat, 'lon': lon, 'rows': merged,
            }

    source = snapshot.setdefault('sources', {}).setdefault('US', {})
    source.update({
        'name': 'NOAA / NWS Aviation Weather Center + NOAA/NDBC/NOS',
        'url': 'https://www.ndbc.noaa.gov/',
        'timeKind': 'observation',
        'period': ('Florida official observations: METAR/SPECI airport wind plus NOAA/NDBC/NOS '
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
    print('Florida NOAA/NDBC/NOS coastal stations available:',
          sum(1 for code in STATIONS if ('US', 'NDBC-' + code) in stations),
          'of', len(STATIONS), 'configured; fresh this run:', fresh, flush=True)


if __name__ == '__main__':
    main()
