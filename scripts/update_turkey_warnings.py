"""Official MGM MeteoUYARI warnings, joined to individual warned districts."""
import datetime as dt
import gzip
import json
from pathlib import Path
import re

from mediterranean_temperature import download_turkey

BASE='https://servis.mgm.gov.tr/web/meteoalarm/'
PAGE='https://www.mgm.gov.tr/meteouyari/turkiye.aspx'
REGIONS=Path(__file__).resolve().parents[1]/'data/southern-warning-regions.json.gz'
EVENTS={'thunderstorm':'Thunderstorm','rain':'Rain','wind':'Wind','snow':'Snow',
        'snowice':'Snow / ice','ice':'Ice','fog':'Fog','hightemperature':'High temperature',
        'lowtemperature':'Low temperature','avalanche':'Avalanche','flood':'Flood',
        'forestfire':'Forest fire','dust':'Dust'}
LEVELS={'yellow':'Moderate','orange':'Severe','red':'Extreme'}


def instant(value):
    if not isinstance(value,str):raise ValueError('MGM warning time missing')
    time=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    if time.tzinfo is None:raise ValueError('MGM warning time lacks timezone')
    return time


def parse(payload,catalogue,now):
    if not isinstance(payload,list) or len(payload)>2000:raise ValueError('MGM warning list changed')
    metadata={**catalogue['turkeyDistricts'],**catalogue.get('unmappedTurkishDistricts',{})}
    regions=catalogue['regions']['TR'];records={}
    for alert in payload:
        if not isinstance(alert,dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(alert.get('_id',''))):raise ValueError('MGM warning identity missing')
        start,end=instant(alert.get('begin')),instant(alert.get('end'))
        if start>=end:raise ValueError('Invalid MGM warning validity')
        if end<=now:continue
        issued=instant(alert['insertDate']) if alert.get('insertDate') else start
        if alert.get('insertDate') and issued>now+dt.timedelta(minutes=5):raise ValueError('Future MGM warning issue time')
        towns,weather,text=alert.get('towns'),alert.get('weather'),alert.get('text')
        if not all(isinstance(x,dict) for x in (towns,weather,text)):raise ValueError('MGM warning fields changed')
        for colour,level in LEVELS.items():
            codes,events=towns.get(colour),weather.get(colour)
            if not isinstance(codes,list) or len(codes)>1000 or not isinstance(events,list) or any(not isinstance(e,str) for e in events):raise ValueError('MGM warning district/event list changed')
            if not codes:continue
            description=text.get(colour)
            if not events or not isinstance(description,str) or not description.strip():raise ValueError('MGM warning text missing')
            event=', '.join(EVENTS.get(e,e) for e in dict.fromkeys(events))
            for value in dict.fromkeys(codes):
                if isinstance(value,bool) or not re.fullmatch(r'9\d{4}',str(value)):raise ValueError('Invalid MGM warning district code')
                code=str(value);m=metadata.get(code)
                if m is None:raise ValueError('Unknown MGM district '+code+'; retaining previous complete country update')
                shapes=regions.get('MGM:'+code,[]);identifier=str(alert['_id'])+':'+colour+':'+code
                record=dict(country='Turkey',flag='🇹🇷',identifier=identifier,capIdentifier=str(alert['_id']),
                    area=m['name']+' · '+m['province'],event=event,headline=colour.title()+' '+event+' warning · '+m['name']+', '+m['province'],
                    level=level,officialSeverity=colour,language='tr-TR',effective=issued.isoformat(),onset=start.isoformat(),expires=end.isoformat(),
                    description=description.strip(),instruction='',certainty='',timeZone='Europe/Istanbul',
                    sourceName='Meteoroloji Genel Müdürlüğü (MGM) / MeteoUYARI',sourceUrl=BASE+'today',
                    sourcePage='https://www.mgm.gov.tr/meteouyari/Il.aspx?id='+code[:3]+'01',
                    polygons=shapes,circles=[],marine=False,geometryIncomplete=not bool(shapes),officialDistrictCode=code)
                records[identifier]=record
    return list(records.values())


def load_turkey(now,download=download_turkey):
    catalogue=json.loads(gzip.decompress(REGIONS.read_bytes()))
    # Fetch both complete daily lists. A failed half never freshens old data.
    today=json.loads(download(BASE+'today'));tomorrow=json.loads(download(BASE+'tomorrow'))
    records={}
    for payload in (today,tomorrow):
        for record in parse(payload,catalogue,now):records[record['identifier']]=record
    return dict(country='Turkey',updatedAt=now.isoformat(),source=PAGE,records=list(records.values()))
