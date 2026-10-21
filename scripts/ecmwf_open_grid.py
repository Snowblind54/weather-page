"""IFS open-data surface tiers and bounded complete-cycle selection."""
import json
from datetime import timedelta


def url(root,run,step,suffix,resolution=.1,token=None):
    if resolution not in (.1,.25):raise ValueError('Unsupported IFS grid spacing')
    token=token or ('0p1' if resolution==.1 else '0p25')
    level='-sfc' if resolution==.1 else ''
    return root+f'{run:%Y%m%d}/{run:%H}z/ifs/{token}/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc{level}.{suffix}'


def index(root,run,step,request,parameters,resolution=.1):
    # ECMWF documentation uses 0p1; some mirrors expose the equivalent 0p10.
    tokens=('0p1','0p10') if resolution==.1 else ('0p25',)
    error=None
    for token in tokens:
        try:
            address=url(root,run,step,'index',resolution,token)
            rows=[json.loads(line) for line in request(address).decode().splitlines() if line.strip()]
            selected={r['param']:{**r,'_grib_url':url(root,run,step,'grib2',resolution,token),'_grid_spacing':resolution}
                      for r in rows if r.get('levtype')=='sfc' and r.get('param') in parameters}
            required=parameters-({'10fg','ptype'} if step==0 else set())
            if not required<=selected.keys():raise ValueError('Missing ECMWF surface fields')
            return selected
        except Exception as exc:error=exc
    raise error


def choose_cycle(now,probe,cached=lambda run,res:False,horizon=90,minimum_hours=72):
    candidate=(now-timedelta(hours=5)).replace(minute=0,second=0,microsecond=0)
    candidate=candidate.replace(hour=candidate.hour//6*6)
    # Prefer the newest complete fine cycle, including the previous run during
    # the scheduled two-hour fine-tier delay. Never mix tiers inside a cycle.
    for resolution in (.1,.25):
        for attempt in range(3):
            run=candidate-timedelta(hours=6*attempt)
            if run+timedelta(hours=horizon-1)<now+timedelta(hours=minimum_hours):continue
            if cached(run,resolution):return run,resolution,None,None
            try:return run,resolution,probe(run,0,resolution),probe(run,horizon,resolution)
            except Exception as error:print('IFS tier not ready:',run.isoformat(),resolution,str(error)[:180],flush=True)
    raise RuntimeError('No complete recent ECMWF cycle; previous forecast retained')
