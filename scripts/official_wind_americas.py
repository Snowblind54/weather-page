"""DMI Greenland and ECCC/MSC Canada measured wind adapters."""
import datetime as dt
import urllib.parse
import update_official_wind as core

DMI='https://opendataapi.dmi.dk/v2/metObs/collections/'
ECCC='https://api.weather.gc.ca/collections/'

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
