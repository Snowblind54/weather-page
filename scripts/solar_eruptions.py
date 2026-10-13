"""Compact NASA DONKI CME analyses and the current NOAA G scale."""
import math
from urllib.parse import urlparse
from datetime import datetime, timezone


def stamp(value):
    try:
        t=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return t.timestamp() if t.tzinfo else None
    except (TypeError,ValueError):return None


def number(value):
    if value is None or isinstance(value,bool):return None
    try:
        n=float(value)
        return n if math.isfinite(n) else None
    except (TypeError,ValueError):return None


def nasa_link(value):
    p=urlparse(str(value or ''))
    return value if p.scheme=='https' and p.hostname in ('ccmc.gsfc.nasa.gov','kauai.ccmc.gsfc.nasa.gov','webtools.ccmc.gsfc.nasa.gov') else None


def compact_cmes(payload, now):
    if not isinstance(payload,list):raise ValueError('Unexpected DONKI CME schema')
    selected={}
    for event in payload:
        if not isinstance(event,dict):continue
        detected=stamp(event.get('startTime'));identifier=event.get('activityID')
        if not identifier or detected is None or not now-7*86400<=detected<=now+300:continue
        previous=selected.get(identifier)
        if previous is None or (stamp(event.get('submissionTime')) or 0)>=(stamp(previous.get('submissionTime')) or 0):selected[identifier]=event
    entries=[]
    for identifier,event in selected.items():
        analyses=[a for a in event.get('cmeAnalyses') or [] if isinstance(a,dict)]
        primary=[a for a in analyses if a.get('isMostAccurate') is True]
        analysis=max(primary or analyses,key=lambda a:stamp(a.get('submissionTime')) or 0,default={})
        models=[m for m in analysis.get('enlilList') or [] if isinstance(m,dict) and stamp(m.get('modelCompletionTime')) is not None]
        # A newer miss forecast must replace an older hit; never choose merely the latest hit.
        model=max(models,key=lambda m:stamp(m.get('modelCompletionTime')),default={})
        arrival=model.get('estimatedShockArrivalTime') if stamp(model.get('estimatedShockArrivalTime')) is not None else None
        earth='glancing' if model.get('isEarthGB') is True else 'minor' if model.get('isEarthMinorImpact') is True else 'expected' if arrival else 'not-predicted' if model else 'unassessed'
        speed=number(analysis.get('speed'))
        # Do not infer an error bar from simulation duration or from older runs.
        uncertainty=number(model.get('arrivalUncertaintyHours'))
        if uncertainty is not None and not 0<uncertainty<=72:uncertainty=None
        entries.append({'id':identifier,'detectedAt':event['startTime'],
            'speed':speed if speed is not None and speed>0 else None,
            'earthImpact':earth,'estimatedArrival':arrival,'arrivalUncertaintyHours':uncertainty,
            'modelTime':model.get('modelCompletionTime'),'modelUrl':nasa_link(model.get('link')),
            'combinedForecast':len(model.get('cmeIDs') or [])>1,
            'analysisTime':analysis.get('submissionTime'),'sourceUrl':nasa_link(event.get('link')),
            'note':str(event.get('note') or '')[:3500]})
    entries.sort(key=lambda e:stamp(e['detectedAt']),reverse=True)
    return {'fetchedAt':int(now),'source':'NASA DONKI / Moon to Mars Space Weather Analysis Office · experimental WSA-ENLIL forecasts','entries':entries}


def current_g_scale(payload, now):
    current=payload.get('0') if isinstance(payload,dict) else None
    if not isinstance(current,dict):raise ValueError('NOAA current storm scale missing')
    n=number((current.get('G') or {}).get('Scale'))
    t=str(current.get('DateStamp') or '')+'T'+str(current.get('TimeStamp') or '')+'Z'
    if n is None or n!=int(n) or not 0<=n<=5 or stamp(t) is None or stamp(t)>now+300:raise ValueError('Invalid NOAA current G scale')
    return {'scale':int(n),'time':t,'fetchedAt':int(now),'source':'NOAA SWPC current geomagnetic storm scale'}
