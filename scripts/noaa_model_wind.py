"""Read only the three required wind messages from NOAA's public GRIB files.

Raw model files are temporary inputs; only the sampled shared JSON is published.
GFS supplies global coverage, with earth-relative HRRR vectors over CONUS.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import math
import time
import urllib.request

# Import PROJ before ecCodes: their bundled native libraries otherwise
# conflict during shutdown on some Linux runners.
from pyproj import Proj
import numpy as np
import eccodes as ec

FIELDS = {"UGRD:10 m above ground": "u", "VGRD:10 m above ground": "v", "GUST:surface": "gust"}


def read_url(url, headers=None):
    error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "NorthWeather/1.0", **(headers or {})})
            with urllib.request.urlopen(request, timeout=60) as response:
                if headers and "Range" in headers:
                    expected = headers["Range"].removeprefix("bytes=")
                    if response.status != 206 or not response.headers.get("Content-Range", "").startswith("bytes " + expected + "/"):
                        raise RuntimeError("NOAA did not return the requested byte range")
                    limit = int(expected.split('-')[1]) - int(expected.split('-')[0]) + 1
                else:
                    limit = 100000
                data = response.read(limit + 1)
                if len(data) > limit or (headers and len(data) != limit):
                    raise RuntimeError("Unexpected NOAA response length")
                return data
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"NOAA download failed: {url}: {error}")


def wind_ranges(index):
    rows = [line.split(":") for line in index.splitlines() if line]
    selected = {}
    for i, row in enumerate(rows[:-1]):
        key = ':'.join(row[3:5])
        if key in FIELDS:
            selected[FIELDS[key]] = (int(row[1]), int(rows[i + 1][1]) - 1)
    if set(selected) != {"u", "v", "gust"}:
        raise RuntimeError("NOAA index has no complete surface wind fields")
    return selected


def model_url(model, run, hour):
    d = datetime.fromtimestamp(run, timezone.utc)
    lead = int((hour - run) // 3600)
    if lead < 0:
        raise ValueError("Negative model forecast lead")
    if model == 'gfs':
        return f'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{d:%Y%m%d}/{d:%H}/atmos/gfs.t{d:%H}z.pgrb2.0p25.f{lead:03d}'
    return f'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{d:%Y%m%d}/conus/hrrr.t{d:%H}z.wrfsfcf{lead:02d}.grib2'


def valid_time(gid):
    text = f'{ec.codes_get(gid, "validityDate"):08d}{ec.codes_get(gid, "validityTime"):04d}'
    return int(datetime.strptime(text, '%Y%m%d%H%M').replace(tzinfo=timezone.utc).timestamp())


def sample_message(raw, points, hour, field):
    gid = ec.codes_new_from_message(raw)
    try:
        if valid_time(gid) != hour or ec.codes_get(gid, 'units') not in ('m s**-1', 'm/s'):
            raise RuntimeError('Wrong NOAA valid time or wind units')
        if field in ('u', 'v') and (ec.codes_get(gid, 'typeOfLevel') != 'heightAboveGround' or ec.codes_get(gid, 'level') != 10):
            raise RuntimeError('NOAA wind is not at 10 m')
        if ec.codes_get(gid, 'jPointsAreConsecutive') or ec.codes_get(gid, 'alternativeRowScanning'):
            raise RuntimeError('Unsupported NOAA scanning order')
        nx, ny = ec.codes_get(gid, 'Nx'), ec.codes_get(gid, 'Ny')
        values = ec.codes_get_values(gid).reshape(ny, nx)
        missing = ec.codes_get(gid, 'missingValue')
        lat = np.asarray([p[0] for p in points])
        lon = np.asarray([p[1] for p in points])
        ixsign = -1 if ec.codes_get(gid, 'iScansNegatively') else 1
        jysign = 1 if ec.codes_get(gid, 'jScansPositively') else -1
        lat0 = ec.codes_get(gid, 'latitudeOfFirstGridPointInDegrees')
        lon0 = ec.codes_get(gid, 'longitudeOfFirstGridPointInDegrees')
        grid_type = ec.codes_get(gid, 'gridType')
        angle = np.zeros(len(points))
        if grid_type == 'regular_ll':
            dx, dy = ec.codes_get(gid, 'iDirectionIncrementInDegrees'), ec.codes_get(gid, 'jDirectionIncrementInDegrees')
            x = ((lon - lon0) * ixsign) % 360 / dx
            y = (lat - lat0) / (jysign * dy)
            periodic = abs(nx * dx - 360) < 1e-5
        elif grid_type == 'lambert':
            proj = Proj(proj='lcc', lat_1=ec.codes_get(gid, 'Latin1InDegrees'), lat_2=ec.codes_get(gid, 'Latin2InDegrees'),
                        lon_0=ec.codes_get(gid, 'LoVInDegrees'), R=ec.codes_get(gid, 'radius'))
            x0, y0 = proj(lon0, lat0)
            xp, yp = proj(lon, lat)
            x = (np.asarray(xp) - x0) / (ixsign * ec.codes_get(gid, 'DxInMetres'))
            y = (np.asarray(yp) - y0) / (jysign * ec.codes_get(gid, 'DyInMetres'))
            if ec.codes_get(gid, 'uvRelativeToGrid'):
                angle = np.radians(proj.get_factors(lon, lat).meridian_convergence)
            periodic = False
        else:
            raise RuntimeError(f'Unsupported NOAA grid {grid_type}')
        inside = np.isfinite(x) & np.isfinite(y) & (y >= 0) & (y <= ny - 1)
        if not periodic:
            inside &= (x >= 0) & (x <= nx - 1)
        xc, yc = np.clip(x, 0, nx - 1), np.clip(y, 0, ny - 1)
        if periodic:
            xc = x % nx
        x1, y1 = np.floor(xc).astype(int), np.floor(yc).astype(int)
        x2, y2 = (x1 + 1) % nx if periodic else np.minimum(x1 + 1, nx - 1), np.minimum(y1 + 1, ny - 1)
        fx, fy = xc - x1, yc - y1
        corners = [values[y1, x1], values[y1, x2], values[y2, x1], values[y2, x2]]
        for corner in corners:
            inside &= np.isfinite(corner) & (corner != missing) & (np.abs(corner) < 200)
        result = corners[0]*(1-fx)*(1-fy) + corners[1]*fx*(1-fy) + corners[2]*(1-fx)*fy + corners[3]*fx*fy
        result[~inside] = np.nan
        return result, angle
    finally:
        ec.codes_release(gid)


def rotate_wind(u, v, angle):
    return u*np.cos(angle) + v*np.sin(angle), -u*np.sin(angle) + v*np.cos(angle)


def fetch_frame(model, run, hour, points):
    url = model_url(model, run, hour)
    ranges = wind_ranges(read_url(url + '.idx').decode())
    arrays = {}
    for field, (start, end) in ranges.items():
        raw = read_url(url, {'Range': f'bytes={start}-{end}'})
        if not raw.startswith(b'GRIB'):
            raise RuntimeError('NOAA response is not GRIB')
        arrays[field], angle = sample_message(raw, points, hour, field)
        if field == 'u':
            wind_angle = angle
    u, v = rotate_wind(arrays['u'], arrays['v'], wind_angle)
    return [[round(float(a), 4), round(float(b), 4), round(float(g), 3) if math.isfinite(g) and g >= 0 else None]
            if math.isfinite(a) and math.isfinite(b) else None for a, b, g in zip(u, v, arrays['gust'])]


def collect_native(points, usa_indices, times):
    # One coherent GFS cycle covers the whole timeline. An unavailable cycle
    # falls back by six hours, with its actual run recorded in the snapshot.
    first_run = int(times[0] // 21600) * 21600
    for run in (first_run, first_run - 21600, first_run - 43200):
        try:
            first = fetch_frame('gfs', run, times[0], points)
            break
        except RuntimeError as exc:
            print(str(exc), flush=True)
    else:
        raise RuntimeError('No available NOAA GFS cycle')
    with ThreadPoolExecutor(max_workers=2) as pool:
        frames = [first] + list(pool.map(lambda hour: fetch_frame('gfs', run, hour, points), times[1:]))
    if any(any(sample is None for sample in frame) for frame in frames):
        raise RuntimeError('Incomplete global NOAA wind field')
    hrrr_runs = []
    latest = int(time.time() // 3600) * 3600 - 7200
    usa_points = [points[i] for i in usa_indices]
    for n, hour in enumerate(times):
        candidate = min(hour, latest)
        used = None
        for offset in (0, 3600, 7200):
            hrun = candidate - offset
            if hour - hrun > 18 * 3600:
                continue
            try:
                detail = fetch_frame('hrrr', hrun, hour, usa_points)
                for i, sample in zip(usa_indices, detail):
                    if sample is not None:
                        frames[n][i] = sample
                used = hrun
                break
            except RuntimeError as exc:
                print(f'HRRR fallback at {hour}: {exc}', flush=True)
        hrrr_runs.append(used)
        print(f'NOAA wind hour {n+1}/{len(times)} ready; HRRR run {used}', flush=True)
    series = [[frame[i] for frame in frames] for i in range(len(points))]
    return series, {'gfsRun': run, 'hrrrRuns': hrrr_runs}
