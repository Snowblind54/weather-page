"""Official Scottish SYNOP reports distributed by DWD; no model substitutes."""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib

import update_official_wind as core

SOURCE = 'Met Office SYNOP observations distributed by DWD'
PERIOD = '10-minute mean wind at 10 m and maximum gust over the preceding hour. Hourly SYNOP observation times; absent gusts remain unavailable.'
POI = 'https://opendata.dwd.de/weather/weather_reports/poi/'
SPEED = 'mean_wind_speed_during last_10_min_at_10_meters_above_ground'
DIRECTION = 'mean_wind_direction_during_last_10 min_at_10_meters_above_ground'
GUST = 'maximum_wind_speed_last_hour'


def parse_scotland(raw, code, metadata):
    records = list(csv.reader(io.StringIO(raw.decode('latin1') if isinstance(raw, bytes) else raw), delimiter=';'))
    if len(records) < 3 or not {SPEED, DIRECTION, GUST} <= set(records[0]):
        raise ValueError('Scottish SYNOP wind columns missing')
    indices = [records[0].index(k) for k in (SPEED, GUST, DIRECTION)]
    if records[1][0] != code or [records[1][i] for i in indices] != ['km/h', 'km/h', 'Grad']:
        raise ValueError('Scottish SYNOP station or units changed')
    rows = []
    for row in records[3:]:
        if len(row) <= max(indices):
            continue
        try:
            observed = dt.datetime.strptime(row[0]+' '+row[1], '%d.%m.%y %H:%M').replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        speed, gust, direction = [core.number(row[i].replace(',', '.'), 360) for i in indices]
        rows.append((int(observed.timestamp()), None if speed is None else speed/3.6,
                     None if gust is None else gust/3.6, direction))
    item = core.station('GB', 'SYNOP-'+code, metadata['name'], metadata['lat'], metadata['lon'], rows)
    item.update(sourceName=SOURCE, period=PERIOD, gustLabel='Gust max · 1 hour')
    return item


def load_scotland(now):
    metadata = json.loads(pathlib.Path(__file__).with_name('scotland_wind_stations.json').read_text())['stations']
    def collect(pair):
        code, station = pair
        try:
            return parse_scotland(core.download(POI+code+'-BEOB.csv'), code, station)
        except Exception as error:
            print('Scottish SYNOP', code, 'unavailable:', str(error)[:150], flush=True)
            return None
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        stations = [s for s in pool.map(collect, metadata.items()) if s]
    end = int(now.timestamp())
    for s in stations:
        s['rows'] = [r for r in s['rows'] if end-24*3600 <= r[0] <= end+60]
    return [s for s in stations if s['rows'] and s['rows'][-1][0] >= end-3*3600]
