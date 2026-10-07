#!/usr/bin/env python3
"""Build model-derived cold/warm fronts matched to the cyclone GFS cycle.

This is an objective diagnostic, not an official hand-analysed synoptic chart.
Frontal axes are thermal-front-parameter zero contours within strong 850 hPa
temperature gradients. The sign of 850 hPa thermal advection classifies each
retained segment as warm or cold.
"""
from __future__ import annotations

import concurrent.futures as futures
import datetime as dt
import json
import math
import pathlib
import tempfile
import time
import urllib.parse
import urllib.request

import contourpy
import numpy as np
from scipy.ndimage import gaussian_filter

ROOT = pathlib.Path(__file__).resolve().parents[1]
CYCLONES = ROOT / 'data' / 'cyclones.json'
OUTPUT = ROOT / 'data' / 'fronts.json'
FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl'
BOUNDS = [[20, -85], [82, 45]]
STEPS = list(range(0, 73, 3))
MIN_GRADIENT = 1.5  # K / 100 km
MIN_LENGTH_KM = 250
MAX_LINES_PER_FRAME = 42


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': 'NorthernWeather/8.88 (github.com/Snowblind54/weather-page)'})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=50) as response:
                raw = response.read()
            if raw[:4] != b'GRIB':
                raise ValueError('GFS response is not GRIB')
            return raw
        except Exception as error:
            last = error
            if attempt == 2:
                break
            time.sleep(2.5 * (attempt + 1))
    raise RuntimeError(f'Could not download GFS frontal fields: {last}')


def grid_url(run: dt.datetime, step: int) -> str:
    params = dict(
        file=f'gfs.t{run.hour:02d}z.pgrb2.0p25.f{step:03d}',
        lev_850_mb='on', var_TMP='on', var_UGRD='on', var_VGRD='on', subregion='',
        leftlon=str(BOUNDS[0][1]), rightlon=str(BOUNDS[1][1]),
        bottomlat=str(BOUNDS[0][0]), toplat=str(BOUNDS[1][0]),
        dir=f'/gfs.{run:%Y%m%d}/{run.hour:02d}/atmos',
    )
    return FILTER + '?' + urllib.parse.urlencode(params)


def decode(raw: bytes, expected_time: int):
    import eccodes as ec

    fields, lats, lons = {}, None, None
    with tempfile.TemporaryFile() as file:
        file.write(raw)
        file.seek(0)
        while (g := ec.codes_grib_new_from_file(file)) is not None:
            try:
                valid = dt.datetime.strptime(
                    str(ec.codes_get(g, 'validityDate')) + f"{ec.codes_get(g, 'validityTime'):04d}",
                    '%Y%m%d%H%M',
                ).replace(tzinfo=dt.timezone.utc)
                if int(valid.timestamp()) != expected_time:
                    raise ValueError('GFS frontal field valid time mismatch')
                level_type = ec.codes_get(g, 'typeOfLevel')
                level = ec.codes_get(g, 'level')
                if level_type != 'isobaricInhPa' or int(level) != 850:
                    continue
                lat = ec.codes_get_array(g, 'latitudes')
                lon = (ec.codes_get_array(g, 'longitudes') + 180) % 360 - 180
                la, lo = np.unique(lat), np.unique(lon)
                if lats is not None and (not np.array_equal(la, lats) or not np.array_equal(lo, lons)):
                    raise ValueError('GFS frontal fields use different grids')
                lats, lons = la, lo
                vals = ec.codes_get_values(g)
                array = np.full((len(la), len(lo)), np.nan)
                array[np.searchsorted(la, lat), np.searchsorted(lo, lon)] = vals
                name = ec.codes_get(g, 'shortName')
                if name == 't':
                    fields['temperature'] = array
                elif name == 'u':
                    fields['u'] = array
                elif name == 'v':
                    fields['v'] = array
            finally:
                ec.codes_release(g)
    if lats is None or set(fields) != {'temperature', 'u', 'v'} or not all(np.isfinite(v).all() for v in fields.values()):
        raise ValueError('Incomplete GFS 850 hPa temperature/wind fields')
    temperature = fields['temperature']
    if temperature.min() < 180 or temperature.max() > 330:
        raise ValueError('Invalid GFS 850 hPa temperature range')
    # 0.5° is sufficient for synoptic frontal geometry and keeps processing light.
    return lats[::2], lons[::2], {key: value[::2, ::2] for key, value in fields.items()}


def bilinear(array, lats, lons, lat, lon):
    if not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
        return math.nan
    iy = min(len(lats) - 2, max(0, int(np.searchsorted(lats, lat) - 1)))
    ix = min(len(lons) - 2, max(0, int(np.searchsorted(lons, lon) - 1)))
    fy = (lat - lats[iy]) / (lats[iy + 1] - lats[iy])
    fx = (lon - lons[ix]) / (lons[ix + 1] - lons[ix])
    return float(
        (1 - fy) * ((1 - fx) * array[iy, ix] + fx * array[iy, ix + 1])
        + fy * ((1 - fx) * array[iy + 1, ix] + fx * array[iy + 1, ix + 1])
    )


def display_region(lat, lon):
    return -80 <= lon <= 40 and 25 <= lat <= 78 and (lon < -12 or lat >= 45)


def line_length(points):
    total = 0.0
    for a, b in zip(points, points[1:]):
        lat = math.radians((a[1] + b[1]) / 2)
        dy = (b[1] - a[1]) * 111.2
        dx = (b[0] - a[0]) * 111.2 * math.cos(lat)
        total += math.hypot(dx, dy)
    return total


def simplify(points, tolerance=.18):
    if len(points) < 3:
        return points
    p = np.asarray(points, dtype=float)
    keep = {0, len(p) - 1}
    stack = [(0, len(p) - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        segment = p[end] - p[start]
        length = float(segment @ segment)
        inner = p[start + 1:end]
        if length:
            fraction = np.clip((inner - p[start]) @ segment / length, 0, 1)
            delta = inner - (p[start] + fraction[:, None] * segment)
        else:
            delta = inner - p[start]
        distances = np.sum(delta * delta, axis=1)
        index = int(np.argmax(distances))
        if distances[index] > tolerance * tolerance:
            middle = start + index + 1
            keep.add(middle)
            stack.extend([(start, middle), (middle, end)])
    return p[sorted(keep)].tolist()


def classify_advection(value):
    return 'warm' if value >= 0 else 'cold'


def analyse_fronts(lats, lons, fields, valid_time):
    temperature = gaussian_filter(fields['temperature'], 1.15, mode='nearest')
    coslat = np.maximum(np.cos(np.deg2rad(lats))[:, None], 0.2)
    dtdy = np.gradient(temperature, lats, axis=0, edge_order=2) / 111.2
    dtdx = np.gradient(temperature, lons, axis=1, edge_order=2) / (111.2 * coslat)
    gradient = gaussian_filter(np.hypot(dtdx, dtdy) * 100.0, 0.65, mode='nearest')

    # Thermal front parameter: zero crossings locate maxima in horizontal
    # temperature-gradient magnitude along the gradient direction.
    dmdy = np.gradient(gradient, lats, axis=0, edge_order=2) / 111.2
    dmdx = np.gradient(gradient, lons, axis=1, edge_order=2) / (111.2 * coslat)
    magnitude = np.maximum(np.hypot(dtdx, dtdy), 1e-8)
    nx, ny = dtdx / magnitude, dtdy / magnitude
    tfp = -(dmdx * nx + dmdy * ny)
    advection = -(fields['u'] * dtdx + fields['v'] * dtdy)

    generator = contourpy.contour_generator(x=lons, y=lats, z=tfp, line_type='Separate')
    candidates = []
    for raw in generator.lines(0.0):
        if len(raw) < 5:
            continue
        active = []
        pieces = []
        for lon, lat in raw:
            strength = bilinear(gradient, lats, lons, lat, lon)
            if display_region(lat, lon) and math.isfinite(strength) and strength >= MIN_GRADIENT:
                active.append([float(lon), float(lat)])
            else:
                if len(active) >= 4:
                    pieces.append(active)
                active = []
        if len(active) >= 4:
            pieces.append(active)

        for piece in pieces:
            length = line_length(piece)
            if length < MIN_LENGTH_KM:
                continue
            strengths = [bilinear(gradient, lats, lons, p[1], p[0]) for p in piece]
            adv = [bilinear(advection, lats, lons, p[1], p[0]) for p in piece]
            adv = [value for value in adv if math.isfinite(value)]
            if not adv:
                continue
            simplified = simplify(piece)
            if len(simplified) < 2:
                continue
            kind = classify_advection(float(np.median(adv)))
            score = float(np.nanmedian(strengths)) * math.sqrt(length)
            candidates.append((score, {
                'type': kind,
                'strength': round(float(np.nanmedian(strengths)), 2),
                'points': [[round(p[0], 3), round(p[1], 3)] for p in simplified],
            }))

    # Retain the strongest synoptic-scale axes. This suppresses small noisy
    # gradient ridges while preserving the dominant cold/warm fronts.
    lines = [line for _, line in sorted(candidates, key=lambda item: item[0], reverse=True)[:MAX_LINES_PER_FRAME]]
    return {'time': valid_time, 'lines': lines}


def main():
    cyclone_data = json.loads(CYCLONES.read_text(encoding='utf-8'))
    stamp = int(cyclone_data['modelRun'])
    run = dt.datetime.fromtimestamp(stamp, tz=dt.timezone.utc)
    if dt.datetime.now(dt.timezone.utc).timestamp() - stamp > 20 * 3600:
        raise RuntimeError('Cyclone GFS model cycle is too old for a new fronts snapshot')

    def get(step):
        raw = download(grid_url(run, step))
        lats, lons, fields = decode(raw, stamp + step * 3600)
        frame = analyse_fronts(lats, lons, fields, stamp + step * 3600)
        print(f'Fronts +{step:02d} h: {len(frame["lines"])} lines', flush=True)
        return step, frame

    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        frames = dict(pool.map(get, STEPS))

    result = {
        'version': 1,
        'generatedAt': int(time.time()),
        'modelRun': stamp,
        'forecastEnd': stamp + 72 * 3600,
        'stepHours': 3,
        'bounds': BOUNDS,
        'source': 'NOAA / NCEP GFS 850 hPa temperature and wind',
        'sourceUrl': 'https://nomads.ncep.noaa.gov/',
        'method': 'Objective thermal-front-parameter axes in strong 850 hPa temperature gradients; warm/cold type from 850 hPa thermal advection. Model-derived, not an official synoptic analysis.',
        'frames': [frames[step] for step in STEPS],
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    temporary = OUTPUT.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    count = sum(len(frame['lines']) for frame in result['frames'])
    print(f'Wrote {OUTPUT}: {len(result["frames"])} frames, {count} frontal lines', flush=True)


if __name__ == '__main__':
    main()
