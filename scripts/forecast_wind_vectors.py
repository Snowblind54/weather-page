"""Small forecast direction grids, prepared once per model hour."""
import io
import json
import math
import urllib.request
from urllib.parse import urlencode
import numpy as np
from PIL import Image

SIZE = 128


def payload(bounds, valid, values):
    return {'version': 1, 'time': valid, 'bounds': bounds,
            'width': SIZE, 'height': SIZE, 'projection': 'mercator',
            'convention': 'wind_from_degrees', 'values': values}


def write_ecmwf(lower, upper, fraction, bounds, valid, destination):
    from scipy.interpolate import RegularGridInterpolator
    merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    ys = np.linspace(merc(bounds[3]), merc(bounds[1]), SIZE)
    lat = np.clip(np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2), bounds[1], bounds[3])
    lon = np.linspace(bounds[0], bounds[2], SIZE)
    la, lo = np.meshgrid(lat, lon, indexing='ij')
    points = np.stack((la, lo), axis=-1)
    components = []
    for name in ('10u', '10v'):
        grid = lower[name] * (1 - fraction) + upper[name] * fraction
        components.append(RegularGridInterpolator((lower['lat'], lower['lon']), grid)(points))
    u, v = components
    angles = np.mod(np.degrees(np.arctan2(-u, -v)), 360)
    values = [int(round(a)) % 360 if speed >= .5 else None
              for a, speed in zip(angles.ravel(), np.hypot(u, v).ravel())]
    destination.write_text(json.dumps(payload(bounds, valid, values), separators=(',', ':')))


def nordic_url(manifest, valid):
    from update_forecast_map import projected_bbox
    return manifest['endpoint'] + '?' + urlencode({
        'service': 'WMS', 'version': '1.1.1', 'request': 'GetMap',
        'layers': 'wind_direction_10m', 'styles': 'raster/greyscale',
        'colorscalerange': '0,360', 'numcolorbands': 256, 'logscale': 'false',
        'belowmincolor': 'extend', 'abovemaxcolor': 'extend', 'nodatacolor': 'transparent',
        'format': 'image/png', 'transparent': 'true', 'srs': 'EPSG:3857',
        'bbox': ','.join(map(str, projected_bbox(manifest['bounds']))),
        'width': SIZE, 'height': SIZE, 'time': valid})


def write_nordic(manifest, valid, destination):
    request = urllib.request.Request(nordic_url(manifest, valid), headers={
        'User-Agent': 'NorthernWeather/1.0 https://github.com/Snowblind54/weather-page'})
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read(1024 * 1024)
    with Image.open(io.BytesIO(raw)) as image:
        if image.size != (SIZE, SIZE):
            raise ValueError('Unexpected Nordic wind direction grid')
        rgba = np.array(image.convert('RGBA'))
    # ncWMS greyscale has 256 linear bins (black=0°, white=360°).
    valid_pixels = rgba[:, :, 3] > 0
    if not valid_pixels.any():
        raise ValueError('Empty Nordic wind direction grid')
    if not (np.array_equal(rgba[:, :, 0][valid_pixels], rgba[:, :, 1][valid_pixels])
            and np.array_equal(rgba[:, :, 0][valid_pixels], rgba[:, :, 2][valid_pixels])):
        raise ValueError('Non-greyscale Nordic direction encoding')
    values = [int(round(int(p[0]) / 255 * 360)) % 360 if p[3] else None
              for p in rgba.reshape(-1, 4)]
    destination.write_text(json.dumps(payload(manifest['bounds'], valid, values), separators=(',', ':')))


def filename(valid):
    return 'wind-vectors-' + valid.replace('-', '').replace(':', '')[:11] + 'Z.json'


def descriptor(root, cycle, times):
    return {'version': 1, 'convention': 'wind_from_degrees',
            'frames': {valid: f'data/{root}/{cycle}/{filename(valid)}' for valid in times}}
