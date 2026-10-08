"""Official Greenland (DMI) and Canadian ECCC/MSC station temperatures."""
import datetime as dt
import urllib.parse

import update_official_temperature as core

DMI = 'https://opendataapi.dmi.dk/v2/metObs/collections/'
GEOMET = 'https://api.weather.gc.ca/collections/'

def recent_interval():
    now = dt.datetime.now(dt.timezone.utc)
    return (now-dt.timedelta(hours=3)).isoformat()+'/'+now.isoformat()

def features(url, params):
    # Follow the provider's pagination rather than silently truncating stations.
    url += '?' + urllib.parse.urlencode(params)
    for _ in range(12):
        payload = core.download_json(url, 50)
        yield from payload.get('features') or []
        next_url = next((l.get('href') for l in payload.get('links', []) if l.get('rel')=='next'), None)
        if not next_url:
            return
        if not next_url.startswith((DMI, GEOMET)):
            raise ValueError('Unexpected temperature pagination host')
        url = next_url
    raise ValueError('Temperature pagination exceeded bounded recent window')

def parse_greenland():
    metadata = {}
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    for f in features(DMI+'station/items', {'bbox':'-74,59,-10,84','limit':1000}):
        p = f.get('properties') or {}
        if p.get('country')!='GRL' or p.get('status')!='Active':
            continue
        start, end = core.stamp(p.get('validFrom')), core.stamp(p.get('validTo'))
        if (start is not None and start>now) or (end is not None and end<=now):
            continue
        code = str(p.get('stationId') or '')
        if code not in metadata or (core.stamp(metadata[code].get('validFrom')) or 0)<(start or 0):
            metadata[code] = p
    grouped = {}
    for f in features(DMI+'observation/items', {'parameterId':'temp_dry','bbox':'-74,59,-10,84','datetime':recent_interval(),'limit':10000}):
        p = f.get('properties') or {}
        code = str(p.get('stationId') or '')
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if p.get('parameterId')!='temp_dry' or code not in metadata or len(coords)<2:
            continue
        grouped.setdefault(code, [coords[1],coords[0],[]])[2].append((p.get('observed'),p.get('value')))
    out = [core.make_station('GL',code,metadata[code].get('name'),lat,lon,rows) for code,(lat,lon,rows) in grouped.items()]
    out = [s for s in out if s]
    if not out:
        raise ValueError('No recent DMI Greenland temperatures')
    return out

def parse_canada():
    metadata = {}
    for f in features(GEOMET+'swob-stations/items', {'limit':1000,'f':'json'}):
        p = f.get('properties') or {}
        if p.get('data_provider')=='MSC':
            metadata[str(p.get('msc_id') or f.get('id') or '')] = p
    grouped = {}
    params = {'datetime':recent_interval(),'limit':10000,'f':'json','_is-minutely_obs-value':'false',
              'properties':'stn_nam-value,msc_id-value,obs_date_tm,air_temp,air_temp-qa,air_temp-uom',
              'sortby':'-obs_date_tm'}
    for f in features(GEOMET+'swob-realtime/items', params):
        p = f.get('properties') or {}
        code = str(p.get('msc_id-value') or '')
        coords = (f.get('geometry') or {}).get('coordinates') or []
        # MSC-owned stations only; missing or failed quality checks never become zero.
        if code not in metadata or len(coords)<2 or p.get('air_temp-uom')!='°C' or p.get('air_temp-qa')!=100:
            continue
        grouped.setdefault(code, [coords[1],coords[0],[]])[2].append((p.get('obs_date_tm'),p.get('air_temp')))
    out = [core.make_station('CA',code,metadata[code].get('name'),lat,lon,rows) for code,(lat,lon,rows) in grouped.items()]
    out = [s for s in out if s]
    if not out:
        raise ValueError('No recent ECCC/MSC Canadian temperatures')
    return out

core.SOURCES.update({'GL':'Danish Meteorological Institute (DMI)', 'CA':'Environment and Climate Change Canada / MSC'})
core.LOADERS.update({'GL':parse_greenland,'CA':parse_canada})
