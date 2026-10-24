"""Official European names; conservative derived association, never naming-list guesses.

Only named, recent storm impacts and named wind CAP alerts are candidates.
The official name is authoritative; its association to a GFS centre is derived.
Require exactly one persistent <=1000 hPa low near the official impact region
in the valid interval. Multiple candidate lows or competing names stay unmatched.
"""
import concurrent.futures as futures
import datetime as dt
from html.parser import HTMLParser
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

UK_SOURCE='https://weather.metoffice.gov.uk/warnings-and-advice/uk-storm-centre'
UK_WARNINGS='https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-united-kingdom'
CAP={'c':'urn:oasis:names:tc:emergency:cap:1.2','a':'http://www.w3.org/2005/Atom'}
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


def pending_uk_names(text,now):
    """A naming date confirms use; an undated annual-list entry does not."""
    parser=StormTable();parser.feed(text);names={}
    for row in parser.rows:
        if len(row)!=3 or row[2] or not re.fullmatch(r'[\wÀ-ž -]{2,40}',row[0]):continue
        try:dates=uk_dates(row[1],now)
        except ValueError:continue
        if len(dates)==1 and now-dt.timedelta(days=30)<=dates[0]<=now:
            names[row[0].casefold()]={'name':row[0],'namedAt':int(dates[0].timestamp())}
    return names


def parse_uk_cap(raw,known,now,url):
    """Read actual named wind warnings; never turn the naming date into impact time."""
    root=ET.fromstring(raw);get=lambda e,k:e.findtext('c:'+k,'',CAP).strip()
    if root.tag!='{'+CAP['c']+'}alert':raise ValueError('Expected UK CAP alert')
    if get(root,'status')!='Actual' or get(root,'scope')!='Public' or get(root,'msgType') not in ('Alert','Update'):return []
    result=[]
    for info in root.findall('c:info',CAP):
        if not get(info,'language').lower().startswith('en') or get(info,'senderName')!='UK Met Office':continue
        if not re.search(r'\b(wind|gale)\b',get(info,'event'),re.I):continue
        # Conflicting names in one warning are not a trustworthy association.
        text=get(info,'headline')+' '+get(info,'description')
        found=[v for k,v in known.items() if re.search(r'\bstorm\s+'+re.escape(v['name'])+r'\b',text,re.I)]
        if len(found)!=1:continue
        try:
            start=dt.datetime.fromisoformat(get(info,'onset').replace('Z','+00:00'))
            end=dt.datetime.fromisoformat(get(info,'expires').replace('Z','+00:00'))
            if start.tzinfo is None or end.tzinfo is None or end<=start or end<=now or start>now+dt.timedelta(days=5):continue
            if int(end.timestamp())<found[0]['namedAt']:continue
            for area in info.findall('c:area',CAP):
                points=[]
                for polygon in area.findall('c:polygon',CAP):
                    for pair in (polygon.text or '').split():
                        lat,lon=map(float,pair.split(','))
                        if not 48<=lat<=62 or not -13<=lon<=4:raise ValueError('UK warning outside expected bounds')
                        points.append((lat,lon))
                if len(points)<4:continue
                web=get(info,'web');parsed=urlparse(web)
                official=web if parsed.scheme=='https' and parsed.netloc in ('www.metoffice.gov.uk','weather.metoffice.gov.uk') else UK_SOURCE
                result.append({**found[0],'issuer':'Met Office / Western Europe naming group','url':official,
                    'start':int(start.timestamp()),'end':int(end.timestamp()),
                    'region':[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)],
                    'impactSource':'Met Office CAP wind warning via Meteoalarm','warningUrl':url})
        except (ValueError,TypeError):continue
    return result


def uk_catalogue(raw,now,download):
    text=raw.decode('utf-8');names=parse_uk(text,now);pending=pending_uk_names(text,now)
    if not pending:return names
    root=ET.fromstring(download(UK_WARNINGS))
    if root.tag!='{'+CAP['a']+'}feed' or root.findtext('a:id','',CAP).split(':')[-1]!='UK':raise ValueError('Unexpected UK warning feed')
    urls=set()
    for entry in root.findall('a:entry',CAP):
        if entry.findtext('c:status','',CAP)!='Actual' or not re.search(r'\b(wind|gale)\b',entry.findtext('c:event','',CAP),re.I):continue
        for link in entry.findall('a:link',CAP):
            url=link.get('href','')
            if link.get('type')=='application/cap+xml' and re.fullmatch(r'https://feeds\.meteoalarm\.org/api/v1/warnings/feeds-united-kingdom/[a-f0-9-]{36}',url):urls.add(url)
    if len(urls)>20:raise ValueError('Too many UK wind warning documents')
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(lambda url:parse_uk_cap(download(url),pending,now,url),sorted(urls)):
            names.extend(result)
    return names

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
    for issuer,url,parser in [('Met Office',UK_SOURCE,lambda raw:uk_catalogue(raw,now,download)),
                              ('MET Norway',MET_SOURCE,lambda raw:met_catalogue(raw,now,download))]:
        try:
            names=parser(download(url));catalogue.extend(names)
            state['sources'].append({'issuer':issuer,'status':'ok','namedEvents':len({n['name'].casefold() for n in names}),'url':url})
        except Exception as error:state['sources'].append({'issuer':issuer,'status':'error','url':url,'error':str(error)[:200]})
    candidates={};events={}
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
        # All warnings for one name must agree on a single model track.
        # Separate warning areas must not assign the same name to two lows.
        key=named['name'].casefold()
        event=events.setdefault(key,{'matching':set(),'named':named})
        event['matching'].update(matching)
    for key,event in events.items():
        if len(event['matching'])==1:
            i=next(iter(event['matching']));candidates.setdefault(i,{})[key]=event['named']
    for i,names in candidates.items():
        if len(names)!=1 or tracks[i].get('nhc'):continue
        named=next(iter(names.values()));tracks[i]['name']=named['name']
        tracks[i]['europeanName']={**named,'matchMethod':'Unique GFS low near official impact region during the valid interval'}
        state['matched']+=1
    return state
