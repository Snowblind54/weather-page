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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "model-wind.json"
API = "https://api.open-meteo.com/v1/forecast"
BATCH_SIZE = 50

# Two-degree North Atlantic sampling, with half-degree detail around Iceland.
WIND_GRIDS = [
    {"south": 25, "north": 84, "west": -142, "east": 42, "rows": 14, "cols": 36},
    {"south": 50, "north": 78, "west": -65, "east": 5, "rows": 15, "cols": 36},
    {"south": 34, "north": 74, "west": -15, "east": 42, "rows": 11, "cols": 17},
    {"south": 53, "north": 61, "west": 19, "east": 31, "rows": 9, "cols": 9},
    {"south": 60, "north": 68, "west": -26, "east": -12, "rows": 17, "cols": 29},
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


def main() -> None:
    points = [point for grid in WIND_GRIDS for point in grid_points(grid)]
    all_series = []
    times = None

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
                "past_hours": "4",
                "forecast_hours": "3",
                "cell_selection": "nearest",
            }
        )
        payload = request_json(f"{API}?{params}")
        items = payload if isinstance(payload, list) else [payload]
        if len(items) != len(batch):
            raise RuntimeError(f"Incomplete wind grid: expected {len(batch)} locations, got {len(items)}")

        for item in items:
            hourly = item.get("hourly") or {}
            item_times = hourly.get("time") or []
            if len(item_times) < 2:
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

        print(f"Fetched {min(offset + len(batch), len(points))}/{len(points)} wind points", flush=True)
        if offset + len(batch) < len(points):
            time.sleep(1.5)

    grids = []
    offset = 0
    for grid in WIND_GRIDS:
        count = grid["rows"] * grid["cols"]
        grids.append(all_series[offset : offset + count])
        offset += count

    if not times or len(grids) != len(WIND_GRIDS) or not any(any(sample for sample in series) for series in grids[0]):
        raise RuntimeError("No usable wind data returned")

    data = {
        "version": 5,
        "savedAt": int(time.time() * 1000),
        "times": times,
        "grids": grids,
        "source": "Open-Meteo hourly 10 m wind",
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, OUTPUT)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
