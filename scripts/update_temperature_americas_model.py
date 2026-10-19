"""Shared, terrain-aware hourly heatmap samples; never labelled observations.

Fetch centrally every three hours instead of querying hundreds of locations for
each visitor. Keep six past and 24 forecast hours so delayed refreshes still
have valid model values for the observation slider.
"""
import datetime as dt
import http.client
import json
import math
import pathlib
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request

OUTPUT = pathlib.Path(__file__).resolve().parents[1]/'data/temperature-americas-model.json'
SPECS = {'canada':([41,-142],[84,-52],3,4), 'greenland':([59,-74],[84,-10],2,3)}

def fetch_samples(request):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=75) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504):
                raise
            delay = 20 * (attempt + 1)
            retry_after = error.headers.get('Retry-After') if error.headers else None
            if retry_after and retry_after.isdigit():
                delay = max(delay, min(120, int(retry_after)))
        except (urllib.error.URLError, TimeoutError, ConnectionError,
                http.client.IncompleteRead, json.JSONDecodeError, UnicodeDecodeError):
            delay = 20 * (attempt + 1)
        if attempt == 2:
            raise RuntimeError('Canada/Greenland model provider unavailable after three attempts')
        print('Canada/Greenland provider unavailable; retrying in', delay, 'seconds', flush=True)
        time.sleep(delay)

def axis(start,end,step):
    out=[]
    while start<end-1e-8:
        out.append(round(start,4));start+=step
    out.append(end)
    return out

def collect():
    grids={}
    first=True
    for name,(southwest,northeast,lat_step,lon_step) in SPECS.items():
        lats=axis(southwest[0],northeast[0],lat_step);lons=axis(southwest[1],northeast[1],lon_step)
        points=[(lat,lon) for lat in lats for lon in lons];series=[]
        for offset in range(0,len(points),100):
            # Stay below the provider's per-minute location budget.
            if not first:time.sleep(12)
            first=False
            chunk=points[offset:offset+100]
            params={'latitude':','.join(str(p[0]) for p in chunk),'longitude':','.join(str(p[1]) for p in chunk),
                    'hourly':'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m','wind_speed_unit':'ms','past_hours':6,'forecast_hours':24,'timeformat':'unixtime','timezone':'UTC'}
            req=urllib.request.Request('https://api.open-meteo.com/v1/forecast?'+urllib.parse.urlencode(params),headers={'User-Agent':'NorthernWeather/8.100 (github.com/Snowblind54/weather-page)'})
            payload=fetch_samples(req)
            items=payload if isinstance(payload,list) else [payload]
            if len(items)!=len(chunk):raise ValueError('Incomplete '+name+' temperature grid')
            for point,item in zip(chunk,items):
                h=item.get('hourly') or {};times=h.get('time') or [];temps=h.get('temperature_2m') or []
                if len(times)<2 or len(times)!=len(temps):raise ValueError('Invalid '+name+' model hours')
                if any(not isinstance(t,(int,float)) or isinstance(t,bool) or not math.isfinite(t) or (i and t<=times[i-1]) for i,t in enumerate(times)):
                    raise ValueError('Invalid '+name+' model timestamps')
                now=dt.datetime.now(dt.timezone.utc).timestamp()
                if times[0]>now-2*3600 or times[-1]<now+12*3600:
                    raise ValueError('Insufficient '+name+' model time coverage')
                values=[round(t,2) if isinstance(t,(int,float)) and math.isfinite(t) and -90<t<60 else None for t in temps]
                if not any(t is not None for t in values):raise ValueError('Empty '+name+' model sample')
                speeds=h.get('wind_speed_10m') or [];dirs=h.get('wind_direction_10m') or [];gusts=h.get('wind_gusts_10m') or []
                if any(len(a)!=len(times) for a in (speeds,dirs,gusts)):raise ValueError('Incomplete wind hours')
                wind=[]
                for speed,direction,gust in zip(speeds,dirs,gusts):
                    valid=lambda v,limit:isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and 0<=v<=limit
                    if not valid(speed,100) or not valid(direction,360):wind.append([None,None,None]);continue
                    angle=math.radians(direction)
                    wind.append([round(-speed*math.sin(angle),3),round(-speed*math.cos(angle),3),round(gust,2) if valid(gust,100) else None])
                series.append({'lat':point[0],'lon':point[1],'times':times,'temps':values,'wind':wind})
        grids[name]={'latitudes':lats,'longitudes':lons,'series':series}
    return {'version':1,'generatedAt':int(dt.datetime.now(dt.timezone.utc).timestamp()),'refreshMinutes':180,
            'source':'Open-Meteo terrain-aware model temperature and wind; not station observations','grids':grids}

def main():
    data=collect();OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=OUTPUT.parent,delete=False) as handle:
        json.dump(data,handle,separators=(',',':'),allow_nan=False)
        handle.write('\n')
        temporary=pathlib.Path(handle.name)
    temporary.replace(OUTPUT)
    print('Shared Canada/Greenland grid samples:',sum(len(g['series']) for g in data['grids'].values()))

if __name__=='__main__':
    main()
