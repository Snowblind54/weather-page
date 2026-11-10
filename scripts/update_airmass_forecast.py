"""Publish a compact, single-cycle ECMWF 850 hPa temperature forecast over Europe."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import shutil
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import contourpy
import eccodes as ec
import numpy as np
from PIL import Image, ImageDraw
from scipy.interpolate import RegularGridInterpolator

from ecmwf_open_grid import url

ROOT = Path(__file__).resolve().parents[1]
PROVIDER = 'https://data.ecmwf.int/forecasts/'
MANIFEST = 'data/forecast-airmass.json'
ASSETS = 'data/forecast-airmass-cache'
VERSION = 'airmass-v1'
BOUNDS = [-40, 25, 60, 82]
STEPS = tuple(range(0, 121, 3))
MAX_BYTES = 10 * 1024 * 1024
COLORS = np.array([[74,39,126], [51,90,164], [69,138,187], [131,195,209],
                   [229,216,176], [212,147,86], [189,80,61], [145,46,53]])
TEMPERATURES = np.linspace(-24, 24, len(COLORS))


def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def stamp(value):
    return value.strftime('%Y%m%dT%HZ')


def request(address, offset=None, length=None):
    headers = {'User-Agent': 'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page'}
    if offset is not None:
        if offset < 0 or not 0 < length < 16 * 1024 * 1024:
            raise ValueError('Invalid GRIB byte range')
        end = offset + length - 1
        headers['Range'] = f'bytes={offset}-{end}'
    for attempt in range(3):
        try:
            with urlopen(Request(address, headers=headers), timeout=45) as response:
                if offset is not None and (response.status != 206 or
                        not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-{end}/')):
                    raise ValueError('ECMWF did not honour the GRIB byte range')
                limit = length if length is not None else 2 * 1024 * 1024
                data = response.read(limit + 1)
                if len(data) > limit or (length is not None and len(data) != length):
                    raise ValueError('Unexpected ECMWF response size')
                return data
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            try: delay = float(error.headers.get('Retry-After', 0))
            except (TypeError, ValueError): delay = 0
            if delay > 120: raise
            time.sleep(max(delay, 10 * (attempt + 1)))
        except (URLError, TimeoutError):
            if attempt == 2: raise
            time.sleep(5 * (attempt + 1))


def select_fields(raw):
    fields = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get('param') == 't' and row.get('levtype') == 'pl' and str(row.get('levelist')) == '850':
            fields['t'] = row
        elif row.get('param') == 'sp' and row.get('levtype') == 'sfc':
            fields['sp'] = row
    if fields.keys() != {'t', 'sp'}:
        raise ValueError('850 hPa temperature or surface pressure missing')
    return fields


def index(run, step):
    return select_fields(request(url(PROVIDER, run, step, 'index', .25)))


def decode(raw, run, step, field):
    g = ec.codes_new_from_message(raw)
    try:
        actual = [int(ec.codes_get(g, key)) for key in ('dataDate', 'dataTime', 'validityDate', 'validityTime')]
        valid = run + timedelta(hours=step)
        expected = [int(value.strftime(fmt)) for value in (run, valid) for fmt in ('%Y%m%d', '%H%M')]
        if actual != expected or ec.codes_get(g, 'shortName') != field:
            raise ValueError('Wrong ECMWF field or forecast time')
        level_type = ec.codes_get(g, 'typeOfLevel')
        if field == 't':
            if level_type != 'isobaricInhPa' or ec.codes_get(g, 'level') != 850 or ec.codes_get(g, 'units') != 'K':
                raise ValueError('Expected 850 hPa temperature in kelvin')
            lo, hi = 180, 340
        else:
            if level_type != 'surface' or ec.codes_get(g, 'units') != 'Pa':
                raise ValueError('Expected surface pressure in pascals')
            lo, hi = 45000, 110000
        lats = np.round(ec.codes_get_array(g, 'latitudes'), 7)
        lons = np.round((ec.codes_get_array(g, 'longitudes') + 180) % 360 - 180, 7)
        w, s, e, n = BOUNDS
        keep = (lats >= s) & (lats <= n) & (lons >= w) & (lons <= e)
        lat, lon = np.unique(lats[keep]), np.unique(lons[keep])
        if len(lat) < 2 or len(lon) < 2 or (lat[0], lon[0], lat[-1], lon[-1]) != (s, w, n, e) or any(
                not np.allclose(np.diff(axis), .25, rtol=0, atol=1e-7) for axis in (lat, lon)):
            raise ValueError('Incomplete 0.25 degree Europe grid')
        grid = np.full((len(lat), len(lon)), np.nan)
        grid[np.searchsorted(lat, lats[keep]), np.searchsorted(lon, lons[keep])] = ec.codes_get_values(g)[keep]
        if not np.isfinite(grid).all() or grid.min() < lo or grid.max() > hi:
            raise ValueError('Invalid ECMWF grid values')
        return lat, lon, grid
    finally:
        ec.codes_release(g)


def read_step(run, step, fields=None):
    address = url(PROVIDER, run, step, 'grib2', .25)
    return {field: decode(request(address, int(row['_offset']), int(row['_length'])), run, step, field)
            for field, row in (fields or index(run, step)).items()}


def pixels(width=1024):
    w, s, e, n = BOUNDS
    south, north = (np.arcsinh(np.tan(np.radians(lat))) for lat in (s, n))
    height = round(width * (north - south) / math.radians(e - w))
    xs = w + (np.arange(width) + .5) * (e - w) / width
    ys = np.degrees(np.arctan(np.sinh(north - (np.arange(height) + .5) * (north - south) / height)))
    lon, lat = np.meshgrid(xs, ys)
    return np.stack((lat, lon), axis=-1)


def palette(celsius):
    return np.stack([np.interp(celsius, TEMPERATURES, COLORS[:, band]) for band in range(3)], axis=-1).astype(np.uint8)


def image_frame(temperature, pressure):
    if temperature.shape != pressure.shape or not np.isfinite(temperature).all() or not np.isfinite(pressure).all():
        raise ValueError('Invalid projected ECMWF fields')
    above_ground = pressure >= 85000
    rgba = np.dstack((palette(temperature), (above_ground * 255).astype(np.uint8)))
    image = Image.fromarray(rgba)
    contour = contourpy.contour_generator(z=np.ma.array(temperature, mask=~above_ground), corner_mask=False)
    draw = ImageDraw.Draw(image)
    lines = [list(map(tuple, points)) for points in contour.lines(0) if len(points) >= 2]
    for line in lines:
        draw.line(line, fill='#51463e', width=4, joint='curve')
    for line in lines:
        draw.line(line, fill='#fff3cf', width=2, joint='curve')
    # Line width must not leak into areas below model terrain.
    image.putalpha(Image.fromarray(rgba[:, :, 3]))
    return image


def available_cycles(now):
    latest = now - timedelta(hours=4)
    latest = latest.replace(hour=(latest.hour // 12) * 12, minute=0, second=0, microsecond=0)
    return [latest - timedelta(hours=offset) for offset in (0, 12)]


def publishable_cycle(now, existing, probe=index):
    for run in available_cycles(now):
        if existing and run <= existing:
            return None
        try:
            return run, {step: probe(run, step) for step in (0, STEPS[-1])}
        except Exception as error:
            print('IFS air mass cycle not ready:', iso(run), str(error)[:180], flush=True)
    raise RuntimeError('No complete ECMWF air mass cycle; previous forecast retained')


def build(run, seeds, root=ROOT, read=read_step):
    cycle = stamp(run) + '-' + VERSION
    dest = root / ASSETS / cycle
    dest.parent.mkdir(parents=True, exist_ok=True)
    points = pixels()
    paths = {}
    with tempfile.TemporaryDirectory(dir=dest.parent) as temporary:
        stage = Path(temporary) / cycle
        stage.mkdir()

        def frame(step):
            fields = read(run, step, seeds.get(step))
            def sample(field):
                lat, lon, values = fields[field]
                return RegularGridInterpolator((lat, lon), values)(points)
            valid = run + timedelta(hours=step)
            name = f'airmass-{stamp(valid)}.webp'
            image_frame(sample('t') - 273.15, sample('sp')).save(stage / name, 'WEBP', quality=82, method=4)
            return iso(valid), f'{ASSETS}/{cycle}/{name}'

        with ThreadPoolExecutor(max_workers=2) as pool:
            paths.update(pool.map(frame, STEPS))
        legend = np.broadcast_to(palette(np.linspace(-24, 24, 256)), (18, 256, 3))
        Image.fromarray(legend).save(stage / 'airmass-legend.webp', 'WEBP', lossless=True)
        size = sum(path.stat().st_size for path in stage.iterdir())
        if size > MAX_BYTES:
            raise RuntimeError('Air mass forecast cache exceeded its 10 MiB limit')
        if dest.exists():
            shutil.rmtree(dest)
        stage.rename(dest)
    payload = {'version': 1, 'delivery': 'static-regional-images', 'asset_root': Path(ASSETS).name,
               'asset_version': VERSION, 'generatedAt': int(time.time()), 'reference_time': iso(run),
               'grid_spacing_degrees': .25, 'forecast_step_hours': 3, 'pressure_level_hpa': 850,
               'bounds': BOUNDS, 'layers': {'airmass': 'air_temperature_850hpa'}, 'cached_times': list(paths),
               'images': {'airmass': paths}, 'legends': {'airmass': f'{ASSETS}/{cycle}/airmass-legend.webp'}}
    target = root / MANIFEST
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    temporary.replace(target)
    for path in dest.parent.iterdir():
        if path != dest and path.is_dir() and path.name.endswith('-' + VERSION):
            shutil.rmtree(path)
    print(f'Prepared {len(paths)} ECMWF air mass frames, {size:,} bytes, model run {iso(run)}', flush=True)


def mirrored_cycle(now):
    from github_fallback import download
    try:
        current = json.loads(download(MANIFEST))
        run = datetime.fromisoformat(current['reference_time'])
        times = [iso(run + timedelta(hours=step)) for step in STEPS]
        if (current['asset_version'] == VERSION and current['cached_times'] == times and
                run in available_cycles(now) and set(current['images']['airmass']) == set(times)):
            return run
    except Exception as error:
        print('No reusable mirrored air mass cycle:', type(error).__name__, flush=True)
    return None


if __name__ == '__main__':
    now = datetime.now(timezone.utc)
    selected = publishable_cycle(now, mirrored_cycle(now))
    if selected:
        build(*selected)
    else:
        print('Latest complete air mass cycle already published', flush=True)
