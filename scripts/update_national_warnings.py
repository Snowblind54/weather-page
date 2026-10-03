"""Publish official IMGW/DMI warning polygons as browser-safe JSON (stdlib)."""
import concurrent.futures
import datetime as dt
import gzip
import html
import json
import math
import pathlib
import re
import urllib.request
from zoneinfo import ZoneInfo

from update_latvia_warnings import simplify

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/national-warnings.json'
POLAND_FEED = 'https://meteo.imgw.pl/api/meteo/messages/v1/osmet/latest/osmet-teryt'
POLAND_BOUNDARIES = 'https://meteo.imgw.pl/dyn/data/out1proc.json?v=1.2'
DENMARK_FEED = 'https://www.dmi.dk/dmidk_byvejrWS/rest/json/Denmark/GB/WarningAreas'
DENMARK_BOUNDARIES = 'https://www.dmi.dk/fileadmin/templates/warnings/municipalities2.json'


def download_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'BalticWeatherMap/8.13'})
    with urllib.request.urlopen(request, timeout=35) as response:
        raw = response.read()
    if raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def plain(value):
    return html.unescape(re.sub(r'<[^>]*>', ' ', str(value or ''))).strip()


def timestamp(value, timezone):
    if value is None or value == '':
        raise ValueError('Warning validity timestamp missing')
    if isinstance(value, (int, float)):
        date = dt.datetime.fromtimestamp(value / (1000 if value > 1e11 else 1), dt.timezone.utc)
    else:
        date = dt.datetime.fromisoformat(str(value).strip().replace('Z', '+00:00'))
        if date.tzinfo is None:
            date = date.replace(tzinfo=ZoneInfo(timezone))
    return date.isoformat(timespec='seconds')


def polygons(geometry):
    """Keep islands and interior holes; Leaflet expects [latitude, longitude]."""
    kind = geometry.get('type')
    shapes = [geometry['coordinates']] if kind == 'Polygon' else geometry.get('coordinates', [])
    if kind not in ('Polygon', 'MultiPolygon'):
        raise ValueError('Unsupported warning-area geometry')
    result = []
    for shape in shapes:
        rings = []
        for ring in shape:
            points = []
            for lon, lat, *_ in ring:
                if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
                    raise ValueError('Invalid warning-area coordinate')
                points.append([lat, lon])
            if len(points) < 3:
                raise ValueError('Invalid warning-area ring')
            if points[0] != points[-1]:
                points.append(points[0])
            rings.append(simplify(points))
        if not rings:
            raise ValueError('Empty warning-area polygon')
        result.append(rings)
    if not result:
        raise ValueError('Warning polygon missing')
    return result


def severity(level):
    return {1: 'Moderate', 2: 'Severe', 3: 'Extreme'}[int(level)]


def parse_poland(payload, boundaries, now):
    if not isinstance(payload.get('warnings'), dict) or not isinstance(payload.get('teryt'), dict):
        raise ValueError('Unexpected IMGW warning schema')
    areas = {str(f['properties']['jpt_kod_je']).zfill(4): f for f in boundaries.get('features', [])}
    records = []
    for code, identifiers in payload['teryt'].items():
        for identifier in identifiers:
            alert = payload['warnings'].get(str(identifier))
            if not alert or str(alert.get('Level')) not in ('1', '2', '3'):
                continue
            start = timestamp(alert.get('LxValidFrom') or alert.get('ValidFrom'), 'Europe/Warsaw')
            end = timestamp(alert.get('LxValidTo') or alert.get('ValidTo'), 'Europe/Warsaw')
            if dt.datetime.fromisoformat(end) <= now:
                continue
            area = areas.get(str(code).zfill(4))
            if not area:
                raise ValueError('IMGW county geometry missing: ' + str(code))
            records.append({
                'country': 'Poland', 'flag': '🇵🇱', 'identifier': str(identifier) + ':' + str(code),
                'area': plain(area['properties']['jpt_nazwa_']),
                'event': plain(alert.get('PhenomenonName') or 'Weather warning'),
                'headline': plain(alert.get('PhenomenonName') or 'Weather warning'),
                'level': severity(alert['Level']), 'effective': start, 'onset': start, 'expires': end,
                'description': plain(alert.get('Content')), 'instruction': plain(alert.get('Comments')),
                'sourceName': 'IMGW–PIB', 'sourceUrl': POLAND_FEED,
                'sourcePage': 'https://meteo.imgw.pl/dyn/?osmet=true',
                'polygons': polygons(area['geometry']), 'circles': []
            })
    return records


def parse_denmark(payload, boundaries, now):
    if not isinstance(payload.get('warningActual'), list) or not isinstance(payload.get('warning5days'), list):
        raise ValueError('Unexpected DMI warning schema')
    areas = {str(int(f['properties']['komkode'])): f for f in boundaries.get('features', [])}
    records = {}
    for group in payload['warningActual'] + payload['warning5days']:
        for alert in group.get('municipalityWarnings', []):
            level = alert.get('formattedCategory')
            if str(level) not in ('1', '2', '3'):  # Category 0 is a risk advisory, not a warning.
                continue
            start = timestamp(alert.get('validFrom'), 'Europe/Copenhagen')
            end = timestamp(alert.get('validTo'), 'Europe/Copenhagen')
            if dt.datetime.fromisoformat(end) <= now:
                continue
            code = str(int(group['id']))
            area = areas.get(code)
            if not area:
                raise ValueError('DMI municipality/coastal geometry missing: ' + code)
            event = plain(alert.get('warningTitle') or 'Weather warning')
            key = '|'.join([code, event, start, end, str(level)])
            records[key] = {
                'country': 'Denmark', 'flag': '🇩🇰', 'identifier': key,
                'area': plain(group.get('name') or area['properties']['komnavn']),
                'event': event, 'headline': event, 'level': severity(level),
                'effective': start, 'onset': start, 'expires': end,
                'description': plain(alert.get('warningText')), 'instruction': '',
                'sourceName': 'Danish Meteorological Institute (DMI)', 'sourceUrl': DENMARK_FEED,
                'sourcePage': 'https://www.dmi.dk/varsler/warnings/',
                'polygons': polygons(area['geometry']), 'circles': []
            }
    return list(records.values())


def update_country(code, now):
    feed, boundary, parse, name = {
        'PL': (POLAND_FEED, POLAND_BOUNDARIES, parse_poland, 'Poland'),
        'DK': (DENMARK_FEED, DENMARK_BOUNDARIES, parse_denmark, 'Denmark')
    }[code]
    payload = download_json(feed)
    # Avoid downloading boundary data when there are no warning areas.
    populated = bool(payload.get('teryt')) if code == 'PL' else bool(payload.get('warningActual') or payload.get('warning5days'))
    boundaries = download_json(boundary) if populated else {'features': []}
    records = parse(payload, boundaries, now)
    return {'country': name, 'updatedAt': now.isoformat(), 'source': feed,
            'boundarySource': boundary, 'records': records}


def main():
    now = dt.datetime.now(dt.timezone.utc)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {'countries': {}}
    countries = dict(previous.get('countries', {}))
    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {pool.submit(update_country, code, now): code for code in ('PL', 'DK')}
        for job in concurrent.futures.as_completed(jobs):
            code = jobs[job]
            try:
                countries[code] = job.result()
                print(code, len(countries[code]['records']), 'official warning areas')
            except Exception as error:
                # Never freshen an old country snapshot after a failed fetch.
                failed.append(code)
                print(code, 'update failed:', error)
    if len(failed) == 2:
        raise RuntimeError('Both official warning updates failed')
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({'version': 1, 'updatedAt': now.isoformat(), 'countries': countries},
                                 ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
