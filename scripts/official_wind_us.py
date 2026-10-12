"""Bulk official NOAA METAR/SPECI wind observations for the 50 US states."""
import csv
import io

import update_official_wind as core
import update_us_temperature as noaa


def parse_us_metars(raw, metadata, now):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else str(raw)
    lines = text.splitlines()
    header = next((i for i, line in enumerate(lines) if line.startswith('raw_text,station_id,')), None)
    if header is None:
        raise ValueError('NOAA METAR wind cache header missing')
    grouped = {}
    current = int(now.timestamp())
    for row in csv.DictReader(io.StringIO('\n'.join(lines[header:]))):
        code = row.get('station_id')
        meta = metadata.get(code)
        if not meta or meta.get('country') != 'US' or meta.get('state') not in noaa.US_STATES:
            continue
        if row.get('metar_type') not in ('METAR', 'SPECI'):
            continue
        try:
            observed = core.timestamp(row.get('observation_time') or '')
        except (ValueError, TypeError, OverflowError):
            continue
        if not current-3*3600 <= observed <= current+60:
            continue
        def knots(field):
            value = core.number(row.get(field), 200)
            return None if value is None else value*1852/3600
        # A blank/VRB direction and an unreported gust remain null. Calm zero
        # winds are real observations; never infer gusts from sustained wind.
        reading = (observed, knots('wind_speed_kt'), knots('wind_gust_kt'), core.number(row.get('wind_dir_degrees'), 360))
        try:
            item = core.station('US', code, meta.get('site') or code,
                                meta.get('lat'), meta.get('lon'), [reading])
        except (ValueError, TypeError):
            continue
        if not item['rows']:
            continue
        if code not in grouped:
            grouped[code] = item
        else:
            rows = {r[0]: r for r in grouped[code]['rows']+item['rows']}
            grouped[code]['rows'] = [rows[t] for t in sorted(rows)]
    if not grouped:
        raise ValueError('No recent NOAA US wind observations')
    return list(grouped.values())


def load_usa(now):
    metadata = noaa.station_metadata()
    raw = core.download(noaa.CACHE_BASE+'metars.cache.csv.gz')
    return parse_us_metars(raw, metadata, now)
