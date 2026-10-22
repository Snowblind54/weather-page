"""Official Meteo.ad current observations; page timestamps explicitly use UTC.

Use the current temperature (0) and sustained wind (4) fields only. Field 5
is a daily maximum, not a current gust. Verified geographic coordinates come
from the national service's station pages, never its map's pixel positions.
"""
import datetime as dt
import html
import json
import math
from pathlib import Path
import re

SOURCE = 'Servei Meteorològic Nacional (Andorra) / Meteo.ad'
BASE = 'https://www.meteo.ad/'
URL = BASE + 'home/DadesActuals?idioma=0&pestanya={field}&privat=&data=&esDiaries=false'
BOUNDS = (42.4, 42.7, 1.4, 1.8)


def text(value):
    # Meteo.ad JSON includes an extra layer of literal Unicode escapes.
    value = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m[1], 16)), str(value))
    return html.unescape(re.sub(r'<[^>]*>', ' ', value)).strip()


def parse(payload, field, now, metadata=None):
    if field not in (0, 4) or not isinstance(payload, list):
        raise ValueError('Invalid Andorra current observation response')
    if metadata is None:
        metadata = json.loads(Path(__file__).with_name('andorra_stations.json').read_text())['stations']
    end = int(now.timestamp())
    out = []
    for row in payload:
        if not isinstance(row, list) or len(row) < 5:
            continue
        code = str(row[0]); meta = metadata.get(code)
        if not meta:
            continue
        south, north, west, east = BOUNDS
        if not (south <= meta['lat'] <= north and west <= meta['lon'] <= east):
            continue
        date = re.search(r'(\d{2}/\d{2}/\d{4})\s+(\d{2}:\d{2})\s*\(UTC\)', text(row[1]))
        if not date:
            continue
        try:
            stamp = int(dt.datetime.strptime(' '.join(date.groups()), '%d/%m/%Y %H:%M').replace(tzinfo=dt.timezone.utc).timestamp())
        except ValueError:
            continue
        if not end-2*3600 <= stamp <= end+60:
            continue
        value = text(row[4]).replace(',', '.')
        pattern = r'(-?\d+(?:\.\d+)?)\s*[º°]C' if field == 0 else r'(\d+(?:\.\d+)?)\s*[º°]\s*\|\s*(\d+(?:\.\d+)?)\s*m/s'
        match = re.fullmatch(pattern, value)
        if not match:
            continue
        numbers = [float(v) for v in match.groups()]
        if not all(math.isfinite(v) for v in numbers):
            continue
        if field == 0 and not -90 < numbers[0] < 55:
            continue
        if field == 4 and not (0 <= numbers[0] <= 360 and 0 <= numbers[1] <= 100):
            continue
        out.append(dict(code=code, **meta, time=stamp,
                        temperature=numbers[0] if field == 0 else None,
                        speed=numbers[1] if field == 4 else None,
                        direction=numbers[0] if field == 4 else None))
    if not out:
        raise ValueError('No recent official Andorran '+('temperature' if field == 0 else 'wind')+' observations')
    return out


def load_temperature(now, download_json):
    import update_official_temperature as core
    out = []
    for row in parse(download_json(URL.format(field=0)), 0, now):
        item = core.make_station('AD', row['code'], row['name'], row['lat'], row['lon'], [(row['time'], row['temperature'])])
        if item:
            item['source'] = SOURCE; out.append(item)
    return out


def load_wind(now, download_json):
    import update_official_wind as core
    out = []
    for row in parse(download_json(URL.format(field=4)), 4, now):
        item = core.station('AD', row['code'], row['name'], row['lat'], row['lon'], [(row['time'], row['speed'], None, row['direction'])])
        height = row['windHeightM']
        item.update(sourceName=SOURCE, sourceUrl=row['sourceUrl'],
                    gustLabel='Current gust unavailable', windHeightM=height,
                    heatmapEligible=height == 10,
                    period='Official measured sustained wind at '+(str(height)+' m' if height else 'the native station sensor height')+'. Native UTC observation time. Current gusts are not provided; daily maximum wind is not substituted.')
        out.append(item)
    return out
