"""Official European names; conservative derived association, never naming-list guesses.

Only named, recent storm impacts and named wind CAP alerts are candidates.
The official name is authoritative; its association to a GFS centre is derived.
Require exactly one persistent <=1000 hPa low near the official impact region
in the valid interval. Multiple candidate lows or competing names stay unmatched.
"""
import datetime as dt
from html.parser import HTMLParser
import json
import re
import xml.etree.ElementTree as ET

UK_SOURCE='https://weather.metoffice.gov.uk/warnings-and-advice/uk-storm-centre'
MET_SOURCE='https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en&event=wind'

class StormTable(HTMLParser):
    def __init__(self):
        super().__init__();self.rows=[];self.row=None;self.cell=None;self.link=None
    def handle_starttag(self,tag,attrs):
        if tag=='tr':self.row=[]
        if tag in ('th','td') and self.row is not None:self.cell=[]
        if tag=='a' and self.cell is not None:
            href=dict(attrs).get('href','');self.link=href
    def handle_data(self,data):
        if self.cell is not None:self.cell.append(data)
    def handle_endtag(self,tag):
        if tag in ('th','td') and self.cell is not None:
            self.row.append(' '.join(' '.join(self.cell).split()));self.cell=None
        if tag=='tr' and self.row is not None:self.rows.append(self.row);self.row=None

def uk_dates(text,now):
    # Reject unrecognised dates rather than interpreting an annual name list.
    matches=re.findall(r'(?<!\d)(\d{1,2})(?:\s*(?:-|–|—|and|to)\s*(\d{1,2}))?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(20\d{2}))?',text,re.I)
    dates=[]
    for first,last,month,year in matches:
        for day in (first,last) if last else (first,):
            date=dt.datetime.strptime(f'{day} {month[:3].title()} {year or now.year}','%d %b %Y').replace(tzinfo=dt.timezone.utc)
            if not year and date-now>dt.timedelta(days=180):date=date.replace(year=date.year-1)
            elif not year and now-date>dt.timedelta(days=180):date=date.replace(year=date.year+1)
            dates.append(date)
    return dates

def parse_uk(text,now):
    parser=StormTable();parser.feed(text);result=[]
    for row in parser.rows:
        if len(row)!=3 or not row[1] or not row[2] or not re.fullmatch(r'[\wÀ-ž -]{2,40}',row[0]):continue
        dates=uk_dates(row[2],now)
        if not dates:continue
        start=min(dates);end=max(dates)+dt.timedelta(days=1)
        if end<now-dt.timedelta(hours=24) or start>now+dt.timedelta(days=5):continue
        result.append({'name':row[0],'issuer':'Met Office / Western Europe naming group','url':UK_SOURCE,
            'start':int(start.timestamp()),'end':int(end.timestamp()),'region':[49,-12,61,8]})
    return result

def parse_met(payload,now):
    result=[]
    for f in payload.get('features',[]):
        p=f.get('properties',{});name=p.get('incidentName') or p.get('incident_name')
        if not isinstance(name,str) or not re.fullmatch(r'[\wÀ-ž -]{2,40}',name):continue
        if p.get('event') not in ('wind','gale') or p.get('status','Actual')!='Actual' or p.get('type')=='Cancel':continue
        try:
            def stamp(value):return int(dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())
            start=stamp(p.get('eventStartingTime') or p.get('onset') or p['effective']);end=stamp(p.get('eventEndingTime') or p['expires'])
            if end<int(now.timestamp()) or start>int(now.timestamp())+5*86400:continue
            geometry=f['geometry'];coords=geometry['coordinates']
            rings=coords if geometry['type']=='Polygon' else [ring for polygon in coords for ring in polygon] if geometry['type']=='MultiPolygon' else []
            points=[xy for ring in rings for xy in ring]
            if not points:continue
            lat=[xy[1] for xy in points];lon=[xy[0] for xy in points]
            url=p.get('web') or 'https://www.met.no/vaer-og-klima/ekstremvaervarsler-og-andre-farevarsler'
            result.append({'name':name,'issuer':'MET Norway','url':url,'start':start,'end':end,
                'region':[min(lat),min(lon),max(lat),max(lon)]})
        except (KeyError,ValueError,TypeError):continue
    return result

def met_catalogue(raw,now,download):
    payload=json.loads(raw)
    # Some GeoJSON versions omit incidentName, which remains in the official CAP.
    for feature in payload.get('features',[])[:50]:
        props=feature.get('properties',{})
        if props.get('riskMatrixColor')!='Red' or props.get('incidentName'):continue
        resources=props.get('resources',[])
        cap=next((r.get('uri') for r in resources if r.get('mimeType')=='application/xml' and str(r.get('uri','')).startswith('https://api.met.no/weatherapi/metalerts/')),None)
        if not cap:continue
        root=ET.fromstring(download(cap))
        for parameter in root.findall('.//{*}parameter'):
            if parameter.findtext('{*}valueName')=='incidentName':props['incidentName']=parameter.findtext('{*}value')
        for tag in ('onset','effective','expires'):
            value=root.findtext('.//{*}'+tag)
            if value:props[tag]=value
        props['web']=cap
    return parse_met(payload,now)

def add_european_names(tracks,now,download,distance):
    state={'checkedAt':int(now.timestamp()),'sources':[],'matched':0};catalogue=[]
    for issuer,url,parser in [('Met Office',UK_SOURCE,lambda raw:parse_uk(raw.decode('utf-8'),now)),
                              ('MET Norway',MET_SOURCE,lambda raw:met_catalogue(raw,now,download))]:
        try:
            names=parser(download(url));catalogue.extend(names)
            state['sources'].append({'issuer':issuer,'status':'ok','namedEvents':len(names),'url':url})
        except Exception as error:state['sources'].append({'issuer':issuer,'status':'error','url':url,'error':str(error)[:200]})
    candidates={}
    for named in catalogue:
        south,west,north,east=named['region'];matching=set()
        for i,track in enumerate(tracks):
            # Need persistence in the impact interval, not a single passing forecast point.
            near=[]
            for p in track['points']:
                if named['start']<=p['time']<=named['end'] and p['pressure']<=1000 and p.get('nearbyGust',0)>=20:
                    nearest={'lat':min(north,max(south,p['lat'])),'lon':min(east,max(west,p['lon']))}
                    if distance(p,nearest)<=450:near.append(p)
            if len(near)>=2:matching.add(i)
        if len(matching)==1:
            i=matching.pop();candidates.setdefault(i,{}).setdefault(named['name'].casefold(),named)
    for i,names in candidates.items():
        if len(names)!=1 or tracks[i].get('nhc'):continue
        named=next(iter(names.values()));tracks[i]['name']=named['name']
        tracks[i]['europeanName']={**named,'matchMethod':'Unique GFS low near official impact region during the valid interval'}
        state['matched']+=1
    return state
