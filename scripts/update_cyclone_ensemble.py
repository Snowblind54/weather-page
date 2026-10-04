"""Match NOAA GEFS member lows to GFS tracks; publish descriptive ensemble spread.

The GFS projected path is never replaced. Shading is an 80th-percentile radial
spread around the median of matched member centres, not a calibrated probability.
Only unambiguous, one-to-one trajectory matches and adequately supported times
are published. Ensemble native positions are six-hourly.
"""
import concurrent.futures as futures
import datetime as dt
import json
import math
import pathlib
import tempfile
import time
import urllib.error
import urllib.request

import numpy as np
from scipy.optimize import linear_sum_assignment
import update_cyclones as c

OUTPUT = c.OUTPUT.with_name('cyclone-ensemble.json')
MEMBERS = ['c00']+[f'p{i:02d}' for i in range(1, 31)]
STEPS = list(range(0, 97, 6))
MIN_SUPPORT = 10
METHOD_VERSION = 1
BUCKET = 'https://noaa-gefs-pds.s3.amazonaws.com'


def field_url(run, member, hour):
    return (f'{BUCKET}/gefs.{run:%Y%m%d}/{run.hour:02d}/atmos/pgrb2ap5/'
            f'ge{member}.t{run.hour:02d}z.pgrb2a.0p50.f{hour:03d}')


def pressure_range(index):
    records = [line.split(':') for line in index.splitlines() if line.strip()]
    matches = [i for i, row in enumerate(records) if len(row)>4 and row[3:5]==['PRMSL', 'mean sea level']]
    if len(matches)!=1:
        raise ValueError('Expected one GEFS sea-level pressure record')
    i = matches[0]; start = int(records[i][1])
    end = int(records[i+1][1])-1 if i+1<len(records) else None
    if start<0 or (end is not None and end<start):
        raise ValueError('Invalid GEFS byte range')
    return start, end


def read_url(url, deadline, start=None, end=None):
    for attempt in range(2):
        if time.monotonic()>=deadline:
            raise TimeoutError('Ensemble collection time budget exceeded')
        headers = {'User-Agent': 'NorthernWeather/8.55 (github.com/Snowblind54/weather-page)'}
        if start is not None:
            headers['Range'] = f'bytes={start}-'+('' if end is None else str(end))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
                if start is not None and (response.status!=206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-')):
                    raise ValueError('GEFS server did not honor field byte range')
                raw = response.read(4*1024*1024+1)
                if len(raw)>4*1024*1024:
                    raise ValueError('GEFS field response too large')
                return raw
        except urllib.error.HTTPError as error:
            if error.code in (403, 404) or attempt:
                raise
        except (OSError, TimeoutError):
            if attempt:
                raise
        time.sleep(.5)


def decode_pressure(raw, valid, member):
    import eccodes as ec
    if raw[:4]!=b'GRIB':
        raise ValueError('GEFS field is not GRIB')
    g = ec.codes_new_from_message(raw)
    try:
        stamp = dt.datetime.strptime(str(ec.codes_get(g, 'validityDate'))+f"{ec.codes_get(g, 'validityTime'):04d}", '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc)
        if int(stamp.timestamp())!=valid or ec.codes_get(g, 'shortName')!='prmsl' or ec.codes_get(g, 'typeOfLevel')!='meanSea':
            raise ValueError('GEFS field parameter/time mismatch')
        if ec.codes_get(g, 'perturbationNumber')!=int(member[1:]):
            raise ValueError('GEFS member mismatch')
        lat = ec.codes_get_array(g, 'latitudes')
        lon = (ec.codes_get_array(g, 'longitudes')+180)%360-180
        values = ec.codes_get_values(g)/100
        mask = (lat>=20)&(lat<=82)&(lon>=-85)&(lon<=45)
        lat, lon, values = lat[mask], lon[mask], values[mask]
        lats, lons = np.unique(lat), np.unique(lon)
        pressure = np.full((len(lats), len(lons)), np.nan)
        pressure[np.searchsorted(lats, lat), np.searchsorted(lons, lon)] = values
        if not np.isfinite(pressure).all() or pressure.min()<850 or pressure.max()>1100:
            raise ValueError('Invalid/incomplete GEFS pressure field')
        return lats, lons, pressure
    finally:
        ec.codes_release(g)


def member_tracks(run, member, deadline):
    frames = []
    for hour in STEPS:
        url = field_url(run, member, hour)
        start, end = pressure_range(read_url(url+'.idx', deadline).decode())
        valid = int(run.timestamp())+hour*3600
        lats, lons, pressure = decode_pressure(read_url(url, deadline, start, end), valid, member)
        zero = np.zeros_like(pressure)
        lows = c.centres(lats, lons, {'pressure': pressure, 'u': zero, 'v': zero, 'gust': zero}, valid)
        frames.append((valid, lows))
    # Four native positions guarantee at least 18 hours of persistent tracking.
    return c.track_frames(frames)


def match_score(reference, candidate):
    samples = []
    for p in candidate['points']:
        q = c.point_at(reference['points'], p['time'])
        if q is not None:
            samples.append((c.distance(p, q), abs(p['pressure']-q['pressure']), p['time']))
    if len(samples)<3 or samples[-1][2]-samples[0][2]<12*3600:
        return None
    # Anchor association to the first 18 overlapping hours, before forecast spread
    # naturally increases. Full-trajectory matching prevents nearest-low swaps.
    anchor = [s for s in samples if s[2]<=samples[0][2]+18*3600]
    distances = [s[0] for s in anchor]
    pressure = [s[1] for s in anchor]
    if min(distances)>250 or np.median(distances)>350 or np.median(pressure)>12:
        return None
    return float(np.median(distances)+8*np.median(pressure))


def match_member(references, tracks):
    if not references or not tracks:
        return {}
    costs = np.full((len(references), len(tracks)+len(references)), 1e6)
    for i, reference in enumerate(references):
        for j, track in enumerate(tracks):
            score = match_score(reference, track)
            if score is not None:
                costs[i, j] = score
    result = {}
    for i, j in zip(*linear_sum_assignment(costs)):
        if j>=len(tracks) or costs[i,j]>=1e6:
            continue
        alternatives = [costs[i,k] for k in range(len(tracks)) if k!=j and costs[i,k]<1e6]
        competing = [costs[k,j] for k in range(len(references)) if k!=i and costs[k,j]<1e6]
        if any(score<=costs[i,j]+75 for score in alternatives+competing):
            continue  # Split/merge or two similarly plausible lows: omit the match.
        result[references[i]['id']] = tracks[j]
    return result


def spread_frames(members, stamp, available):
    frames = []
    required = max(MIN_SUPPORT, math.ceil(available*.5))
    for hour in STEPS:
        valid = stamp+hour*3600
        points = [p for track in members for p in track['points'] if p['time']==valid]
        if len(points)<required:
            continue
        centre = {'lat': float(np.median([p['lat'] for p in points])), 'lon': float(np.median([p['lon'] for p in points]))}
        radius = float(np.percentile([c.distance(centre, p) for p in points], 80))
        frames.append({'time': valid, 'lat': round(centre['lat'], 4), 'lon': round(centre['lon'], 4),
                       'radiusKM': round(radius, 1), 'support': len(points)})
    return frames


def build_snapshot(gfs, results, now):
    systems = {s['id']: [] for s in gfs['systems']}
    for member, tracks in results.items():
        for id, track in match_member(gfs['systems'], tracks).items():
            systems[id].append({'member': member, 'points': [{k:p[k] for k in ('time','lat','lon','pressure')} for p in track['points']]})
    output = []
    for id, members in systems.items():
        if len(members)>=MIN_SUPPORT:
            frames = spread_frames(members, gfs['modelRun'], len(results))
            if frames:
                output.append({'id': id, 'members': members, 'frames': frames})
    return {'version': 1, 'methodVersion': METHOD_VERSION, 'modelRun': gfs['modelRun'], 'generatedAt': int(now.timestamp()),
            'forecastEnd': gfs['modelRun']+96*3600, 'stepHours': 6, 'expectedMembers': len(MEMBERS),
            'availableMembers': len(results), 'status': 'ok' if len(results)==len(MEMBERS) else 'partial',
            'source': 'NOAA / NCEP GEFS', 'sourceUrl': 'https://www.nco.ncep.noaa.gov/pmb/products/gens/',
            'spreadPercentile': 80, 'minSupport': MIN_SUPPORT,
            'method': 'Median matched centres with 80th-percentile radial spread. Six-hourly GEFS; ambiguous matches omitted. Descriptive spread, not a calibrated probability or wind footprint.',
            'gfsSystems': sorted(systems), 'systems': output}


def main():
    now = dt.datetime.now(dt.timezone.utc)
    gfs = json.loads(c.OUTPUT.read_text())
    if gfs.get('status')!='ok' or now.timestamp()-gfs['modelRun']>18*3600:
        raise ValueError('A current GFS snapshot is required for ensemble matching')
    try:
        previous = json.loads(OUTPUT.read_text())
    except (OSError, ValueError):
        previous = {}
    if (previous.get('status')=='ok' and previous.get('methodVersion')==METHOD_VERSION and
        previous.get('modelRun')==gfs['modelRun'] and previous.get('gfsSystems')==sorted(s['id'] for s in gfs['systems'])):
        print('Reusing ensemble tracks for unchanged GFS run', flush=True)
        return
    run = dt.datetime.fromtimestamp(gfs['modelRun'], dt.timezone.utc)
    results = {}; errors = {}; deadline = time.monotonic()+480
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        pending = {pool.submit(member_tracks, run, member, deadline): member for member in MEMBERS}
        for task in futures.as_completed(pending):
            member = pending[task]
            try:
                results[member] = task.result()
                print('GEFS',member,':',len(results[member]),'tracked lows',flush=True)
            except Exception as error:
                errors[member] = str(error)
                print('GEFS',member,'unavailable:',str(error),flush=True)
    if len(results)<20:
        raise ValueError(f'Only {len(results)}/31 complete ensemble members; retaining the previous snapshot')
    snapshot = build_snapshot(gfs, results, now)
    if errors:
        snapshot['unavailableMembers'] = sorted(errors)
    raw = json.dumps(snapshot, separators=(',', ':'), ensure_ascii=False, allow_nan=False)+'\n'
    with tempfile.NamedTemporaryFile(mode='w',dir=OUTPUT.parent,delete=False) as temp:
        temp.write(raw); name = temp.name
    pathlib.Path(name).replace(OUTPUT)
    print('Published ensemble:',len(results),'/31 members;',len(snapshot['systems']),'supported GFS systems;',len(raw.encode()),'bytes',flush=True)


if __name__=='__main__':
    main()
