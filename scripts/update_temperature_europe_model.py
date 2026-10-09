"""Publish one terrain-aware European heatmap snapshot, including city samples.

Retain the existing grid spacing and land-cell selection. Failed collections
never replace the previous successful snapshot.
"""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request
from update_temperature_americas_model import axis

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/temperature-europe-model.json'
CONFIG = ROOT / 'scripts/temperature_europe_points.json'


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
            with urllib.request.urlopen(request, timeout=50) as response:
                payload = json.load(response)
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


if __name__ == '__main__':
    data = collect()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, separators=(',', ':'))+'\n')
    temporary.replace(OUTPUT)
    print('Shared European grid samples:', sum(len(g['series']) for g in data['grids'].values()))
