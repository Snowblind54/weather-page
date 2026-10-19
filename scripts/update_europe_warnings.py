"""Official European CAP alerts distributed by Meteoalarm; stdlib only."""
import concurrent.futures
import datetime as dt
import json
import gzip
import html
import re
import pathlib
import time
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from update_latvia_warnings import download, text, polygon, NS

SOURCES = {
    'UK': ('United Kingdom', '🇬🇧', 'united-kingdom', 'Europe/London', 'UK Met Office'),
    'IE': ('Ireland', '🇮🇪', 'ireland', 'Europe/Dublin', 'Met Éireann'),
    'DE': ('Germany', '🇩🇪', 'germany', 'Europe/Berlin', 'Deutscher Wetterdienst (DWD)'),
    'NL': ('Netherlands', '🇳🇱', 'netherlands', 'Europe/Amsterdam', 'KNMI'),
    'BE': ('Belgium', '🇧🇪', 'belgium', 'Europe/Brussels', 'Royal Meteorological Institute (RMI/KMI)'),
    'LU': ('Luxembourg', '🇱🇺', 'luxembourg', 'Europe/Luxembourg', 'MeteoLux / ANA'),
    'CZ': ('Czechia', '🇨🇿', 'czechia', 'Europe/Prague', 'Czech Hydrometeorological Institute (ČHMÚ)'),
    'SK': ('Slovakia', '🇸🇰', 'slovakia', 'Europe/Bratislava', 'Slovak Hydrometeorological Institute (SHMÚ)'),
}
ATOM = {'a': 'http://www.w3.org/2005/Atom'}
COUNTIES = pathlib.Path(__file__).resolve().parents[1] / 'data/ireland-warning-counties.json.gz'
REGIONS = pathlib.Path(__file__).resolve().parents[1] / 'data/western-warning-regions.json.gz'
CENTRAL_REGIONS = pathlib.Path(__file__).resolve().parents[1] / 'data/central-warning-regions.json.gz'


def fetch_warning(url):
    """A temporary failure of one CAP file must not lose the whole country."""
    for attempt in range(3):
        try:
            return download(url)
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(attempt + 1)


def parse_cap(payload, code, url, now, counties=None, regions=None):
    root = ET.fromstring(payload)
    if root.tag != '{'+NS['cap']+'}alert':
        raise ValueError('Expected official CAP alert')
    if text(root, 'status') != 'Actual' or text(root, 'scope') != 'Public' or text(root, 'msgType') not in ('Alert', 'Update'):
        return []
    name, flag, _, timezone, service = SOURCES[code]
    infos = root.findall('cap:info', NS)
    english = [i for i in infos if text(i, 'language').lower().startswith('en')]
    # Retain official text if a service publishes only its national language.
    if not english:
        if code in ('UK', 'IE') or not infos:
            raise ValueError('English official warning information missing')
        language = text(infos[0], 'language')
        english = [i for i in infos if text(i, 'language') == language]
    identifier = text(root, 'identifier')
    if not identifier:
        raise ValueError('Warning identifier missing')
    rows=[]
    for info_index, info in enumerate(english):
        official_severity = text(info, 'severity')
        level = official_severity
        awareness = next((text(p, 'value').split(';')[0].strip()
                          for p in info.findall('cap:parameter', NS)
                          if text(p, 'valueName') == 'awareness_level'), None)
        if awareness is not None:
            # In DWD CAP, Minor can be an actual yellow warning. Use the
            # service's explicit Meteoalarm awareness level, never severity alone.
            level = {'2':'Moderate', '3':'Severe', '4':'Extreme'}.get(awareness)
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
            geocodes=[(text(g,'valueName'), text(g,'value')) for g in area.findall('cap:geocode',NS)]
            codes=[value for kind,value in geocodes if kind in ('EMMA_ID','FIPS')]
            marine = ((code=='IE' and any(c.startswith('EI8') for c in codes)) or
                      (code=='NL' and any(c.startswith('NL8') for c in codes)) or
                      (code=='DE' and any(kind=='WARNCELLID' and value.startswith(('2','5')) for kind,value in geocodes)))
            missing=[]
            if code=='IE' and not shapes and not marine:
                for geocode in dict.fromkeys(codes):
                    county=(counties or {}).get('geocodes',{}).get(geocode)
                    geometry=(counties or {}).get('counties',{}).get(county)
                    if geometry: shapes.extend(geometry)
                    else: missing.append(geocode)
            if not shapes and code in ('DE','BE'):
                # Match exact official codes, preserving islands and holes.
                for kind,value in dict.fromkeys(geocodes):
                    geometry=(regions or {}).get(code,{}).get(kind+':'+value)
                    if geometry:
                        shapes.extend(geometry)
                        break  # Alternate geocodes describe the same area.
                if not shapes: missing.extend(value for _,value in geocodes)
            if not shapes and code in ('CZ','SK'):
                # Multiple codes of one kind identify separate warned areas.
                # Prefer municipalities over province aliases; an unknown
                # municipality must never fall back to painting its whole region.
                for kind in ('CISORP','EMMA_ID','EMMAID','NUTS3'):
                    values=list(dict.fromkeys(value for key,value in geocodes if key==kind))
                    if not values: continue
                    for value in values:
                        key=('EMMA_ID' if kind=='EMMAID' else kind)+':'+value
                        geometry=(regions or {}).get(code,{}).get(key)
                        if geometry: shapes.extend(geometry)
                        else: missing.append(value)
                    break
            # Never replace an unknown official area with a guessed rectangle.
            rows.append({
                'country':name,'flag':flag,'identifier':f'{identifier}:{info_index}:{area_index}',
                'capIdentifier':identifier,'area':text(area,'areaDesc'),
                'event':text(info,'event'),'headline':text(info,'headline') or text(info,'event'),
                'level':level,'officialSeverity':official_severity,
                'language':text(info,'language'),'effective':effective,'onset':onset,'expires':expires,
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
    root=ET.fromstring(fetch_warning(feed))
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
    regions=json.loads(gzip.decompress(REGIONS.read_bytes()))['regions'] if code in ('DE','BE') else None
    if code in ('CZ','SK'):
        catalogue=json.loads(gzip.decompress(CENTRAL_REGIONS.read_bytes()))
        regions=catalogue['regions']
        for key,targets in catalogue.get('aliases',{}).get(code,{}).items():
            regions[code][key]=[shape for target in targets for shape in regions[code][target]]
    rows=[];superseded=set()
    def fetch(url):
        data=fetch_warning(url);alert=ET.fromstring(data)
        references=text(alert,'references').split()
        old=[r.split(',')[1] for r in references if len(r.split(','))==3]
        return parse_cap(data,code,url,now,counties,regions),old
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for records,old in pool.map(fetch,urls):rows.extend(records);superseded.update(old)
    rows=[r for r in rows if r['capIdentifier'] not in superseded]
    return {'country':name,'updatedAt':now.isoformat(),'source':feed,'records':rows}
