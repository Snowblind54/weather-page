"""Official Malta, Cyprus and Türkiye measured air temperatures."""
import datetime as dt
import gzip
import json
import re
import urllib.request
import xml.etree.ElementTree as ET

import update_official_temperature as core
from eastern_temperature import local_time, number
from southeast_temperature import parse_airports

BOUNDS={'MT':(35.75,36.15,14.15,14.65),'CY':(34.5,35.8,32.1,34.7),'TR':(35.8,42.2,25.6,45)}
SOURCES={'MT':'Malta International Airport / official METAR/SPECI air temperature via NOAA Aviation Weather Center (one station)',
 'CY':'Weather Data © Cyprus Department of Meteorology / provisional ten-minute air temperature at 1.2 m · CC BY 4.0',
 'TR':'Meteoroloji Genel Müdürlüğü (MGM), Türkiye / official provincial reporting-station observations (provisional)'}
CY_URL='https://dom.org.cy/AWS/OpenData/CyDoM.xml'
TR_METADATA='https://servis.mgm.gov.tr/web/merkezler/iller'
TR_OBSERVATIONS='https://servis.mgm.gov.tr/web/sondurumlar/ilmerkezleri'
MT_URL='https://aviationweather.gov/api/data/metar?ids=LMML&format=json&hours=2'
# Current NOAA AWC station catalogue. One Luqa station, not a Malta-wide network.
MALTA={'LMML':{'icao':'LMML','name':'Malta International Airport (Luqa)','lat':35.858,'lon':14.477}}


def station(country,code,name,lat,lon,rows,now):
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    end=int(now.timestamp())
    rows=[(t,v) for t,v in rows if end-86400<=t<=end+60 and v is not None]
    if not rows or max(t for t,v in rows)<end-2*3600:return None
    return core.make_station(country,code,name,lat,lon,rows)


def parse_cyprus(raw,now):
    root=ET.fromstring(raw)
    if root.tag!='meteorology':raise ValueError('Unexpected Cyprus observation product')
    entries=root.findall('stations/station');observations=root.findall('observations')
    if not entries or len(entries)>200 or len(observations)>200:raise ValueError('Unexpected Cyprus station count')
    meta={};ambiguous=set()
    for entry in entries:
        code=entry.findtext('station_code') or ''
        if not re.fullmatch(r'[A-Z0-9_]+',code):continue
        lat=number(entry.findtext('station_latitude'),34.5,35.8);lon=number(entry.findtext('station_longitude'),32.1,34.7)
        if lat is None or lon is None:continue
        if code in meta and meta[code]!=(lat,lon):ambiguous.add(code)
        meta[code]=(lat,lon)
    grouped={}
    for entry in observations:
        code=entry.findtext('station_code') or ''
        if code not in meta or code in ambiguous:continue
        # Retain the instantaneous shelter-height channel, not 5 cm soil-near
        # air temperature, daily maximum/minimum or another weather parameter.
        channels=[o for o in entry.findall('observation') if o.findtext('observation_name')=='Air Temperature (1.2m)']
        if len(channels)!=1 or channels[0].findtext('observation_unit') not in ('Celcius','Celsius','°C'):continue
        date=entry.findtext('date_time') or ''
        match=re.fullmatch(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(Local Time\)',date.strip())
        if not match:continue
        try:t=local_time(dt.datetime.strptime(match[1],'%Y-%m-%d %H:%M'),'Asia/Nicosia')
        except ValueError:continue
        value=number(channels[0].findtext('observation_value'),-89.99,54.99)
        grouped.setdefault(code,[]).append((t,value))
    out=[]
    for code,rows in grouped.items():
        lat,lon=meta[code];s=station('CY','CYDOM-'+code,code.replace('_',' ').title(),lat,lon,rows,now)
        if s:out.append(s)
    if not out:raise ValueError('No recent official Cyprus air temperatures')
    return out


def parse_turkey(metadata,observations,now):
    if not isinstance(metadata,list) or not isinstance(observations,list) or not 1<=len(metadata)<=200 or len(observations)>300:raise ValueError('Unexpected MGM provincial observation product')
    meta={};ambiguous=set()
    for m in metadata:
        # This field identifies the reporting station; modelId, merkezId and
        # gunlukTahminIstNo are forecast identifiers and must not be joined.
        code=str(m.get('sondurumIstNo') or '')
        if not re.fullmatch(r'\d{5}',code):continue
        lat=number(m.get('enlem'),35.8,42.2);lon=number(m.get('boylam'),25.6,45)
        name=str(m.get('il') or '').strip();district=str(m.get('ilce') or '').strip()
        if not name or lat is None or lon is None:continue
        if district and district!='Merkez':name+=' / '+district
        row=(name,lat,lon)
        if code in meta and meta[code]!=row:ambiguous.add(code)
        meta[code]=row
    grouped={}
    for row in observations:
        code=str(row.get('istNo') or '')
        if code not in meta or code in ambiguous:continue
        date=row.get('veriZamani')
        if not isinstance(date,str):continue
        try:
            when=dt.datetime.fromisoformat(date.replace('Z','+00:00'))
            if when.tzinfo is None:continue
            t=int(when.timestamp())
        except ValueError:continue
        # sicaklik is measured °C. Do not substitute hissedilenSicaklik,
        # sea temperature or the timestamp of those separate channels.
        value=number(row.get('sicaklik'),-89.99,54.99)
        grouped.setdefault(code,[]).append((t,value))
    out=[]
    for code,rows in grouped.items():
        name,lat,lon=meta[code];s=station('TR','MGM-'+code,name,lat,lon,rows,now)
        if s:out.append(s)
    if not out:raise ValueError('No recent official Turkish air temperatures')
    return out


def download_turkey(url):
    # Public endpoints used by the national current-observations page.
    req=urllib.request.Request(url,headers={'User-Agent':core.USER_AGENT,'Referer':'https://www.mgm.gov.tr/',
        'Origin':'https://www.mgm.gov.tr','Accept-Encoding':'gzip'})
    with urllib.request.urlopen(req,timeout=30) as response:raw=response.read(2*1024*1024+1)
    if len(raw)>2*1024*1024:raise ValueError('MGM response too large')
    raw=gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw
    if len(raw)>4*1024*1024:raise ValueError('MGM decoded response too large')
    return raw


def load(country,now,download=core.download,mgm_download=download_turkey):
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    if country=='CY':return parse_cyprus(download(CY_URL),now)
    if country=='TR':return parse_turkey(json.loads(mgm_download(TR_METADATA)),json.loads(mgm_download(TR_OBSERVATIONS)),now)
    if country=='MT':
        out=parse_airports('MT',json.loads(download(MT_URL)),MALTA,now)
        for s in out:s['source']=SOURCES['MT']
        if not out:raise ValueError('No current official Malta airport temperatures')
        return out
    raise ValueError('Unknown Mediterranean temperature country')
