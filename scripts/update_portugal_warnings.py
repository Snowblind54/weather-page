"""Read official IPMA warnings and attach the matching Meteoalarm regions."""
import datetime as dt
import gzip
import json
from pathlib import Path

from update_national_warnings import download_json, timestamp

FEED = 'https://api.ipma.pt/open-data/forecast/warnings/warnings_www.json'
SOURCE_PAGE = 'https://www.ipma.pt/pt/otempo/prev-sam/'
REGIONS = Path(__file__).resolve().parents[1] / 'data/portugal-warning-regions.json.gz'
LEVELS = {'yellow': 'Moderate', 'orange': 'Severe', 'red': 'Extreme'}
EVENTS = {
    'Agitação Marítima': 'Rough seas', 'Neve': 'Snow', 'Nevoeiro': 'Fog',
    'Precipitação': 'Rain', 'Tempo Frio': 'Cold', 'Tempo Quente': 'Heat',
    'Trovoada': 'Thunderstorms', 'Vento': 'Wind',
}


def parse_portugal(payload, regions, now):
    if not isinstance(payload, list) or not payload:
        # A normal quiet feed contains green rows. Keep the previous country
        # snapshot when IPMA returns an empty or unrecognizable response.
        raise ValueError('Unexpected IPMA warning feed')
    records = {}
    for row in payload:
        colour = row['awarenessLevelID'].lower()
        if colour == 'green':
            continue
        level = LEVELS[colour]
        start = timestamp(row['startTime'], 'UTC')
        end = timestamp(row['endTime'], 'UTC')
        if dt.datetime.fromisoformat(end) <= now:
            continue
        if dt.datetime.fromisoformat(start) >= dt.datetime.fromisoformat(end):
            raise ValueError('IPMA warning has an invalid validity interval')
        code = row['idAreaAviso']
        zone = regions.get(code, {})
        hazard = row['awarenessTypeName'].strip()
        event = EVENTS.get(hazard, hazard)
        marine = hazard == 'Agitação Marítima'
        area = zone.get('name', code)
        polygons = zone.get('polygons', [])
        identifier = f'IPMA:{code}:{hazard}:{colour}:{start}:{end}'
        records[identifier] = {
            'country': 'Portugal', 'flag': '🇵🇹', 'identifier': identifier,
            'area': area + (' (coast)' if marine else ''),
            'event': event, 'headline': event + ' warning', 'level': level,
            'officialColour': colour, 'effective': start, 'onset': start, 'expires': end,
            'timeZone': 'Atlantic/Azores' if code in ('ACE', 'AOC', 'AOR') else
                        'Atlantic/Madeira' if code in ('MCN', 'MCS', 'MPS', 'MRM') else 'Europe/Lisbon',
            'description': row['text'].strip(), 'language': 'pt',
            'sourceName': 'IPMA', 'sourceUrl': FEED, 'sourcePage': SOURCE_PAGE,
            'polygons': polygons, 'circles': [], 'marine': marine, 'geometryIncomplete': not polygons,
        }
    return list(records.values())


def load_portugal(now):
    with gzip.open(REGIONS, 'rt', encoding='utf-8') as stream:
        boundaries = json.load(stream)
    return {'country': 'Portugal', 'updatedAt': now.isoformat(), 'source': FEED,
            'boundarySource': boundaries['source'],
            'records': parse_portugal(download_json(FEED), boundaries['regions'], now)}
