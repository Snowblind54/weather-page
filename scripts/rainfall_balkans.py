"""Official Serbian, Bulgarian, Croatian and Greek rain with native reporting periods.

SYNOP totals retain their actual UTC times. An omitted dry station, blank value,
trace or longer reporting interval never becomes an invented hourly reading.
"""
import concurrent.futures as futures
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import update_rainfall as core
import rainfall_europe as europe
from rainfall_eastern import parse_bulletin, location
from adriatic_greece_temperature import BASE, download_bulletin
from official_wind_balkans import BULLETINS as WIND_BULLETINS
from moldova_belarus_temperature import normalized

DHMZ='https://vrijeme.hr/oborina.xml'
DHMZ_STATIONS='https://vrijeme.hr/hrvatska_n.xml'
RS_DAILY='https://www.hidmet.gov.rs/eng/osmotreni/padavine.php'
SOURCES={'GR':('Hellenic National Meteorological Service (HNMS) / official Greek SYNOP rain gauges','https://emy.gr/en/hnms-stations'),
         'RS':('Republic Hydrometeorological Service of Serbia (RHMZ) / official SYNOP and daily gauge measurements',RS_DAILY),
         'BG':('National Institute of Meteorology and Hydrology (NIMH), Bulgaria / official SYNOP gauges',europe.POI),
         'HR':('DHMZ / official Croatian SYNOP and daily rain gauges',DHMZ)}
PERIODS={c:'Official measured precipitation in mm. Native 1-, 3-, 6-, 12- and 24-hour SYNOP reporting periods retain their UTC ending times. Only complete adjacent measurements from the same gauge form 24/48h totals. A 1h reading appears only when explicitly reported; longer totals are never divided into hourly estimates. Missing, blank, trace-only and lower-bound values stay unavailable as numeric amounts. Older complete totals show their actual ending time.' for c in SOURCES}
PERIODS['GR']+=' Mainland and island stations; land SYNOP reports may be three- or six-hourly. The shared updater retains 72 hours of measured history. Missing hourly values are never estimated from longer reports.'
PERIODS['HR']+=' DHMZ daily reports cover 06 UTC yesterday to 06 UTC today; the public daily list includes wet gauges only. Omitted gauges are not assumed dry. Izvor: DHMZ; Otvorena dozvola Republike Hrvatske.'
PERIODS['RS']+=' RHMZ dated daily reports cover 06 UTC yesterday to 06 UTC today; blank cells are not treated as zero.'
BULLETINS={c:WIND_BULLETINS[c] for c in ('RS','BG','GR')}
BULLETINS['HR']=['sm/smrh10.ldzm..txt','sm/smrh21.ldzm..txt','sm/smrh50.ldzm..txt','sm/smrh80.ldzm..txt','si/sirh20.ldzm..txt','si/sirh21.ldzm..txt','si/sirh50.ldzm..txt','si/sirh80.ldzm..txt']


def parse_croatia_daily(raw,station_raw,now):
    root=ET.fromstring(raw);catalogue=ET.fromstring(station_raw)
    if root.tag!='dnevna_oborina' or catalogue.tag!='Hrvatska':raise ValueError('Unexpected DHMZ daily rain product')
    try:
        date=dt.datetime.strptime(root.findtext('datumtermin/datum'),'%d.%m.%Y.').replace(tzinfo=dt.timezone.utc,hour=6)
    except (ValueError,TypeError):raise ValueError('DHMZ daily rain date missing')
    end=int(date.timestamp());current=int(now.timestamp())
    if not current-72*3600<=end<=current:return []
    meta={};ambiguous=set()
    for x in catalogue.findall('Grad'):
        name=(x.findtext('GradIme') or '').strip();lat=x.findtext('Lat');lon=x.findtext('Lon');key=normalized(name)
        if not key or not location('HR',lat,lon):continue
        m=dict(name=name,lat=float(lat),lon=float(lon))
        if key in meta and meta[key]!=m:ambiguous.add(key)
        meta[key]=m
    out=[];seen=set()
    for x in root.findall('grad'):
        key=normalized(x.findtext('ime') or '');value=core.amount(x.findtext('kolicina'))
        if key not in meta or key in ambiguous or key in seen or value is None:continue
        m=meta[key];code='DHMZ-'+hashlib.sha256((m['name']+'|'+str(m['lat'])+'|'+str(m['lon'])).encode()).hexdigest()[:16]
        s=core.station('HR',code,m['name'],m['lat'],m['lon'],[]);s['periods']=[dict(end=end,hours=24,value=value)];out.append(s);seen.add(key)
    return out


def parse_serbia_daily(raw,metadata,now):
    from balkan_temperature import ObservationTable
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    match=re.search(r'<h1>\s*Main meteorological stations (\d{2}\.\d{2}\.\d{4})\s*</h1>(.*?)(?:<h1>|</body>)',text,re.S)
    if not match or '06:00 UTC' not in match[2] or 'Precipitation mm for 24 hour' not in match[2]:raise ValueError('RHMZ daily rain date/window changed')
    end=int(dt.datetime.strptime(match[1],'%d.%m.%Y').replace(tzinfo=dt.timezone.utc,hour=6).timestamp())
    if not int(now.timestamp())-72*3600<=end<=int(now.timestamp()):return []
    out=[];seen=set()
    for row in re.findall(r'<tr\b[^>]*>(.*?)</tr>',match[2],re.S):
        code=re.search(r'href="padavine_grafik\.php\?id=(\d{5})"',row)
        if not code or code[1] not in metadata or code[1] in seen:continue
        parser=ObservationTable();parser.feed('<tr>'+row+'</tr>');parser.finish_cell();parser.finish_row()
        cells=parser.rows[0] if parser.rows else []
        if len(cells)!=4:continue
        value=core.amount(cells[1].replace(',','.'));m=metadata[code[1]]
        if value is None or not location('RS',m['lat'],m['lon']):continue
        s=core.station('RS',code[1],m['name'],m['lat'],m['lon'],[]);s['periods']=[dict(end=end,hours=24,value=value)];out.append(s);seen.add(code[1])
    return out


def load(country,now,previous,download=core.download,bulletin_download=download_bulletin):
    catalogue=json.loads(Path(__file__).with_name('balkan_rain_stations.json').read_text());metadata=catalogue['stations'][country];out=[]
    def one(code):
        try:return europe.parse_synop(download(europe.POI+code+'-BEOB.csv',False),code,{**metadata[code],'country':country})
        except Exception as e:print(country,'rain gauge unavailable',code,str(e)[:100],flush=True)
    with futures.ThreadPoolExecutor(max_workers=4) as pool:out.extend(s for s in pool.map(one,catalogue['poi'][country]) if s)
    def bulletin(path):
        try:
            raw,reference=bulletin_download(BASE+path);parts=path.split('/')[-1].split('.')
            return parse_bulletin(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,country,now,include_daily=True)
        except Exception as e:print(country,'rain bulletin unavailable',path,str(e)[:100],flush=True);return []
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        for rows in pool.map(bulletin,BULLETINS[country]):out.extend(rows)
    try:
        if country=='HR':out.extend(parse_croatia_daily(download(DHMZ,False),download(DHMZ_STATIONS,False),now))
        if country=='RS':out.extend(parse_serbia_daily(download(RS_DAILY,False),metadata,now))
    except Exception as e:print(country,'national daily rain unavailable:',str(e)[:140],flush=True)
    result=europe.trimmed(out,now)
    if not result:raise ValueError('No recent official '+country+' rain reports')
    return result


def install(target):
    target.SOURCES.update(SOURCES)
    target.LOADERS.update({c:(lambda now,previous,c=c:load(c,now,previous)) for c in SOURCES})
