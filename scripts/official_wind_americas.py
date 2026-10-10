"""DMI Greenland, ECCC/MSC Canada and NOAA/NDBC Florida measured wind adapters."""
import concurrent.futures as futures
import datetime as dt
import urllib.parse
import update_official_wind as core

DMI='https://opendataapi.dmi.dk/v2/metObs/collections/'
ECCC='https://api.weather.gc.ca/collections/'
NDBC='https://www.ndbc.noaa.gov/data/realtime2/'

# Active NOAA/NDBC C-MAN shore stations around Florida. These are official
# National Data Buoy Center land/coastal stations rather than private PWS data.
FLORIDA_NDBC={
    'CDRF1':('Cedar Key · NOAA/NDBC coast',29.136,-83.029),
    'KTNF1':('Keaton Beach · NOAA/NDBC coast',29.819,-83.593),
    'LONF1':('Long Key · NOAA/NDBC coast',24.844,-80.864),
    'SAUF1':('St. Augustine · NOAA/NDBC coast',29.857,-81.264),
    'VENF1':('Venice · NOAA/NDBC coast',27.072,-82.453),
}

def features(base,params):
    url=base+'?'+urllib.parse.urlencode(params)
    for _ in range(12):
        payload=core.download_json(url)
        yield from payload.get('features') or []
        nxt=next((l.get('href') for l in payload.get('links',[]) if l.get('rel')=='next'),None)
        if not nxt:return
        if not nxt.startswith((DMI,ECCC)):raise ValueError('Unexpected wind pagination host')
        url=nxt
    raise ValueError('Wind pagination exceeded bounded recent window')

def interval(now):
    return (now-dt.timedelta(hours=3)).isoformat()+'/'+now.isoformat()

def load_greenland(now):
    metadata={'features':list(features(DMI+'station/items',{'status':'Active','bbox':'-74,59,-10,84','limit':1000}))}
    # Reuse the same DMI definitions and timestamp alignment as Denmark.
    parameters=('wind_speed','wind_max','wind_dir')
    payloads={p:{'features':list(features(DMI+'observation/items',{'parameterId':p,'bbox':'-74,59,-10,84','datetime':interval(now),'limit':10000}))} for p in parameters}
    return core.parse_denmark(payloads,metadata,country='GL',provider_country='GRL',now=now)

def quality_value(props,key,unit=None):
    if props.get(key+'-qa')!=100:return None
    value=core.number(props.get(key),360)
    if value is None:return None
    if unit:
        native=props.get(key+'-uom')
        if native=='km/h':value/=3.6
        elif native!='m/s':return None
    return value

def parse_canada(payload,metadata):
    grouped={}
    for f in payload:
        p=f.get('properties') or {};code=str(p.get('msc_id-value') or '')
        coords=(f.get('geometry') or {}).get('coordinates') or []
        if code not in metadata or len(coords)<2:continue
        speed=quality_value(p,'avg_wnd_spd_10m_pst10mts',True)
        # MSC reports the measured instantaneous maximum independently of
        # its threshold-qualified aviation gust code. Do not synthesize gusts.
        gust=quality_value(p,'max_wnd_spd_10m_pst10mts',True)
        direction=quality_value(p,'avg_wnd_dir_10m_pst10mts')
        if speed is None and gust is None:continue
        grouped.setdefault(code,[coords[1],coords[0],[]])[2].append((p['obs_date_tm'],speed,gust,direction))
    return [core.station('CA',code,metadata[code].get('name') or code,lat,lon,rows) for code,(lat,lon,rows) in grouped.items()]

def load_canada(now):
    metadata={}
    for f in features(ECCC+'swob-stations/items',{'limit':1000,'f':'json'}):
        p=f.get('properties') or {}
        if p.get('data_provider')=='MSC':metadata[str(p.get('msc_id') or f.get('id') or '')]=p
    keys=['msc_id-value','stn_nam-value','obs_date_tm']
    for field in ('avg_wnd_spd_10m_pst10mts','avg_wnd_dir_10m_pst10mts','max_wnd_spd_10m_pst10mts'):
        keys.extend([field,field+'-qa',field+'-uom'])
    return parse_canada(features(ECCC+'swob-realtime/items',{'datetime':interval(now),'limit':10000,'f':'json','_is-minutely_obs-value':'false','sortby':'-obs_date_tm','properties':','.join(keys)}),metadata)


def ndbc_value(value,maximum=100):
    if value in (None,'','MM'):return None
    return core.number(value,maximum)


def parse_ndbc_standard(raw,code,name,lat,lon,now):
    text=raw.decode('utf-8','replace') if isinstance(raw,(bytes,bytearray)) else str(raw)
    lines=[line.strip() for line in text.splitlines() if line.strip()]
    if not lines:return None
    header=next((line for line in lines if line.startswith('#YY') or line.startswith('# YYYY') or line.startswith('#YYYY')),None)
    if not header:raise ValueError('NDBC standard-met header missing for '+code)
    columns=header.lstrip('#').split()
    aliases={'YY':'YY','YYYY':'YY','MM':'MO','DD':'DD','hh':'HH','mm':'MI','WDIR':'WDIR','WSPD':'WSPD','GST':'GST'}
    indexes={aliases[c]:i for i,c in enumerate(columns) if c in aliases}
    if not all(k in indexes for k in ('YY','MO','DD','HH','MI','WSPD')):raise ValueError('NDBC wind columns missing for '+code)
    cutoff=now-dt.timedelta(hours=24)
    rows=[]
    for line in lines:
        if line.startswith('#'):continue
        parts=line.split()
        if len(parts)<len(columns):continue
        try:
            year=int(parts[indexes['YY']]);year=year+2000 if year<100 else year
            stamp=dt.datetime(year,int(parts[indexes['MO']]),int(parts[indexes['DD']]),int(parts[indexes['HH']]),int(parts[indexes['MI']]),tzinfo=dt.timezone.utc)
        except (ValueError,IndexError):
            continue
        if stamp<cutoff or stamp>now+dt.timedelta(minutes=5):continue
        speed=ndbc_value(parts[indexes['WSPD']])
        gust=ndbc_value(parts[indexes['GST']]) if 'GST' in indexes else None
        direction=ndbc_value(parts[indexes['WDIR']],360) if 'WDIR' in indexes else None
        if speed is None and gust is None:continue
        rows.append((int(stamp.timestamp()),speed,gust,direction))
    if not rows:return None
    # NDBC files are newest-first; core.station de-duplicates and sorts them.
    return core.station('US','NDBC-'+code,name,lat,lon,rows[-200:])


def load_florida_ndbc(now):
    def one(item):
        code,(name,lat,lon)=item
        raw=core.download(NDBC+code+'.txt')
        return parse_ndbc_standard(raw,code,name,lat,lon,now)
    result=[]
    with futures.ThreadPoolExecutor(max_workers=5) as pool:
        jobs={pool.submit(one,item):item[0] for item in FLORIDA_NDBC.items()}
        for job in futures.as_completed(jobs):
            try:
                station=job.result()
                if station:result.append(station)
            except Exception as error:
                print('US NOAA/NDBC '+jobs[job]+' unavailable: '+str(error))
    return result


# update_official_wind.main imports this module before constructing its loader
# list. Extend the existing Florida METAR loader at import time so airports stay
# available while NOAA/NDBC contributes official coastal C-MAN stations.
_load_florida_airports=core.load_florida

def load_florida(now):
    airports=_load_florida_airports(now)
    coast=load_florida_ndbc(now)
    return airports+coast

core.load_florida=load_florida
core.SOURCES['US'].update(
    name='NOAA / National Weather Service / National Data Buoy Center',
    url='https://www.ndbc.noaa.gov/',
    period='Florida official observations: METAR/SPECI airport winds plus NOAA/NDBC C-MAN coastal stations. NDBC shore stations report measured wind and gusts in m/s; the map retains the latest 24 hours without filling missing values.'
)
