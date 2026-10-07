#!/usr/bin/env python3
"""Build a compact shared NOAA SWPC snapshot for the Space Weather map."""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "space-weather.json"

URLS = {
    "aurora": "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
    "kp": "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    "wind": "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
    "mag": "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json",
    "power": "https://services.swpc.noaa.gov/text/aurora-nowcast-hemi-power.txt",
}

USER_AGENT = "NorthernWeatherMap/1.0 (+https://github.com/Snowblind54/weather-page)"


def fetch_json(url: str, attempts: int = 4):
    last_error = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=35) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                return json.load(response)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(2.5 * attempt)
    raise RuntimeError(f"Could not fetch {url}: {last_error}")


def fetch_text(url: str, attempts: int = 4) -> str:
    last_error = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/plain"})
        try:
            with urllib.request.urlopen(req, timeout=35) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(2.5 * attempt)
    raise RuntimeError(f"Could not fetch {url}: {last_error}")


def as_float(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def latest_record(rows, required_key: str | None = None):
    if not isinstance(rows, list):
        return None
    for row in reversed(rows):
        if not isinstance(row, dict):
            continue
        if required_key and as_float(row.get(required_key)) is None:
            continue
        if row.get("active") is False:
            continue
        return row
    for row in reversed(rows):
        if isinstance(row, dict) and (not required_key or as_float(row.get(required_key)) is not None):
            return row
    return None


def parse_observed_kp(payload):
    """Support both NOAA's current object format and its older header-row format."""
    records = []
    if isinstance(payload, list) and payload:
        if isinstance(payload[0], dict):
            records = payload
        elif isinstance(payload[0], list):
            header = [str(v) for v in payload[0]]
            for row in payload[1:]:
                if isinstance(row, list):
                    records.append(dict(zip(header, row)))
    if not records:
        return {"value": None, "time": None}
    row = records[-1]
    value = as_float(row.get("Kp", row.get("kp", row.get("kp_index"))))
    return {"value": round(value, 2) if value is not None else None, "time": row.get("time_tag")}


def power_time(value: str) -> str | None:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d_%H:%M").replace(tzinfo=timezone.utc)
        return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")
    except (TypeError, ValueError):
        return None


def parse_hemi_power(text: str):
    """Parse the newest NOAA OVATION northern/southern hemispheric power row."""
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 4:
            continue
        north = as_float(parts[2])
        south = as_float(parts[3])
        observation = power_time(parts[0])
        forecast = power_time(parts[1])
        if north is None or observation is None or forecast is None:
            continue
        return {
            "north": round(north, 1),
            "south": round(south, 1) if south is not None else None,
            "observationTime": observation,
            "forecastTime": forecast,
            "unit": "GW",
        }
    raise RuntimeError("NOAA hemispheric power file contained no usable rows")


def previous_power():
    try:
        previous = json.loads(OUTPUT.read_text(encoding="utf-8"))
        power = previous.get("hemisphericPower")
        return power if isinstance(power, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def compact_aurora(payload):
    lat_min, lat_max = 35, 90
    width = 360
    height = lat_max - lat_min + 1
    values = [0] * (width * height)
    max_value = 0

    coordinates = payload.get("coordinates", []) if isinstance(payload, dict) else []
    for item in coordinates:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        lon = as_float(item[0])
        lat = as_float(item[1])
        value = as_float(item[2])
        if lon is None or lat is None or value is None:
            continue
        ilat = int(round(lat))
        ilon = int(round(lon)) % 360
        if ilat < lat_min or ilat > lat_max:
            continue
        ivalue = max(0, min(100, int(round(value))))
        values[(ilat - lat_min) * width + ilon] = ivalue
        max_value = max(max_value, ivalue)

    if not any(values):
        source_nonzero = any(
            isinstance(item, (list, tuple)) and len(item) >= 3 and (as_float(item[2]) or 0) > 0
            for item in coordinates
        )
        if source_nonzero:
            raise RuntimeError("OVATION grid could not be compacted")

    return {
        "observationTime": payload.get("Observation Time"),
        "forecastTime": payload.get("Forecast Time"),
        "latMin": lat_min,
        "latMax": lat_max,
        "width": width,
        "height": height,
        "values": values,
        "max": max_value,
    }


def main():
    aurora_raw = fetch_json(URLS["aurora"])
    kp_raw = fetch_json(URLS["kp"])
    wind_raw = fetch_json(URLS["wind"])
    mag_raw = fetch_json(URLS["mag"])

    try:
        hemispheric_power = parse_hemi_power(fetch_text(URLS["power"]))
    except RuntimeError as exc:
        # Do not take down the entire Space Weather snapshot if this auxiliary
        # product is briefly unavailable. Preserve the previous value so the UI
        # can mark it stale rather than silently replacing it with fresh-looking data.
        hemispheric_power = previous_power()
        print(f"Warning: hemispheric power unavailable: {exc}")

    kp = parse_observed_kp(kp_raw)
    wind = latest_record(wind_raw, "proton_speed")
    mag = latest_record(mag_raw, "bz_gsm")

    speed = as_float(wind.get("proton_speed")) if wind else None
    bz = as_float(mag.get("bz_gsm")) if mag else None
    bt = as_float(mag.get("bt")) if mag else None

    data = {
        "version": 1,
        "generatedAt": int(time.time()),
        "provider": "NOAA Space Weather Prediction Center",
        "aurora": compact_aurora(aurora_raw),
        "hemisphericPower": hemispheric_power,
        "kp": kp,
        "solarWind": {
            "speed": round(speed, 1) if speed is not None else None,
            "speedTime": wind.get("time_tag") if wind else None,
            "bz": round(bz, 2) if bz is not None else None,
            "bt": round(bt, 2) if bt is not None else None,
            "magTime": mag.get("time_tag") if mag else None,
            "source": (wind or mag or {}).get("source"),
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    temporary.replace(OUTPUT)

    power = data.get("hemisphericPower") or {}
    print(
        "Space weather snapshot: "
        f"Kp={data['kp']['value']} "
        f"wind={data['solarWind']['speed']} km/s "
        f"Bz={data['solarWind']['bz']} nT "
        f"aurora max={data['aurora']['max']}% "
        f"north power={power.get('north')} GW"
    )
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
