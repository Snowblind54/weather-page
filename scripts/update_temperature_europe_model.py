"""Publish one terrain-aware European heatmap snapshot, including city samples.

Retain the existing grid spacing and land-cell selection. Failed collections
never replace the previous successful snapshot.
"""
import datetime as dt
import http.client
import json
import math
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from update_temperature_americas_model import axis

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/temperature-europe-model.json'
CONFIG = ROOT / 'scripts/temperature_europe_points.json'


class ProviderUnavailable(RuntimeError):
    """The provider is unreachable or could not deliver a decodable response."""


def fetch_samples(request):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=75) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504):
                raise
            delay = 20 * (attempt + 1)
            retry_after = error.headers.get('Retry-After') if error.headers else None
            if retry_after and retry_after.isdigit():
                delay = max(delay, min(120, int(retry_after)))
        # A successful HTTP status can still carry an empty, cut-off or HTML
        # response. Retry response decoding/transport failures here, while
        # keeping the decoded weather-data validation in collect() strict.
        except (urllib.error.URLError, TimeoutError, ConnectionError,
                http.client.IncompleteRead, json.JSONDecodeError, UnicodeDecodeError) as error:
            delay = 20 * (attempt + 1)
        if attempt == 2:
            raise ProviderUnavailable('Temperature provider unavailable after three attempts')
        print('Temperature provider temporarily unavailable; retrying in', delay, 'seconds', flush=True)
        time.sleep(delay)


def valid_previous_snapshot(path):
    """Only a complete, usable snapshot may turn an outage into a safe skip."""
    try:
        data = json.loads(path.read_text())
        config = json.loads(CONFIG.read_text())
        generated = data['generatedAt']
        if (data['version'] != 1 or not isinstance(generated, int) or
                isinstance(generated, bool) or generated <= 0 or generated > time.time() + 300 or
                set(data['grids']) != set(config['grids'])):
            return False
        groups = []
        for name, (sw, ne, lat_step, lon_step) in config['grids'].items():
            grid = data['grids'][name]
            lats, lons = axis(sw[0], ne[0], lat_step), axis(sw[1], ne[1], lon_step)
            if grid['latitudes'] != lats or grid['longitudes'] != lons:
                return False
            groups.append((grid['series'], [(lat, lon) for lat in lats for lon in lons]))
        groups.append((data['cities'], config['cities']))
        for series, points in groups:
            if len(series) != len(points):
                return False
            for item, point in zip(series, points):
                times, temps = item['times'], item['temps']
                if ((item['lat'], item['lon']) != tuple(point) or len(times) < 2 or
                        len(times) != len(temps) or any(
                            not isinstance(t, (int, float)) or isinstance(t, bool) or
                            not math.isfinite(t) or (i and t <= times[i-1])
                            for i, t in enumerate(times)) or any(
                                t is not None and (not isinstance(t, (int, float)) or isinstance(t, bool) or
                                not math.isfinite(t) or not -90 < t < 60) for t in temps) or not any(
                                isinstance(t, (int, float)) and not isinstance(t, bool) and
                                math.isfinite(t) and -90 < t < 60 for t in temps)):
                    return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def workflow_result(updated, message):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write('updated=' + str(updated).lower() + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(message + '\n')


def collect():
    config = json.loads(CONFIG.read_text())
    first = True

    def samples(points):
        nonlocal first
        result = []
        for offset in range(0, len(points), 100):
            if not first:
                time.sleep(12)
            first = False
            chunk = points[offset:offset+100]
            params = {'latitude': ','.join(str(p[0]) for p in chunk),
                      'longitude': ','.join(str(p[1]) for p in chunk),
                      'hourly': 'temperature_2m', 'past_hours': 6,
                      'forecast_hours': 8, 'cell_selection': 'land',
                      'timeformat': 'unixtime', 'timezone': 'UTC'}
            request = urllib.request.Request(
                'https://api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(params),
                headers={'User-Agent': 'NorthernWeather (github.com/Snowblind54/weather-page)'})
            payload = fetch_samples(request)
            items = payload if isinstance(payload, list) else [payload]
            if len(items) != len(chunk):
                raise ValueError('Incomplete temperature samples')
            for point, item in zip(chunk, items):
                hourly = item.get('hourly') or {}
                times = hourly.get('time') or []
                temps = hourly.get('temperature_2m') or []
                if len(times) < 2 or len(times) != len(temps) or any(
                    not isinstance(t, (int, float)) or not math.isfinite(t) or
                    (i and t <= times[i-1]) for i, t in enumerate(times)):
                    raise ValueError('Invalid temperature hours')
                values = [round(t, 2) if isinstance(t, (int, float)) and
                          not isinstance(t, bool) and math.isfinite(t) and -90 < t < 60
                          else None for t in temps]
                if not any(t is not None for t in values):
                    raise ValueError('Empty temperature sample')
                result.append({'lat': point[0], 'lon': point[1], 'times': times, 'temps': values})
        return result

    grids = {}
    for name, (southwest, northeast, lat_step, lon_step) in config['grids'].items():
        lats = axis(southwest[0], northeast[0], lat_step)
        lons = axis(southwest[1], northeast[1], lon_step)
        grids[name] = {'latitudes': lats, 'longitudes': lons,
                       'series': samples([(lat, lon) for lat in lats for lon in lons])}
    return {'version': 1, 'generatedAt': int(dt.datetime.now(dt.timezone.utc).timestamp()),
            'refreshMinutes': 60, 'source': 'Open-Meteo terrain-aware model temperature; not station observations',
            'grids': grids, 'cities': samples(config['cities'])}


def main():
    try:
        data = collect()
    except ProviderUnavailable:
        if not valid_previous_snapshot(OUTPUT):
            raise
        message = 'Temperature provider temporarily unavailable. Kept the last valid European heatmap; its original data timestamp is unchanged.'
        print('::warning::' + message)
        workflow_result(False, message)
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, separators=(',', ':'))+'\n')
    temporary.replace(OUTPUT)
    print('Shared European grid samples:', sum(len(g['series']) for g in data['grids'].values()))
    workflow_result(True, 'Generated fresh European heatmap samples.')


if __name__ == '__main__':
    main()
