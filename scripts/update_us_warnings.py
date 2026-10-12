"""Official NOAA/NWS CAP alerts and cached NWS warning-zone boundaries."""
import datetime as dt
import gzip
import json
import pathlib
import re
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import update_national_warnings as core

API = 'https://api.weather.gov/'
ALERTS = API+'alerts?active=true&status=actual&limit=500'
GIS = 'https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/'
CACHE = pathlib.Path(__file__).resolve().parents[1]/'data/nws-warning-zones.json'
ZONE_TTL = 7*86400


def download_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'NorthWeather (https://northweather.app)',
                                               'Accept': 'application/geo+json, application/json', 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=45) as response:
        raw = response.read(24*1024*1024+1)
    if len(raw)>24*1024*1024:
        raise ValueError('NWS response exceeds bounded size')
    if raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def active_alerts():
    features, seen, url = [], set(), ALERTS
    while url:
        p = urllib.parse.urlparse(url)
        if p.scheme!='https' or p.netloc!='api.weather.gov' or p.path not in ('/alerts', '/alerts/active') or url in seen or len(seen)>=20:
            raise ValueError('Unexpected NWS alert pagination URL')
        seen.add(url)
        page = download_json(url)
        if page.get('type')!='FeatureCollection' or not isinstance(page.get('features'), list):
            raise ValueError('Invalid NWS alert collection')
        features.extend(page['features'])
        url = (page.get('pagination') or {}).get('next')
        if url:
            url = urllib.parse.urljoin(API, url)
    return features


def zone_parts(url):
    p = urllib.parse.urlparse(str(url))
    m = re.fullmatch(r'/zones/(forecast|county|fire|marine|public|coastal|offshore)/([A-Z]{2}[CZ]\d{3})', p.path)
    if p.scheme!='https' or p.netloc!='api.weather.gov' or not m or p.query or p.fragment:
        raise ValueError('Invalid NWS affected-zone URL')
    return m.groups()


def resolve_zones(urls, now):
    try:
        data = json.loads(CACHE.read_text())
        cached = data.get('zones', {}) if data.get('version')==1 else {}
    except (OSError, ValueError):
        cached = {}
    stamp = int(now.timestamp())
    # Bound cache growth to zones used recently; this file is an Actions input,
    # not a separately uploaded R2 object for every warning area.
    cached = {k:v for k,v in cached.items() if stamp-v.get('fetchedAt', 0)<30*86400}
    pending = {}
    for url in sorted(set(urls)):
        kind, code = zone_parts(url)
        if url not in cached or stamp-cached[url].get('fetchedAt', 0)>=ZONE_TTL:
            pending.setdefault(kind, []).append((url,code))
    metadata = {}
    for kind, items in pending.items():
        for offset in range(0,len(items),50):
            batch = items[offset:offset+50]
            query = urllib.parse.urlencode({'id': ','.join(c for _,c in batch), 'include_geometry': 'true'})
            page = download_json(API+'zones/'+kind+'?'+query)
            if page.get('type')!='FeatureCollection':
                raise ValueError('Invalid NWS zone metadata')
            by_code = {(f.get('properties') or {}).get('id'):f for f in page.get('features', [])}
            for url, code in batch:
                f = by_code.get(code)
                if f:
                    metadata[url] = f

    groups = {}
    for url, f in metadata.items():
        p = f.get('properties') or {}
        if f.get('geometry'):
            cached[url] = {'polygons':core.polygons(f['geometry']), 'timeZones':p.get('timeZone') or [], 'fetchedAt':stamp}
            continue
        kind, code = zone_parts(url)
        zone_type = p.get('type') or kind
        layer = 2 if zone_type=='county' else 9 if zone_type=='fire' else 6 if zone_type=='offshore' else 5 if zone_type in ('marine','coastal') else 8
        groups.setdefault(layer, []).append((url,code,p))
    for layer, items in groups.items():
        for offset in range(0,len(items),50):
            batch = items[offset:offset+50]
            if layer==2:
                where = ' OR '.join("(state='%s' AND fips LIKE '%%%s')" % (code[:2],code[-3:]) for _,code,_ in batch)
            else:
                field = 'state_zone' if layer in (8,9) else 'id'
                where = field+' IN ('+','.join("'"+(code[:2]+code[3:] if layer in (8,9) else code)+"'" for _,code,_ in batch)+')'
            q = urllib.parse.urlencode({'where':where,'outFields':'*','returnGeometry':'true','outSR':4326,
                                       'maxAllowableOffset':.0007,'f':'geojson'})
            page = download_json(GIS+str(layer)+'/query?'+q)
            if page.get('type')!='FeatureCollection' or page.get('exceededTransferLimit'):
                raise ValueError('NWS boundary query incomplete')
            shapes = {}
            for f in page.get('features', []):
                p = f.get('properties') or {}
                code = p.get('state_zone') or p.get('id')
                if layer in (8,9) and code and re.fullmatch(r'[A-Z]{2}\d{3}',code):
                    code = code[:2]+'Z'+code[2:]
                if layer==2:
                    code = str(p.get('state') or '')+'C'+str(p.get('fips') or '')[-3:]
                if code and f.get('geometry'):
                    shapes.setdefault(code, []).extend(core.polygons(f['geometry']))
            for url,code,p in batch:
                if shapes.get(code):
                    cached[url] = {'polygons':shapes[code], 'timeZones':p.get('timeZone') or [], 'fetchedAt':stamp}
    # An unusual/new zone absent from the bulk boundary service can still be
    # obtained from its canonical NWS resource. No guessed rectangles are used.
    CACHE.parent.mkdir(parents=True,exist_ok=True)
    CACHE.write_text(json.dumps({'version':1,'zones':cached},separators=(',',':'))+'\n')
    missing = [url for url in urls if url not in cached]
    for url in missing[:12]:
        try:
            f = download_json(url)
            if f.get('geometry'):
                cached[url] = {'polygons':core.polygons(f['geometry']),
                               'timeZones':(f.get('properties') or {}).get('timeZone') or [], 'fetchedAt':stamp}
        except Exception as error:
            print('NWS boundary unavailable:',url,str(error)[:100])
    CACHE.parent.mkdir(parents=True,exist_ok=True)
    CACHE.write_text(json.dumps({'version':1,'zones':cached},separators=(',',':'))+'\n')
    return {url:cached[url] for url in urls if url in cached}


def alert_type(event):
    for word in ('Warning','Watch','Advisory','Statement','Outlook'):
        if word.lower() in event.lower():
            return word
    return 'Alert'


def parse_alerts(features, zones, now):
    records = {}
    superseded = set()
    for f in features:
        p = f.get('properties') or {}
        if p.get('status')=='Actual' and p.get('messageType') in ('Update','Cancel'):
            superseded.update(str(r.get('identifier') or '') for r in p.get('references') or [])
    for f in features:
        p = f.get('properties') or {}
        if p.get('status')!='Actual' or p.get('messageType') not in ('Alert','Update') or p.get('category') not in ('Met','Geo','Env'):
            continue
        identifier = str(p.get('id') or f.get('id') or '')
        if not identifier or identifier in superseded:
            continue
        message_end = core.timestamp(p.get('expires'),'UTC')
        end = core.timestamp(p.get('ends') or p.get('expires'),'UTC')
        if min(dt.datetime.fromisoformat(message_end),dt.datetime.fromisoformat(end))<=now:
            continue
        issued = core.timestamp(p.get('effective') or p.get('sent'),'UTC')
        start = core.timestamp(p.get('onset') or p.get('effective') or p.get('sent'),'UTC')
        area_zones = [zones[z] for z in p.get('affectedZones') or [] if z in zones]
        shape = core.polygons(f['geometry']) if f.get('geometry') else [poly for z in area_zones for poly in z['polygons']]
        timezones = list(dict.fromkeys(tz for z in area_zones for tz in z.get('timeZones', [])))
        # Official warning-zone IANA names include DST. A marine alert with no
        # named local zone uses UTC and is labelled explicitly in its popup.
        timezones = [tz for tz in timezones if valid_timezone(tz)]
        event = core.plain(p.get('event') or 'Weather alert')
        raw_severity = p.get('severity') or 'Unknown'
        records[identifier] = {
            'country':'USA','flag':'🇺🇸','identifier':identifier,'area':core.plain(p.get('areaDesc')),
            'event':event,'headline':core.plain(p.get('headline') or event),'alertType':alert_type(event),
            'level':{'Extreme':'Extreme','Severe':'Severe','Moderate':'Moderate'}.get(raw_severity,'Information'),
            'officialSeverity':raw_severity,'certainty':p.get('certainty'),'urgency':p.get('urgency'),
            'effective':issued,'onset':start,'expires':end,'messageExpires':message_end,
            'timeZone':timezones[0] if timezones else 'UTC','timeZones':timezones,
            'marine':any(code[:2] in ('AM','AN','GM','LC','LE','LH','LM','LO','LS','PH','PK','PM','PS','PZ') for _,code in (zone_parts(z) for z in p.get('affectedZones') or [])) or 'marine' in event.lower(),
            'description':core.plain(p.get('description')),'instruction':core.plain(p.get('instruction')),
            'sourceName':'NOAA / National Weather Service','sourceUrl':ALERTS,
            'sourcePage':API+'alerts/'+urllib.parse.quote(identifier,safe=':'),
            'polygons':shape,'circles':[],
            'geometryIncomplete':not f.get('geometry') and any(z not in zones for z in p.get('affectedZones') or []),
        }
    return list(records.values())


def valid_timezone(name):
    try:
        ZoneInfo(name)
        return True
    except (ValueError,KeyError):
        return False


def load_usa(now):
    features = active_alerts()
    urls = sorted({z for f in features for z in (f.get('properties') or {}).get('affectedZones', [])})
    zones = resolve_zones(urls,now) if urls else {}
    records = parse_alerts(features,zones,now)
    return {'country':'USA','updatedAt':now.isoformat(),'source':ALERTS,'boundarySource':GIS,
            'unmappedCount':sum(not r['polygons'] for r in records),
            'partialCount':sum(r['geometryIncomplete'] and bool(r['polygons']) for r in records),'records':records}
