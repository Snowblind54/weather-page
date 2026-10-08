"""Shared, terrain-aware hourly heatmap samples; never labelled observations.

Fetch centrally every three hours instead of querying hundreds of locations for
each visitor. Keep six past and eight forecast hours for the observation slider.
"""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request

OUTPUT = pathlib.Path(__file__).resolve().parents[1]/'data/temperature-americas-model.json'
SPECS = {'canada':([41,-142],[84,-52],3,4), 'greenland':([59,-74],[84,-10],2,3)}

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
                    'hourly':'temperature_2m','past_hours':6,'forecast_hours':8,'timeformat':'unixtime','timezone':'UTC'}
            req=urllib.request.Request('https://api.open-meteo.com/v1/forecast?'+urllib.parse.urlencode(params),headers={'User-Agent':'NorthernWeather/8.100 (github.com/Snowblind54/weather-page)'})
            with urllib.request.urlopen(req,timeout=50) as response:payload=json.load(response)
            items=payload if isinstance(payload,list) else [payload]
            if len(items)!=len(chunk):raise ValueError('Incomplete '+name+' temperature grid')
            for point,item in zip(chunk,items):
                h=item.get('hourly') or {};times=h.get('time') or [];temps=h.get('temperature_2m') or []
                if len(times)<2 or len(times)!=len(temps):raise ValueError('Invalid '+name+' model hours')
                values=[round(t,2) if isinstance(t,(int,float)) and math.isfinite(t) and -90<t<60 else None for t in temps]
                if not any(t is not None for t in values):raise ValueError('Empty '+name+' model sample')
                series.append({'lat':point[0],'lon':point[1],'times':times,'temps':values})
        grids[name]={'latitudes':lats,'longitudes':lons,'series':series}
    return {'version':1,'generatedAt':int(dt.datetime.now(dt.timezone.utc).timestamp()),'refreshMinutes':180,
            'source':'Open-Meteo terrain-aware model temperature; not station observations','grids':grids}

if __name__=='__main__':
    data=collect();OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    OUTPUT.write_text(json.dumps(data,separators=(',',':'))+'\n')
    print('Shared Canada/Greenland grid samples:',sum(len(g['series']) for g in data['grids'].values()))
