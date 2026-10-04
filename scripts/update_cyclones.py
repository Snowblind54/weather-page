"""Track closed low-pressure centres in NOAA GFS, not an official storm catalogue.

A consistent 0.5-degree model run supplies pressure and 10 m wind over the North
Atlantic / northern Europe. Tracks stop at missing centres, split/merge events
or coverage limits; a forecast line is not an uncertainty cone or warning.
"""
import concurrent.futures as futures
import datetime as dt
import json
import math
import pathlib
import tempfile
import time
import urllib.parse
import urllib.request

import numpy as np
from scipy.ndimage import gaussian_filter, minimum_filter
from scipy.optimize import linear_sum_assignment
import contourpy
from cyclone_names import add_european_names

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / 'data/cyclones.json'
FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl'
BOUNDS = [[20, -85], [82, 45]]
STEPS = list(range(0, 97, 3))


def distance(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    dlat, dlon = lat2-lat1, math.radians(b['lon']-a['lon'])
    return 6371 * 2 * math.asin(min(1, math.sqrt(math.sin(dlat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2)))


def display_region(lat, lon):
    return -80 <= lon <= 40 and 25 <= lat <= 78 and (lon < -12 or lat >= 45)


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'NorthernWeather/8.47 (github.com/Snowblind54/weather-page)'})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read()
        except Exception:
            if attempt:
                raise
            time.sleep(2)


def grid_url(run, step):
    params = dict(file=f'gfs.t{run.hour:02d}z.pgrb2full.0p50.f{step:03d}',
                  lev_mean_sea_level='on', lev_10_m_above_ground='on', lev_surface='on',
                  var_PRMSL='on', var_UGRD='on', var_VGRD='on', var_GUST='on', subregion='',
                  leftlon=str(BOUNDS[0][1]), rightlon=str(BOUNDS[1][1]),
                  bottomlat=str(BOUNDS[0][0]), toplat=str(BOUNDS[1][0]),
                  dir=f'/gfs.{run:%Y%m%d}/{run.hour:02d}/atmos')
    return FILTER + '?' + urllib.parse.urlencode(params)


def decode(raw, expected_time):
    import eccodes as ec
    fields, lats, lons = {}, None, None
    with tempfile.TemporaryFile() as file:
        file.write(raw); file.seek(0)
        while (g := ec.codes_grib_new_from_file(file)) is not None:
            try:
                valid = dt.datetime.strptime(str(ec.codes_get(g, 'validityDate')) + f"{ec.codes_get(g, 'validityTime'):04d}", '%Y%m%d%H%M').replace(tzinfo=dt.timezone.utc)
                if int(valid.timestamp()) != expected_time:
                    raise ValueError('GFS forecast valid time mismatch')
                lat = ec.codes_get_array(g, 'latitudes')
                lon = (ec.codes_get_array(g, 'longitudes')+180) % 360-180
                la, lo = np.unique(lat), np.unique(lon)
                if lats is not None and (not np.array_equal(la, lats) or not np.array_equal(lo, lons)):
                    raise ValueError('GFS fields use different grids')
                lats, lons = la, lo
                vals = ec.codes_get_values(g)
                array = np.full((len(la), len(lo)), np.nan)
                array[np.searchsorted(la, lat), np.searchsorted(lo, lon)] = vals
                name = ec.codes_get(g, 'shortName')
                level = ec.codes_get(g, 'typeOfLevel')
                if name == 'prmsl' and level == 'meanSea':
                    fields['pressure'] = array/100  # Pa -> hPa, never surface pressure.
                elif name == 'gust' and level == 'surface':
                    fields['gust'] = array  # GFS gust diagnostic in m/s at the forecast valid time.
                elif level == 'heightAboveGround' and ec.codes_get(g, 'level') == 10:
                    if name in ('10u', 'u'): fields['u'] = array
                    if name in ('10v', 'v'): fields['v'] = array
            finally:
                ec.codes_release(g)
    if set(fields) != {'pressure', 'u', 'v', 'gust'} or not all(np.isfinite(v).all() for v in fields.values()):
        raise ValueError('Incomplete GFS sea-level pressure / 10 m wind / gust fields')
    if fields['gust'].min() < 0 or fields['gust'].max() > 150:
        raise ValueError('Invalid GFS wind gust units/range')
    if fields['pressure'].min() < 850 or fields['pressure'].max() > 1100:
        raise ValueError('Invalid GFS pressure units/range')
    return lats, lons, fields


def sample(array, lats, lons, lat, lon):
    if not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
        return math.nan
    iy = min(len(lats)-2, max(0, int(np.searchsorted(lats, lat)-1)))
    ix = min(len(lons)-2, max(0, int(np.searchsorted(lons, lon)-1)))
    fy = (lat-lats[iy])/(lats[iy+1]-lats[iy]); fx = (lon-lons[ix])/(lons[ix+1]-lons[ix])
    return float((1-fy)*((1-fx)*array[iy, ix]+fx*array[iy, ix+1])+fy*((1-fx)*array[iy+1, ix]+fx*array[iy+1, ix+1]))


def centres(lats, lons, fields, valid_time):
    pressure = fields['pressure']
    smooth = gaussian_filter(pressure, 0.8, mode='nearest')
    candidates = np.argwhere((smooth == minimum_filter(smooth, size=5, mode='nearest')) & (smooth <= 1020))
    candidates = sorted(candidates, key=lambda ij: (smooth[tuple(ij)], int(ij[0]), int(ij[1])))
    result = []
    wind = np.hypot(fields['u'], fields['v'])
    for iy, ix in candidates:
        if iy <= 1 or ix <= 1 or iy >= len(lats)-2 or ix >= len(lons)-2:
            continue
        def offset(left, mid, right):
            denominator = 2*(left-2*mid+right)
            return float(np.clip((left-right)/denominator, -0.5, 0.5)) if denominator > 1e-8 else 0
        lat = float(lats[iy]+offset(smooth[iy-1, ix], smooth[iy, ix], smooth[iy+1, ix])*(lats[iy+1]-lats[iy]))
        lon = float(lons[ix]+offset(smooth[iy, ix-1], smooth[iy, ix], smooth[iy, ix+1])*(lons[ix+1]-lons[ix]))
        # Closedness on a 400 km ring distinguishes centres from open troughs.
        radius = 400/111.2
        ring = [sample(smooth, lats, lons, lat+radius*math.sin(a), lon+radius*math.cos(a)/math.cos(math.radians(lat)))
                for a in np.linspace(0, 2*math.pi, 24, endpoint=False)]
        depth = min(ring)-sample(smooth, lats, lons, lat, lon)
        if not all(math.isfinite(p) for p in ring) or depth < 2:
            continue
        point = {'time': valid_time, 'lat': round(lat, 4), 'lon': round(lon, 4),
                 'pressure': round(sample(pressure, lats, lons, lat, lon), 1), 'depth': round(depth, 1)}
        if any(distance(point, other) < 350 for other in result):
            continue
        dy = (lats[:, None]-lat)*111.2
        dx = (lons[None, :]-lon)*111.2*math.cos(math.radians(lat))
        nearby = wind[dy*dy+dx*dx <= 200**2]
        point['nearbyWind'] = round(float(nearby.max()), 1) if nearby.size else None
        gusts = fields['gust'][dy*dy+dx*dx <= 200**2]
        point['nearbyGust'] = round(float(gusts.max()), 1) if gusts.size else None
        result.append(point)
    return result


def point_at(points, valid):
    if not points or valid < points[0]['time'] or valid > points[-1]['time']:
        return None
    for a, b in zip(points, points[1:]):
        if a['time'] <= valid <= b['time']:
            if b['time']-a['time'] > 6*3600:
                return None
            f = (valid-a['time'])/(b['time']-a['time'])
            return {key: a[key]+f*(b[key]-a[key]) for key in ('lat', 'lon', 'pressure')} | {'time': valid}
    return points[-1] if valid == points[-1]['time'] else None


def track_frames(frames):
    tracks = []
    for valid, points in frames:
        active = [track for track in tracks if 0 < valid-track['points'][-1]['time'] <= 6*3600]
        matched = set()
        if active and points:
            costs = np.full((len(active), len(points)+len(active)), 700.)
            for i, track in enumerate(active):
                last = track['points'][-1]; hours = (valid-last['time'])/3600
                predicted = last.copy()
                if len(track['points']) >= 2:
                    prev = track['points'][-2]; elapsed = (last['time']-prev['time'])/3600
                    predicted['lat'] += (last['lat']-prev['lat'])*hours/elapsed
                    predicted['lon'] += (last['lon']-prev['lon'])*hours/elapsed
                for j, point in enumerate(points):
                    travel = distance(last, point); residual = distance(predicted, point)
                    pressure_change = abs(point['pressure']-last['pressure'])
                    if travel <= 140*hours and residual <= 180*hours and pressure_change <= 6*hours:
                        costs[i, j] = residual+pressure_change*12+travel*.15
                    else:
                        costs[i, j] = 1e6
            for i, j in zip(*linear_sum_assignment(costs)):
                if j < len(points) and costs[i, j] < 700:
                    active[i]['points'].append(points[j]); matched.add(j)
        for j, point in enumerate(points):
            if j not in matched:
                tracks.append({'points': [point]})
    # Require >=9 h persistence; don't invent a trajectory for a single minimum.
    return [t for t in tracks if len(t['points']) >= 4 and t['points'][-1]['time']-t['points'][0]['time'] >= 9*3600
            and any(display_region(p['lat'], p['lon']) for p in t['points'])]


def assign_ids(tracks, previous, run):
    eligible = previous.get('systems', [])
    pairs = []
    for i, new in enumerate(tracks):
        for j, old in enumerate(eligible):
            overlap = max(new['points'][0]['time'], old['points'][0]['time'])
            a = point_at(new['points'], overlap); b = point_at(old['points'], overlap)
            if a and b and distance(a, b) < 250 and abs(a['pressure']-b['pressure']) < 15:
                pairs.append((distance(a, b), i, j))
    used_new, used_old = set(), set()
    for _, i, j in sorted(pairs):
        if i not in used_new and j not in used_old:
            tracks[i]['id'] = eligible[j]['id']; used_new.add(i); used_old.add(j)
    reserved = {track['id'] for track in tracks if 'id' in track}
    counter = 1
    for track in tracks:
        if 'id' not in track:
            while f'GFS-{run:%Y%m%d%H}-{counter:02d}' in reserved:
                counter += 1
            track['id'] = f'GFS-{run:%Y%m%d%H}-{counter:02d}'
            reserved.add(track['id']); counter += 1
        track['name'] = None
        track['type'] = 'Modelled low-pressure system'
    return tracks


def add_names(tracks, now):
    state = {'status': 'ok', 'checkedAt': int(now.timestamp())}
    try:
        data = json.loads(download('https://www.nhc.noaa.gov/CurrentStorms.json'))
        available = []
        for storm in data['activeStorms']:
            if not storm['id'].lower().startswith('al'):
                continue
            issued = int(dt.datetime.fromisoformat(storm['lastUpdate'].replace('Z', '+00:00')).timestamp())
            if not 0 <= now.timestamp()-issued <= 12*3600:
                continue
            pos = {'lat': float(storm['latitudeNumeric']), 'lon': float(storm['longitudeNumeric']), 'pressure': float(storm['pressure'])}
            available.append((storm, issued, pos))
        used = set()
        for storm, issued, pos in available:
            options = []
            for i, track in enumerate(tracks):
                centre = point_at(track['points'], issued)
                if i not in used and centre and distance(centre, pos) < 250 and abs(centre['pressure']-pos['pressure']) < 20:
                    options.append((distance(centre, pos), i))
            if options:
                _, i = min(options); used.add(i); track = tracks[i]
                track['name'] = storm['name']
                track['nhc'] = {'id': storm['id'], 'issuedAt': issued, 'classification': storm['classification'],
                                'pressure': pos['pressure'], 'windMS': round(float(storm['intensity'])*0.514444, 1),
                                'movementKMH': round(float(storm['movementSpeed'])*1.852, 1),
                                'movementDir': float(storm['movementDir']),
                                'url': storm.get('publicAdvisory', {}).get('url')}
        state['atlanticStorms'] = len(available)
    except Exception as error:
        state.update(status='error', error=str(error))
    return state


def retain_history(systems, previous, now, model_run):
    """Keep elapsed modelled centres across matched runs, never future forecasts."""
    end = int(now.timestamp()); cutoff = end-72*3600
    old_by_id = {s['id']: s for s in previous.get('systems', [])}
    for system in systems:
        old = old_by_id.get(system['id'], {})
        points = {}
        # Earlier-run positions stop at the new run, where its track takes over.
        for point in old.get('history', []) + old.get('points', []):
            if cutoff <= point['time'] < model_run and point['time'] <= end:
                points[point['time']] = dict(point)
        for point in system['points']:
            if cutoff <= point['time'] <= end:
                points[point['time']] = dict(point)
        system['history'] = [points[t] for t in sorted(points)]
    return systems


def simplify_contour(points,tolerance=.12):
    """Douglas–Peucker simplification; retain genuine closed contour geometry."""
    if len(points)<3:return points
    keep={0,len(points)-1};stack=[(0,len(points)-1)]
    while stack:
        start,end=stack.pop()
        if end-start<2:continue
        segment=points[end]-points[start];length=float(segment@segment)
        inner=points[start+1:end]
        if length:
            fraction=np.clip((inner-points[start])@segment/length,0,1)
            delta=inner-(points[start]+fraction[:,None]*segment)
        else:delta=inner-points[start]
        distances=np.sum(delta*delta,axis=1);index=int(np.argmax(distances))
        if distances[index]>tolerance*tolerance:
            middle=start+index+1;keep.add(middle);stack.extend([(start,middle),(middle,end)])
    return points[sorted(keep)]


def pressure_contours(lats,lons,pressure,valid):
    # The same sea-level field and valid times as the centre tracks.
    smooth=gaussian_filter(pressure,.8,mode='nearest')
    generator=contourpy.contour_generator(x=lons,y=lats,z=smooth,line_type='Separate')
    lines=[]
    for level in range(920,1053,4):
        for points in generator.lines(level):
            if len(points)<6:continue
            simplified=simplify_contour(points)
            if len(simplified)<2:continue
            lines.append({'pressure':level,'points':np.round(simplified,3).tolist()})
    return {'time':valid,'lines':lines}


def collect(now, previous):
    # GFS is produced every six hours; allow four hours for the complete run.
    base = (now-dt.timedelta(hours=4)).replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=base.hour//6*6)
    run, seed = None, {}
    for offset in range(3):
        candidate = base-dt.timedelta(hours=6*offset)
        try:
            initial = download(grid_url(candidate, 0)); final = download(grid_url(candidate, 96))
            if initial[:4] != b'GRIB' or final[:4] != b'GRIB':
                raise ValueError('GFS fields unavailable')
            run, seed = candidate, {0: initial, 96: final}; break
        except Exception as error:
            print('Cycle not ready', candidate.isoformat(), error, flush=True)
    if run is None or (now-run).total_seconds() > 18*3600:
        raise ValueError('No recent complete GFS model cycle')
    stamp = int(run.timestamp())
    if previous.get('pressureContours',{}).get('version') == 1 and previous.get('windFieldsVersion') == 2 and previous.get('modelRun') == stamp and previous.get('forecastEnd', 0) >= stamp+96*3600:
        systems = json.loads(json.dumps(previous['systems']))
        for s in systems:
            s['name'] = None; s.pop('nhc', None);s.pop('europeanName',None)
        contours=previous['pressureContours']['frames']
    else:
        def get(step):
            if step in seed: return step, seed[step]
            raw = download(grid_url(run, step)); time.sleep(0.6)
            if raw[:4] != b'GRIB': raise ValueError('GFS response is not GRIB')
            return step, raw
        with futures.ThreadPoolExecutor(max_workers=2) as pool:
            fields = dict(pool.map(get, STEPS))
        frames = [];contours=[]
        for step in STEPS:
            valid = stamp+step*3600
            lats, lons, grid = decode(fields[step], valid)
            lows = centres(lats, lons, grid, valid);frames.append((valid, lows))
            contours.append(pressure_contours(lats,lons,grid['pressure'],valid))
            print('Forecast', step, 'h:', len(lows), 'closed centres', flush=True)
        systems = assign_ids(track_frames(frames), previous, run)
    systems = retain_history(systems, previous, now, stamp)
    nhc = add_names(systems, now)
    european=add_european_names(systems,now,download,distance)
    return {'version': 1, 'windFieldsVersion': 2, 'generatedAt': int(now.timestamp()), 'modelRun': stamp,
            'forecastEnd': stamp+96*3600, 'status': 'ok',
            'bounds': BOUNDS, 'source': 'NOAA / NCEP GFS 0.5°', 'sourceUrl': 'https://nomads.ncep.noaa.gov/',
            'method': 'Closed pressure minima; 400 km ring depth ≥2 hPa; ≥9-hour persistence; tracked every 3 hours.',
            'nhcStatus': nhc, 'europeanNamesStatus':european,
            'pressureContours':{'version':1,'interval':4,'modelRun':stamp,'frames':contours},'systems': systems}


def main():
    now = dt.datetime.now(dt.timezone.utc)
    try:
        previous = json.loads(OUTPUT.read_text())
    except (OSError, ValueError):
        previous = {}
    try:
        result = collect(now, previous)
    except Exception as error:
        if previous:
            previous.update(status='error', lastErrorAt=int(now.timestamp()), error=str(error))
            OUTPUT.write_text(json.dumps(previous, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n')
        raise
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n')
    current = [s for s in result['systems'] if point_at(s['points'], int(now.timestamp()))]
    print('Published', len(result['systems']), 'tracks;', len(current), 'centres active now', flush=True)


if __name__ == '__main__':
    main()

