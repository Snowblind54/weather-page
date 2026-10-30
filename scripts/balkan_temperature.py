"""Official RHMZ Serbia and FHMZ Bosnia and Herzegovina air temperatures."""
import datetime as dt
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import update_official_temperature as core
from eastern_temperature import local_time, number
from moldova_belarus_temperature import normalized

BOUNDS={'BA':(42.5,45.4,15.6,19.7),'RS':(42.2,46.3,18.8,23.1)}
SOURCES={'BA':'Federalni hidrometeorološki zavod (FHMZ), Bosnia and Herzegovina / official hourly station observations',
         'RS':'Republic Hydrometeorological Service of Serbia (RHMZ) / official hourly station observations'}
URLS={'BA':'https://fop.fhmzbih.gov.ba/tabelabih.php','RS':'https://www.hidmet.gov.rs/eng/osmotreni/index.xml'}


def station(country,code,m,rows,now):
    end=int(now.timestamp())
    rows=[(t,v) for t,v in rows if end-86400<=t<=end+60 and v is not None]
    if not rows or max(t for t,v in rows)<end-2*3600:return None
    core.COUNTRY_BOUNDS.update(BOUNDS);core.SOURCES.update(SOURCES)
    return core.make_station(country,code,m['name'],m['lat'],m['lon'],rows)


def parse_serbia(raw,metadata,now):
    root=ET.fromstring(raw)
    ns={'a':'https://www.w3.org/2005/Atom'}
    if root.tag!='{'+ns['a']+'}feed':raise ValueError('Unexpected RHMZ station product')
    title=root.findtext('a:title','',ns)
    date=re.fullmatch(r'RHMS of Serbia - Data from major meteorological stations (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})',title.strip())
    if not date:raise ValueError('RHMZ actual observation hour missing')
    # Feed <updated> is publication time (often 14 minutes after observation).
    # Only the dated observed hour in the title is a measurement timestamp.
    t=local_time(dt.datetime.strptime(date[1],'%d.%m.%Y %H:%M'),'Europe/Belgrade')
    entries=root.findall('a:entry',ns)
    if len(entries)>100:raise ValueError('RHMZ station limit exceeded')
    out=[];seen=set()
    for en in entries:
        summary=en.findtext('a:summary','',ns)
        code=re.search(r'(?:^|;)\s*Station ID:\s*(\d{5});',summary)
        temp=re.search(r'(?:^|;)\s*Temperature:\s*([+-]?\d+(?:[.,]\d+)?)\s*°C;',summary)
        if not code or not temp or code[1] not in metadata or code[1] in seen:continue
        m=metadata[code[1]]
        if normalized(en.findtext('a:title','',ns).removeprefix('Station: ').rstrip(';'))!=normalized(m['name']):continue
        s=station('RS','RHMZ-'+code[1],m,[(t,number(temp[1].replace(',','.'),-89.99,54.99))],now)
        if s:out.append(s);seen.add(code[1])
    if not out:raise ValueError('No recent official Serbian temperatures')
    return out


class ObservationTable(HTMLParser):
    """Read cells, allowing the provider's nested layout tables and omitted tags."""
    def __init__(self):super().__init__(convert_charrefs=True);self.rows=[];self.row=[];self.cell=None
    def handle_starttag(self,tag,attrs):
        if tag=='tr':
            self.finish_cell();self.finish_row()
        elif tag in ('td','th'):
            self.finish_cell();self.cell=[]
    def handle_endtag(self,tag):
        if tag in ('td','th'):self.finish_cell()
        elif tag=='tr':self.finish_cell();self.finish_row()
    def handle_data(self,data):
        if self.cell is not None:self.cell.append(data)
    def finish_cell(self):
        if self.cell is not None:self.row.append(' '.join(''.join(self.cell).split()));self.cell=None
    def finish_row(self):
        if self.row:self.rows.append(self.row);self.row=[]


def parse_bosnia(raw,metadata,now):
    text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
    parser=ObservationTable();parser.feed(text);parser.finish_cell();parser.finish_row()
    by_name={normalized(m['name']):(code,m) for code,m in metadata.items()}
    out=[];seen=set();t=None;header=False
    for row in parser.rows:
        # Retain the dated current table; do not borrow a forecast/publication
        # date or use the server's clock to make an old report look current.
        date=re.fullmatch(r'Vrijeme u BiH\s+(\d{2}\.\d{2}\.\d{4})\.\s+u\s+(\d{1,2})\s*h',row[0])
        if date:
            try:t=local_time(dt.datetime.strptime(date[1]+' '+date[2],'%d.%m.%Y %H'),'Europe/Sarajevo')
            except ValueError:t=None
            header=False;continue
        if len(row)==7 and normalized(row[0])=='grad':
            header=normalized(row[3])=='temperaturaoc' and 'km/h' in row[2]
            continue
        if not header or t is None or len(row)!=7:continue
        found=by_name.get(normalized(row[0]))
        if not found:continue
        code,m=found
        if code in seen:continue
        v=number(row[3].replace(',','.'),-89.99,54.99)
        s=station('BA','FHMZ-'+code,m,[(t,v)],now)
        if s:out.append(s);seen.add(code)
    if not out:raise ValueError('No recent official Bosnian temperatures')
    return out


def load(country,now,download=core.download):
    if country not in URLS:raise ValueError('Unknown Balkan temperature country')
    metadata=json.loads(Path(__file__).with_name('balkan_temperature_stations.json').read_text())['stations'][country]
    return (parse_bosnia if country=='BA' else parse_serbia)(download(URLS[country]),metadata,now)
