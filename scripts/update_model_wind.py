#!/usr/bin/env python3
"""Build the shared wind-model grid used by the browser animation.

The browser used to query Open-Meteo for all 568 grid points itself. That made
individual visitors hit provider rate limits. This updater performs that work
centrally and publishes one small static snapshot for every visitor.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "model-wind.json"
API = "https://api.open-meteo.com/v1/forecast"
BATCH_SIZE = 50

# Two-degree North Atlantic sampling, with half-degree detail around Iceland.
WIND_GRIDS = [
    {"south": 25, "north": 84, "west": -142, "east": 42, "rows": 14, "cols": 36},
    {"south": 40, "north": 84, "west": -142, "east": -52, "rows": 23, "cols": 31},
    {"south": 50, "north": 78, "west": -65, "east": 5, "rows": 15, "cols": 36},
    {"south": 34, "north": 74, "west": -15, "east": 42, "rows": 21, "cols": 33},
    {"south": 53, "north": 61, "west": 19, "east": 31, "rows": 9, "cols": 9},
    {"south": 60, "north": 68, "west": -26, "east": -12, "rows": 17, "cols": 29},
]

# Keep the six legacy grids intact so already-open pages can use new snapshots.
# Additional grids are self-describing and consumed by the extended client.
WIND_EXTRA_GRIDS = [
    {"id": "hemisphere", "model": "best_match", "south": 0, "north": 84, "west": -180, "east": 180, "rows": 22, "cols": 73},
    {"id": "usa", "model": "gfs_seamless", "south": 18, "north": 54, "west": -132, "east": -55, "rows": 37, "cols": 78},
    {"id": "alaska", "model": "gfs_seamless", "south": 50, "north": 74, "west": -180, "east": -130, "rows": 13, "cols": 26},
    {"id": "hawaii", "model": "gfs_seamless", "south": 17, "north": 24, "west": -163, "east": -151, "rows": 8, "cols": 13},
]


def grid_points(grid: dict) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for row in range(grid["rows"]):
        for col in range(grid["cols"]):
            lat = grid["south"] + (grid["north"] - grid["south"]) * row / (grid["rows"] - 1)
            lon = grid["west"] + (grid["east"] - grid["west"]) * col / (grid["cols"] - 1)
            points.append((lat, lon))
    return points


def wind_sample(speed, direction, gust):
    try:
        speed = float(speed)
        direction = float(direction)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(speed) or speed < 0 or not math.isfinite(direction):
        return None
    radians = math.radians(direction)
    u = -speed * math.sin(radians)
    v = -speed * math.cos(radians)
    try:
        gust = float(gust)
        if not math.isfinite(gust) or gust < 0:
            gust = None
    except (TypeError, ValueError):
        gust = None
    return [round(u, 4), round(v, 4), None if gust is None else round(gust, 3)]


def request_json(url: str):
    last_error: Exception | None = None
    for attempt in range(4):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "NorthernWeatherMap/1.0 (+https://github.com/Snowblind54/weather-page)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code != 429 and exc.code < 500:
                raise
            retry_after = exc.headers.get("Retry-After")
            try:
                delay = max(10, min(120, int(retry_after))) if retry_after else 15 * (2**attempt)
            except ValueError:
                delay = 15 * (2**attempt)
            print(f"Open-Meteo HTTP {exc.code}; retrying in {delay}s", flush=True)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            delay = 10 * (2**attempt)
            print(f"Open-Meteo request failed ({exc}); retrying in {delay}s", flush=True)
            time.sleep(delay)
    raise RuntimeError(f"Open-Meteo wind request failed after retries: {last_error}")


def collect_points(points, model, start_hour, end_hour, expected_times=None):
    all_series = []
    times = expected_times
    for offset in range(0, len(points), BATCH_SIZE):
        batch = points[offset : offset + BATCH_SIZE]
        params = urllib.parse.urlencode(
            {
                "latitude": ",".join(f"{lat:.6f}" for lat, _ in batch),
                "longitude": ",".join(f"{lon:.6f}" for _, lon in batch),
                "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
                "wind_speed_unit": "ms",
                "timeformat": "unixtime",
                "timezone": "UTC",
                "start_hour": start_hour,
                "end_hour": end_hour,
                "cell_selection": "nearest",
                "models": model,
            }
        )
        payload = request_json(f"{API}?{params}")
        items = payload if isinstance(payload, list) else [payload]
        if len(items) != len(batch):
            raise RuntimeError(f"Incomplete wind grid: expected {len(batch)} locations, got {len(items)}")

        for item in items:
            hourly = item.get("hourly") or {}
            units = item.get("hourly_units") or {}
            if units.get("wind_speed_10m") != "m/s" or units.get("wind_gusts_10m") != "m/s" or units.get("wind_direction_10m") != "°":
                raise RuntimeError("Unexpected wind units")
            item_times = hourly.get("time") or []
            if len(item_times) < 2 or any(b <= a for a, b in zip(item_times, item_times[1:])):
                raise RuntimeError("Wind hours are unavailable")
            if times is None:
                times = item_times
            elif times != item_times:
                raise RuntimeError("Wind grid hours do not match")

            speeds = hourly.get("wind_speed_10m") or []
            directions = hourly.get("wind_direction_10m") or []
            gusts = hourly.get("wind_gusts_10m") or []
            series = [
                wind_sample(
                    speeds[i] if i < len(speeds) else None,
                    directions[i] if i < len(directions) else None,
                    gusts[i] if i < len(gusts) else None,
                )
                for i in range(len(item_times))
            ]
            all_series.append(series)

        print(f"Fetched {min(offset + len(batch), len(points))}/{len(points)} {model} wind points", flush=True)
        if offset + len(batch) < len(points):
            time.sleep(1.5)
    return times, all_series


def build_snapshot(anchor):
    # Pin all regions/models to the same hours, even across an hourly boundary.
    start_hour = datetime.fromtimestamp(anchor - 4 * 3600, timezone.utc).strftime("%Y-%m-%dT%H:%M")
    end_hour = datetime.fromtimestamp(anchor + 6 * 3600, timezone.utc).strftime("%Y-%m-%dT%H:%M")
    specs = [{**grid, "model": "best_match"} for grid in WIND_GRIDS] + WIND_EXTRA_GRIDS
    keys = lambda grid: [(grid["model"], round(lat, 6), round(((lon+180) % 360)-180, 6)) for lat, lon in grid_points(grid)]
    unique = list(dict.fromkeys(key for grid in specs for key in keys(grid)))
    series_by_key = {}
    times = None
    for model in dict.fromkeys(key[0] for key in unique):
        model_keys = [key for key in unique if key[0] == model]
        times, series = collect_points([(lat, lon) for _, lat, lon in model_keys], model, start_hour, end_hour, times)
        series_by_key.update(zip(model_keys, series))
    grids = [[series_by_key[key] for key in keys(grid)] for grid in specs]
    if not times or any(not any(sample for series in grid for sample in series) for grid in grids):
        raise RuntimeError("No usable wind data returned for a region")
    print(f"Collected {len(unique)} unique model locations; shared nodes fetched once", flush=True)
    return {
        "version": 6,
        "savedAt": int(time.time() * 1000),
        "times": times,
        "grids": grids[:len(WIND_GRIDS)],
        "extraGrids": [{**spec, "series": series} for spec, series in zip(WIND_EXTRA_GRIDS, grids[len(WIND_GRIDS):])],
        "source": "Open-Meteo best match; NOAA GFS/HRRR seamless over USA, Alaska and Hawaii · hourly 10 m wind",
    }


def main() -> None:
    data = build_snapshot(int(time.time() // 3600) * 3600)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, OUTPUT)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
