"""Official Portuguese hourly rain, with native SYNOP windows for early 48 h coverage."""
from concurrent.futures import ThreadPoolExecutor
import json
import re

from iberia_observations import IPMA, point, stamp
import rainfall_europe as europe
import update_rainfall as core

AREAS = ((36.8, 42.2, -9.6, -6), (36, 40.2, -32, -24.5), (30, 34.5, -18, -15))
IPMA_NAME = 'IPMA / Instituto Português do Mar e da Atmosfera'
SYNOP_NAME = 'IPMA / official Portuguese SYNOP observations via DWD'
SOURCE = (IPMA_NAME + ' and official SYNOP via DWD', 'https://api.ipma.pt/')
PERIOD = ('IPMA hourly measured precipitation in mm, ending at the published UTC observation hour. '
          'The source exposes the last 24 hours; our retained history builds rolling 48-hour totals. '
          'Official Portuguese SYNOP reports via DWD supply complete longer windows where available. '
          'These retain their actual UTC ending times; missing intervals are never counted as zero.')
# Station identities and degrees/minutes from the DWD MOSMIX catalogue.
# https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/mosmix_stationskatalog.cfg?view=nasPublication
SYNOP = {
    '08501': ('Flores Airport', (39, 27), (-31, 8)),
    '08505': ('Horta Airport', (38, 31), (-28, 43)),
    '08509': ('Lajes Airport', (38, 46), (-27, 6)),
    '08515': ('Santa Maria Airport', (36, 58), (-25, 10)),
    '08521': ('Madeira Airport', (32, 41), (-16, 46)),
    '08540': ('Monte Real', (39, 50), (-8, 53)),
    '08541': ('Sines / Montes Chãos', (37, 57), (-8, 50)),
    '08545': ('Porto Airport', (41, 14), (-8, 41)),
    '08548': ('Coimbra / Cernache', (40, 9), (-8, 28)),
    '08554': ('Faro Airport', (37, 1), (-7, 58)),
    '08567': ('Vila Real', (41, 16), (-7, 43)),
    '08571': ('Portalegre', (39, 17), (-7, 25)),
}
SYNOP_CHECKED = core.OUTPUT.with_name('portugal-rain-synop-checked.json')


def area(lat, lon):
    return next((i for i, (s, n, w, e) in enumerate(AREAS) if s <= lat <= n and w <= lon <= e), None)


def parse_ipma(observations, metadata, now):
    if not isinstance(observations, dict) or not isinstance(metadata, list) or len(observations) > 72 or len(metadata) > 1000:
        raise ValueError('IPMA rain observation schema changed')
    stations = {}
    for feature in metadata:
        geo = point(feature, 'PT') if isinstance(feature, dict) else None
        if not geo:
            continue
        lat, lon, props = geo
        code = str(props.get('idEstacao', ''))
        if re.fullmatch(r'\d{1,12}', code) and area(lat, lon) is not None:
            stations[code] = (props.get('localEstacao') or 'IPMA ' + code, lat, lon, [])
    end = int(now.timestamp()) // 3600 * 3600
    for key, records in observations.items():
        time = stamp(key)
        if time is None or time % 3600 or not end - 72 * 3600 <= time <= end or not isinstance(records, dict):
            continue
        for code, value in records.items():
            if code not in stations or not isinstance(value, dict):
                continue
            rain = core.amount(value.get('precAcumulada'))
            if rain is not None:
                stations[code][3].append((time, rain, False))
    out = [{**core.station('PT', 'IPMA-' + code, name, lat, lon, rows), 'sourceName': IPMA_NAME}
           for code, (name, lat, lon, rows) in stations.items() if rows]
    if not any(s['times'][-1] >= end - 3 * 3600 for s in out):
        raise ValueError('No recent IPMA hourly precipitation')
    return out


def decimal(pair):
    degrees, minutes = pair
    return degrees + (minutes / 60 if degrees >= 0 else -minutes / 60)


def load_synop(now, download):
    def one(item):
        code, (name, lat, lon) = item
        meta = dict(country='PT', name=name, lat=decimal(lat), lon=decimal(lon))
        try:
            station = europe.parse_synop(download(europe.POI + code + '-BEOB.csv', False), code, meta)
            # The two sources have different station IDs and reporting windows.
            # Keep them separate; never assemble one window from two gauges.
            station.update(code='SYNOP-' + code, sourceName=SYNOP_NAME)
            return station
        except Exception as error:
            print('PT SYNOP gauge unavailable:', code, type(error).__name__, flush=True)
            return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        return europe.trimmed([s for s in pool.map(one, SYNOP.items()) if s], now)


def ipma_48h_coverage(previous, current, now):
    combined = {}
    for s in [*previous, *current]:
        if s['country'] != 'PT' or not s['code'].startswith('IPMA-'):
            continue
        zone, times = combined.setdefault(s['code'], (area(s['lat'], s['lon']), set()))
        times.update(s['times'])
    end = int(now.timestamp()) // 3600 * 3600
    counts = [0] * len(AREAS)
    for zone, times in combined.values():
        if zone is not None and any(all(t - i * 3600 in times for i in range(48)) for t in range(end, end - 10800, -3600)):
            counts[zone] += 1
    return all(n >= 3 for n in counts)


def load(now, previous, download=core.download, checked_path=SYNOP_CHECKED):
    error = None
    try:
        current = parse_ipma(download(IPMA + 'observations.json'), download(IPMA + 'stations.json'), now)
    except Exception as exc:
        current = []
        error = exc
        print('PT IPMA hourly rain unavailable:', type(exc).__name__, flush=True)
    if current and ipma_48h_coverage(previous, current, now):
        return current
    # One backfill attempt per hour in the long-running collector. Each job
    # restores the published gauge history before collecting another round.
    hour = int(now.timestamp()) // 3600
    try: already_checked = json.loads(checked_path.read_text()) == hour
    except (OSError, ValueError): already_checked = False
    if not already_checked:
        current.extend(load_synop(now, download))
        try: checked_path.write_text(json.dumps(hour))
        except OSError: pass
    if error and not current:
        raise error
    return current
