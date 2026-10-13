"""Official UK/Irish CAP alerts distributed by Meteoalarm; stdlib only."""
import concurrent.futures
import datetime as dt
import json
import gzip
import html
import re
import pathlib
import urllib.parse
import xml.etree.ElementTree as ET
from update_latvia_warnings import download, text, polygon, NS

SOURCES = {
    'UK': ('United Kingdom', '🇬🇧', 'united-kingdom', 'Europe/London', 'UK Met Office'),
    'IE': ('Ireland', '🇮🇪', 'ireland', 'Europe/Dublin', 'Met Éireann'),
}
ATOM = {'a': 'http://www.w3.org/2005/Atom'}
COUNTIES = pathlib.Path(__file__).resolve().parents[1] / 'data/ireland-warning-counties.json.gz'


def parse_cap(payload, code, url, now, counties=None):
    root = ET.fromstring(payload)
    if root.tag != '{'+NS['cap']+'}alert':
        raise ValueError('Expected official CAP alert')
    if text(root, 'status') != 'Actual' or text(root, 'scope') != 'Public' or text(root, 'msgType') not in ('Alert', 'Update'):
        return []
    name, flag, _, timezone, service = SOURCES[code]
    infos = root.findall('cap:info', NS)
    english = [i for i in infos if text(i, 'language').lower().startswith('en')]
    if not english:
        raise ValueError('English official warning information missing')
    identifier = text(root, 'identifier')
    if not identifier:
        raise ValueError('Warning identifier missing')
    rows=[]
    for info_index, info in enumerate(english):
        level = text(info, 'severity')
        if level not in ('Moderate', 'Severe', 'Extreme'):
            continue
        expires = text(info, 'expires')
        if dt.datetime.fromisoformat(expires.replace('Z','+00:00')) <= now:
            continue
        effective = text(info, 'effective') or text(root, 'sent')
        onset = text(info, 'onset') or effective
        for value in (effective, onset, expires):
            if dt.datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None:
                raise ValueError('CAP validity must include timezone')
        for area_index, area in enumerate(info.findall('cap:area', NS)):
            shapes=[]
            for p in area.findall('cap:polygon', NS):
                ring=polygon(p.text)
                if not ring:
                    raise ValueError('Empty CAP warning polygon')
                shapes.append([ring])
            codes=[text(g,'value') for g in area.findall('cap:geocode',NS) if text(g,'valueName') in ('EMMA_ID','FIPS')]
            marine = code=='IE' and any(c.startswith('EI8') for c in codes)
            missing=[]
            if code=='IE' and not shapes and not marine:
                for geocode in dict.fromkeys(codes):
                    county=(counties or {}).get('geocodes',{}).get(geocode)
                    geometry=(counties or {}).get('counties',{}).get(county)
                    if geometry: shapes.extend(geometry)
                    else: missing.append(geocode)
            # Never replace an unknown official area with a guessed rectangle.
            rows.append({
                'country':name,'flag':flag,'identifier':f'{identifier}:{info_index}:{area_index}',
                'capIdentifier':identifier,'area':text(area,'areaDesc'),
                'event':text(info,'event'),'headline':text(info,'headline') or text(info,'event'),
                'level':level,'effective':effective,'onset':onset,'expires':expires,
                'description':html.unescape(re.sub(r'<[^>]*>', ' ', text(info,'description'))).strip(),
                'instruction':html.unescape(re.sub(r'<[^>]*>', ' ', text(info,'instruction'))).strip(),
                'certainty':text(info,'certainty'),'timeZone':timezone,
                'sourceName':service+' via Meteoalarm / EUMETNET',
                'sourceUrl':url,'sourcePage':text(info,'web') or 'https://meteoalarm.org/',
                'polygons':shapes,'circles':[],'marine':marine,
                'geometryIncomplete':bool(missing) or not shapes,
            })
    return rows


def load_europe(code, now):
    name, _, slug, _, _ = SOURCES[code]
    feed='https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-'+slug
    root=ET.fromstring(download(feed))
    if root.tag!='{'+ATOM['a']+'}feed' or root.findtext('a:id','',ATOM).split(':')[-1] != code:
        raise ValueError('Unexpected country warning Atom feed')
    urls=[]
    for entry in root.findall('a:entry',ATOM):
        links=[l.attrib.get('href','') for l in entry.findall('a:link',ATOM) if l.attrib.get('type')=='application/cap+xml']
        if not links: raise ValueError('Warning CAP link missing')
        for url in links:
            p=urllib.parse.urlparse(url)
            if p.scheme!='https' or p.netloc!='feeds.meteoalarm.org' or not p.path.startswith('/api/v1/warnings/feeds-'+slug+'/'):
                raise ValueError('Unexpected warning CAP URL')
            if url not in urls: urls.append(url)
    counties=json.loads(gzip.decompress(COUNTIES.read_bytes())) if code=='IE' else None
    rows=[];superseded=set()
    def fetch(url):
        data=download(url);alert=ET.fromstring(data)
        references=text(alert,'references').split()
        old=[r.split(',')[1] for r in references if len(r.split(','))==3]
        return parse_cap(data,code,url,now,counties),old
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for records,old in pool.map(fetch,urls):rows.extend(records);superseded.update(old)
    rows=[r for r in rows if r['capIdentifier'] not in superseded]
    return {'country':name,'updatedAt':now.isoformat(),'source':feed,'records':rows}
