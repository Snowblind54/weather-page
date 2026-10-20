"""Official measured winds for the Faroes, UK airports and Irish stations."""
import urllib.parse
import update_official_wind as core
from official_wind_americas import features, interval, DMI
from official_wind_us import parse_us_metars

NOAA = 'https://aviationweather.gov/data/cache/'
IRELAND = 'https://opendata2.met.ie/edr/collections/observations-swob-nrt-60min/'


def load_faroes(now):
    metadata = {'features':[f for f in features(DMI+'station/items',
        {'bbox':'-8,61,-6,63','limit':1000})
        if (f.get('properties') or {}).get('status') == 'Active']}
    payloads = {p:{'features':list(features(DMI+'observation/items',
        {'bbox':'-8,61,-6,63','datetime':interval(now),'parameterId':p,'limit':10000}))}
        for p in ('wind_speed','wind_gust_always_past1h','wind_dir')}
    return core.parse_denmark(payloads, metadata, country='FO', provider_country='FRO',
                             now=now, owners=('DMI','Havne Kommuner mv'))


def load_britain(now):
    from official_wind_scotland import load_scotland
    results = []
    try:
        payload = core.download_json(NOAA+'stations.cache.json.gz')
        if not isinstance(payload, list):
            raise ValueError('Invalid NOAA station metadata')
        metadata = {s['icaoId']:s for s in payload if s.get('icaoId') and s.get('country') == 'GB'}
        results = parse_us_metars(core.download(NOAA+'metars.cache.csv.gz'), metadata, now, country='GB')
        for s in results:
            s.update(sourceName='Official UK airport METAR/SPECI observations via NOAA Aviation Weather Center',
                     period='Airport mean wind and reported METAR/SPECI gusts. Unreported gusts remain unavailable.',
                     gustLabel='Reported METAR gust')
    except Exception as error:
        print('UK airport wind unavailable:', str(error)[:150], flush=True)
    results.extend(load_scotland(now))
    if not results:
        raise ValueError('No recent UK airport or Scottish SYNOP wind observations')
    return results


def parse_ireland(observations, metadata):
    # The provider's hourly mean and hourly maximum gust are both in knots.
    # Align parameters at their exact observation timestamp, preserving gaps.
    indexes = {'wind_speed_mean':1, 'wind_gust':2, 'wind_direction':3}
    grouped = {}
    for f in observations:
        p = f.get('properties') or {}
        code, parameter = str(p.get('station_id') or ''), p.get('parameter_name')
        if code not in metadata or parameter not in indexes:
            continue
        try:
            stamp = core.timestamp(p.get('observed_at'))
        except (ValueError, TypeError, OverflowError):
            continue
        value = core.number(p.get('value_num'), 360 if parameter == 'wind_direction' else 200)
        if value is not None and parameter != 'wind_direction':
            value *= 1852/3600
        grouped.setdefault(code, {}).setdefault(stamp, [stamp,None,None,None])[indexes[parameter]] = value
    out = []
    for code, rows in grouped.items():
        f = metadata[code]
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if len(coords) < 2:
            continue
        item = core.station('IE', code, f['properties'].get('station_name') or code,
                            coords[1], coords[0], rows.values())
        if item['rows']:
            out.append(item)
    return out


def load_ireland(now):
    locations = core.download_json(IRELAND+'locations?f=json')
    metadata = {str(f['properties']['station_id']):f for f in locations.get('features', [])
                if (f.get('properties') or {}).get('station_id') is not None}
    params = {'datetime':interval(now),'parameter-name':'wind_speed_mean,wind_gust,wind_direction',
              'f':'geojson','limit':10000}
    observations = []
    for page in range(4):
        payload = core.download_json(IRELAND+'items?'+urllib.parse.urlencode(params | {'offset':page*10000}))
        batch = payload.get('features') or []
        observations.extend(batch)
        if len(batch) < 10000:
            return parse_ireland(observations, metadata)
    raise ValueError('Irish wind pagination exceeded recent window')
