"""Publish LVGMC's public warning feed as browser-readable JSON (stdlib only)."""
import concurrent.futures
import datetime as dt
import json
import math
import pathlib
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = 'https://bridinajumi.meteo.lv/'
OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/latvia-warnings.json'
NS = {'cap': 'urn:oasis:names:tc:emergency:cap:1.2'}


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'BalticWeatherMap/8.9'})
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read()


def text(element, name):
    return (element.findtext('cap:' + name, default='', namespaces=NS) or '').strip()


def simplify(points, tolerance=0.0007):
    """Ramer-Douglas-Peucker: retain the outline within roughly 80 m."""
    if len(points) < 4:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        a, b = points[start], points[end]
        dy, dx = b[0] - a[0], b[1] - a[1]
        length2 = dy * dy + dx * dx
        maximum, index = 0, None
        for i in range(start + 1, end):
            p = points[i]
            fraction = max(0, min(1, ((p[0] - a[0]) * dy + (p[1] - a[1]) * dx) / length2)) if length2 else 0
            distance2 = (p[0] - a[0] - fraction * dy) ** 2 + (p[1] - a[1] - fraction * dx) ** 2
            if distance2 > maximum:
                maximum, index = distance2, i
        if index is not None and maximum > tolerance * tolerance:
            keep.add(index)
            stack.extend([(start, index), (index, end)])
    result = [[round(value, 5) for value in points[i]] for i in sorted(keep)]
    return result if len(result) >= 4 else points


def polygon(value):
    points = []
    for pair in (value or '').split():
        coords = pair.split(',')
        if len(coords) != 2:
            raise ValueError('Invalid Latvian warning polygon')
        lat, lon = map(float, coords)
        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError('Invalid Latvian warning coordinates')
        points.append([lat, lon])
    if len(points) < 3:
        return None
    if points[0] != points[-1]:
        points.append(points[0])
    return simplify(points)


def parse_cap(payload, url, now):
    root = ET.fromstring(payload)
    if root.tag != '{' + NS['cap'] + '}alert':
        raise ValueError('Expected an LVGMC CAP alert')
    if text(root, 'status').lower() not in ('', 'actual') or text(root, 'msgType').lower() == 'cancel':
        return None
    infos = root.findall('cap:info', NS)
    if not infos:
        raise ValueError('LVGMC alert has no info')
    info = next((i for i in infos if text(i, 'language').lower().startswith('en')), infos[0])
    expires = text(info, 'expires')
    if expires and dt.datetime.fromisoformat(expires.replace('Z', '+00:00')) <= now:
        return None
    level = text(info, 'severity')
    if level.lower() not in ('moderate', 'severe', 'extreme'):
        return None
    areas = info.findall('cap:area', NS)
    # LVGMC wraps coordinates in polygonDesc, rather than directly in area.
    # Use one language block so translated duplicates are never drawn twice.
    polygons = [polygon(p.text) for p in info.findall('.//cap:polygon', NS)]
    polygons = [p for p in polygons if p]
    if not polygons:
        raise ValueError('LVGMC warning has no usable polygons')
    polygons = list({json.dumps(p): p for p in polygons}.values())
    return {
        'country': 'Latvia', 'flag': '🇱🇻', 'sourceSlug': 'latvia',
        'sourceName': 'Latvian Environment, Geology and Meteorology Centre (LVĢMC)',
        'identifier': text(root, 'identifier'), 'sent': text(root, 'sent'),
        'event': text(info, 'event'), 'headline': text(info, 'headline') or text(info, 'event'),
        'level': level, 'description': text(info, 'description'),
        'instruction': text(info, 'instruction') or text(info, 'risks'),
        'effective': text(info, 'onset') or text(info, 'effective'), 'expires': expires,
        'area': '; '.join(filter(None, (text(a, 'areaDesc') for a in areas))),
        'polygons': polygons, 'circles': [], 'capUrl': url,
    }


def cap_url(path):
    url = urllib.parse.urljoin(BASE, path)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'bridinajumi.meteo.lv' or not parsed.path.startswith('/data/publishedCap/'):
        raise ValueError('Unexpected LVGMC CAP URL')
    return urllib.parse.urlunsplit(parsed._replace(path=urllib.parse.quote(urllib.parse.unquote(parsed.path))))


def main():
    now = dt.datetime.now(dt.timezone.utc)
    paths = json.loads(download(BASE + 'list.php'))
    if paths is None:
        paths = []  # Official site uses null for an empty warning list.
    if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths):
        raise ValueError('Invalid LVGMC warning index')
    urls = list(dict.fromkeys(cap_url(path) for path in paths))
    def load(url):
        return parse_cap(download(url), url, now)
    # Any download/parser failure leaves the previous complete snapshot intact.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = [r for r in pool.map(load, urls) if r]
    data = {'version': 1, 'updatedAt': now.isoformat(), 'source': BASE,
            'records': records, 'simplificationDegrees': 0.0007}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    print(f'Updated Latvia: {len(records)} warnings, {sum(len(r["polygons"]) for r in records)} polygons')


if __name__ == '__main__':
    main()
