"""FHMZ automatic rain gauges: published hourly and rolling 24h measurements.

Coordinates, gauge identities and dated chart samples come from the same official
page. No JavaScript is executed. Blank cells never become zero rainfall.
"""
import datetime as dt
import html
import re
from zoneinfo import ZoneInfo

import update_rainfall as core
from balkan_temperature import ObservationTable
from eastern_temperature import local_time
from moldova_belarus_temperature import normalized

URL='https://fop.fhmzbih.gov.ba/'


def plain(raw):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>',' ',raw)).split())


def decode_array(raw):
    values=[]
    for token in raw.split(','):
        token=token.strip()
        if len(token)>=2 and token[0] in ('"',"'") and token[-1]==token[0]:token=token[1:-1]
        if not re.fullmatch(r'[\d.\s+-]*|null|NaN',token):raise ValueError('Unexpected FHMZ rain array token')
        values.append(token)
    return values


def parse(raw,now):
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    if len(text)>2*1024*1024:raise ValueError('Oversized FHMZ automatic rain page')
    if 'satne padavine (mm)' not in text or 'padavina 24sata' not in text:raise ValueError('FHMZ rain units/window changed')
    from rainfall_eastern import location
    coordinates={};ambiguous=set()
    pattern=r"const\s+ams\w+\s*=\s*L\.marker\(\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\],\{[^}]*\}\)\.bindPopup\('([^']+)'\)"
    for lat,lon,title in re.findall(pattern,text):
        name=re.sub(r'^automatska\s+(?:padavinska|meteorološka)\s+stanica\s*','',plain(title),flags=re.I).strip();key=normalized(name)
        if not key or not location('BA',lat,lon):continue
        m=dict(name=name,lat=float(lat),lon=float(lon))
        if key in coordinates and coordinates[key]!=m:ambiguous.add(key)
        coordinates[key]=m
    # Each chart title identifies its gauge. The table links to that chart ID,
    # avoiding joins based on abbreviations such as G.Kamengrad or SA-Butmir.
    gauges={}
    for code,body in re.findall(r'<div\b[^>]*id="(stanice\d+)"[^>]*>(.*?)</div>',text,re.S):
        title=re.search(r"text:\s*'automatska stanica\s+([^']+)'",body)
        if not title:continue
        key=normalized(title[1]);m=coordinates.get(key)
        if not m or key in ambiguous or code in gauges:continue
        gauges[code]=(m,body)
    if not gauges or len(gauges)>100:raise ValueError('FHMZ gauge identities/coordinates unavailable')
    result=[];seen=set();end=int(now.timestamp())
    for raw_row in re.findall(r'<tr\b[^>]*>(.*?)</tr>',text,re.S):
        cells=re.findall(r'<td\b[^>]*>(.*?)</td>',raw_row,re.S)
        for start in range(0,len(cells)-5,6):
            group=cells[start:start+6]
            match=re.search(r"padavinske\('(?P<id>stanice\d+)'\)",group[2])
            if not match or match['id'] not in gauges or match['id'] in seen:continue
            code=match['id'];m,body=gauges[code]
            try:
                date=dt.datetime.strptime(plain(group[0])+' '+plain(group[1]),'%d.%m.%Y %H')
                t=local_time(date,'Europe/Sarajevo')
            except ValueError:continue
            if not end-72*3600<=t<=end:continue
            hour=core.amount(plain(group[4]).replace(',','.'));daily=core.amount(plain(group[5]).replace(',','.'))
            rows=[] if hour is None else [(t,hour,False)]
            # A chart contains explicit hourly measurements, not differences
            # of rolling 24-hour totals. Validate all dated axis anchors against
            # the independently dated table before accepting the history.
            data=re.search(r"label:\s*'padavine'.*?\bdata:\s*\[([^\]]*)\]",body,re.S)
            axes=re.findall(r"id:\s*'xAxis[12]'.*?labels:\s*\[([^\]]*)\]",body,re.S)
            if hour is not None and data and len(axes)==2:
                values=decode_array(data[1]);hours=decode_array(axes[0]);dates=decode_array(axes[1])
                if len(values)==len(hours)==len(dates)==24 and core.amount(values[-1])==hour:
                    history=[];valid=True
                    for i,(v,h,d) in enumerate(zip(values,hours,dates)):
                        observed=dt.datetime.fromtimestamp(t-(23-i)*3600,dt.timezone.utc)
                        local=observed.astimezone(ZoneInfo('Europe/Sarajevo'))
                        if not h.isdigit() or int(h)!=local.hour or (d.strip() and d.strip()!=local.strftime('%d.%m.%Y.')):valid=False;break
                        value=core.amount(v)
                        if value is not None:history.append((int(observed.timestamp()),value,False))
                    if valid:rows=history
            s=core.station('BA','FHMZ-AUTO-'+code,m['name'],m['lat'],m['lon'],rows);s['periods']=[] if daily is None else [dict(end=t,hours=24,value=daily)]
            if rows or s['periods']:result.append(s);seen.add(code)
    if not result:raise ValueError('No recent FHMZ automatic rain observations')
    return result
