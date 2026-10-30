"""Measured temperatures from the public AMM and Belhydromet station maps."""
import datetime as dt
import html
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import unquote

import update_official_temperature as core
from eastern_temperature import local_time, number

BOUNDS={'MD':(45.4,48.6,26.5,30.3),'BY':(51.2,56.3,23,33)}
SOURCES={'MD':'Autoritatea de Meteorologie și Monitoring de Mediu (AMM), Moldova / current station observations',
         'BY':'Belhydromet / official SYNOP station observations via pogoda.by'}
MD_URL='https://www.meteo.md/'
BY_URL='https://pogoda.by/api/v2/meteo-observation/map/by'


def station(country,code,name,lat,lon,rows,now):
    end=int(now.timestamp());age=(4 if country=='BY' else 2)*3600
    rows=[(t,v) for t,v in rows if end-86400<=t<=end+60 and v is not None]
    if not rows or max(t for t,v in rows)<end-age:return None
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    return core.make_station(country,code,name,lat,lon,rows)


def normalized(text):
    text=html.unescape(re.sub('<[^>]+>',' ',text))
    return ''.join(c for c in unicodedata.normalize('NFKD',text).casefold() if c.isalnum() and not unicodedata.combining(c))


def parse_moldova(raw,metadata,now):
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    # This is the dated CURRENT station map on the homepage; do not read the
    # separate multi-day forecast, apparent temperature, or undated top widget.
    section=re.search(r'<section\s+class="forecast"\s*>(.*?)</section>',text,re.S)
    if not section:raise ValueError('AMM current station section missing')
    heading=re.search(r'<h1>\s*Moldova,.*?(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})\s*</h1>',section[1],re.S)
    current=re.search(r'<ul\s+class="weather-map"\s*>(.*?)</ul>',section[1],re.S)
    if not heading or not current:raise ValueError('AMM dated current station map missing')
    date=dt.datetime.strptime(heading[1],'%d.%m.%Y %H:%M')
    by_name={normalized(s['name']):(code,s) for code,s in metadata.items()}
    out=[];seen=set()
    for item in re.findall(r'<li\b[^>]*>(.*?)</li>',current[1],re.S):
        title=re.search(r'<h4>(.*?)<span>(\d{2}\.\d{2} \d{2}:\d{2})</span></h4>',item,re.S)
        temp=re.search(r'<dt>\s*Temperatura\s*</dt>\s*<dd>\s*([+-]?\d+(?:[.,]\d+)?)\s*°C\s*</dd>',item)
        if not title or not temp or title[2]!=date.strftime('%d.%m %H:%M'):continue
        meta=by_name.get(normalized(title[1]))
        if not meta:continue
        code,m=meta
        if code in seen:continue
        try:t=local_time(date,'Europe/Chisinau')
        except ValueError:continue
        s=station('MD','AMM-'+code,m['name'],m['lat'],m['lon'],[(t,number(temp[1].replace(',','.'),-89.99,54.99))],now)
        if s:out.append(s);seen.add(code)
    if not out:raise ValueError('No recent official Moldovan temperatures')
    return out


def parse_belarus(payload,now):
    if not isinstance(payload,list) or len(payload)>200:raise ValueError('Unexpected Belhydromet national observation map')
    grouped={}
    for row in payload:
        if not isinstance(row,dict) or row.get('country')!='BY':continue
        code=str(row.get('number') or '')
        if not re.fullmatch(r'\d{5}',code):continue
        lat=number(row.get('LATITUDE'),51.2,56.3);lon=number(row.get('LONGITUDE'),23,33)
        if lat is None or lon is None:continue
        # date is the UTC report DAY at midnight; HH is its separate UTC hour.
        # DWD copies of matching WMO reports confirm the UTC interpretation.
        date=row.get('date');hour=row.get('HH')
        if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z',date):continue
        if isinstance(hour,bool) or not re.fullmatch(r'\d{1,2}',str(hour)) or not 0<=int(hour)<=23:continue
        try:t=int((dt.datetime.fromisoformat(date.replace('Z','+00:00'))+dt.timedelta(hours=int(hour))).timestamp())
        except ValueError:continue
        # Decode %2b (plus) without treating missing/encoded garbage as zero.
        v=number(unquote(str(row['Temp'])) if isinstance(row.get('Temp'),str) else row.get('Temp'),-89.99,54.99)
        name=str(row.get('name') or '').strip()
        if not name or v is None:continue
        entry=grouped.setdefault(code,{'name':name,'lat':lat,'lon':lon,'rows':[]})
        if (entry['lat'],entry['lon'])!=(lat,lon):continue
        entry['rows'].append((t,v))
    out=[]
    for code,m in grouped.items():
        s=station('BY','SYNOP-'+code,m['name'],m['lat'],m['lon'],m['rows'],now)
        if s:out.append(s)
    if not out:raise ValueError('No recent official Belarusian temperatures')
    return out


def load(country,now,download=core.download):
    if country=='BY':return parse_belarus(json.loads(download(BY_URL)),now)
    if country=='MD':
        metadata=json.loads(Path(__file__).with_name('moldova_temperature_stations.json').read_text())['stations']
        return parse_moldova(download(MD_URL),metadata,now)
    raise ValueError('Unknown Moldova/Belarus temperature country')
