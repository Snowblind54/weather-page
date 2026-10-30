"""Official national and airport air temperatures for the southeastern Balkans."""
import datetime as dt
import json
from pathlib import Path
import re
import urllib.parse

import update_official_temperature as core
from eastern_temperature import local_time, number
from moldova_belarus_temperature import normalized
from balkan_temperature import ObservationTable

BOUNDS={'BG':(41.2,44.3,22.2,28.8),'MK':(40.8,42.4,20.4,23.1),
        'AL':(39.6,42.7,19.2,21.1),'XK':(41.8,43.3,20,21.9)}
SOURCES={'BG':'National Institute of Meteorology and Hydrology (NIMH), Bulgaria / official station observations',
         'MK':'Hydrometeorological Service (UHMR), North Macedonia / official station observations; airport METAR/SPECI via NOAA AWC',
         'AL':'Official Albanian airport METAR/SPECI via NOAA AWC and SYNOP observations via DWD (limited coverage)',
         'XK':'Official Pristina International Airport METAR/SPECI via NOAA Aviation Weather Center (limited coverage)'}
URLS={'BG':'https://www.meteo.bg/meteo/en/tochkien','MK':'https://uhmr.gov.mk/aktuelni-podatoci/'}
METAR='https://aviationweather.gov/api/data/metar?'


def station(country,code,m,rows,now,source=None):
    end=int(now.timestamp());max_age=(4 if country=='AL' else 2)*3600
    rows=[(t,v) for t,v in rows if end-86400<=t<=end+60 and v is not None]
    if not rows or max(t for t,v in rows)<end-max_age:return None
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    s=core.make_station(country,code,m['name'],m['lat'],m['lon'],rows)
    if s and source:s['source']=source
    return s


def parse_national(country,raw,metadata,now):
    if country not in URLS:raise ValueError('No national table for country')
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    # UHMR explicitly publishes fixed UTC+1, WITHOUT summer/winter changes.
    if country=='MK' and 'UTC+1' not in text:raise ValueError('UHMR fixed time convention missing')
    p=ObservationTable();p.feed(text);p.finish_cell();p.finish_row()
    by_name={normalized(m['name']):(code,m) for code,m in metadata.items() if not m.get('icao')}
    grouped={};header=False
    for r in p.rows:
        if country=='BG' and len(r)==7 and normalized(r[0])=='станция':
            header='°C' in r[2] and 'Дата' in r[1];continue
        if country=='MK' and len(r)==10 and r[:3]==['ИМЕ','ДЕН','ВРЕМЕ']:
            header=r[4]=='ТЕМПЕРАТУРА';continue
        if not header or len(r)!=(7 if country=='BG' else 10):continue
        found=by_name.get(normalized(r[0]))
        if not found:continue
        code,m=found
        try:
            if country=='BG':
                date=re.fullmatch(r'(\d{2}\.\d{2}\.\d{4})\s*г\.(\d{1,2})ч\.',r[1])
                if not date:continue
                t=local_time(dt.datetime.strptime(date[1]+' '+date[2],'%d.%m.%Y %H'),'Europe/Sofia')
                value=number(r[2].replace(',','.'),-89.99,54.99)
            else:
                t=int(dt.datetime.strptime(r[1]+' '+r[2],'%d.%m.%Y %H:%M').replace(tzinfo=dt.timezone(dt.timedelta(hours=1))).timestamp())
                value=number(r[4].replace(',','.'),-89.99,54.99)
        except ValueError:continue
        grouped.setdefault(code,(m,[]))[1].append((t,value))
    out=[]
    for code,(m,rows) in grouped.items():
        s=station(country,('NIMH-' if country=='BG' else 'UHMR-')+code,m,rows,now)
        if s:out.append(s)
    if not out:raise ValueError('No recent official '+country+' temperatures')
    return out


def parse_airports(country,reports,metadata,now):
    if not isinstance(reports,list) or len(reports)>=400:raise ValueError('Unexpected airport observation product')
    end=int(now.timestamp());grouped={}
    for r in reports:
        if not isinstance(r,dict) or r.get('metarType') not in ('METAR','SPECI'):continue
        code=r.get('icaoId');m=metadata.get(code)
        if not m or m.get('icao')!=code:continue
        t=number(r.get('obsTime'),end-2*3600,end+60);v=number(r.get('temp'),-89.99,54.99)
        if t is None or v is None:continue
        grouped.setdefault(code,(m,[]))[1].append((int(t),v))
    return [s for code,(m,rows) in grouped.items() if (s:=station(country,'AIRPORT-'+code,m,rows,now,
        'Official airport METAR/SPECI temperature via NOAA AWC · '+m['name']))]


def load(country,now,download=core.download):
    if country not in BOUNDS:raise ValueError('Unknown southeastern country')
    meta=json.loads(Path(__file__).with_name('southeast_temperature_stations.json').read_text())['stations'][country]
    out=[]
    if country in URLS:
        try:out.extend(parse_national(country,download(URLS[country]),meta,now))
        except Exception as error:
            if country=='BG':raise
            print('MK national observations unavailable; retaining official airport coverage:',str(error)[:140],flush=True)
    codes=[c for c,m in meta.items() if m.get('icao')]
    if codes:
        try:
            url=METAR+urllib.parse.urlencode({'ids':','.join(sorted(codes)),'format':'json','hours':2})
            out.extend(parse_airports(country,json.loads(download(url)),meta,now))
        except Exception as error:print(country,'official airport observations unavailable:',str(error)[:140],flush=True)
    if country=='AL':
        # Kukës airport's WMO station publishes SYNOP even when no METAR is
        # available. Keep its current AWC airport position, not old city-centre
        # coordinates. The same identity prevents duplicate physical stations.
        try:
            from europe_synop import POI,parse,TEMP
            rows=[(t,v[TEMP]) for t,v in parse(download(POI+'13610-BEOB.csv'),'13610',(TEMP,))]
            s=station('AL','AIRPORT-LAKU',meta['LAKU'],rows,now,'Official Kukës airport WMO 13610 SYNOP temperatures via DWD (three-hourly, UTC)')
            if s:
                previous=next((x for x in out if x['code']==s['code']),None)
                if previous:
                    # SYNOP tenths of a degree supersede rounded airport values
                    # at the same observation time, while newer METARs remain.
                    merged={r[0]:r for r in previous['rows']+s['rows']};s['rows']=[merged[t] for t in sorted(merged)]
                    s['source']='Official Kukës airport SYNOP via DWD and METAR/SPECI via NOAA AWC'
                    out.remove(previous)
                out.append(s)
        except Exception as error:print('AL Kukës SYNOP unavailable:',str(error)[:140],flush=True)
    if not out:raise ValueError('No current official '+country+' station temperatures')
    return out
