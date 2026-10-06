#!/usr/bin/env python3
"""Build a compact ECMWF IFS total-cloud field for aurora viewing conditions."""

from __future__ import annotations

import base64
import json
import math
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from eccodes import codes_get, codes_get_array, codes_grib_new_from_file, codes_release
from ecmwf.opendata import Client

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "aurora-cloud.json"

LAT_MIN = 35.0
LAT_MAX = 90.0
RESOLUTION = 0.25
WIDTH = int(round(360.0 / RESOLUTION))
HEIGHT = int(round((LAT_MAX - LAT_MIN) / RESOLUTION)) + 1
MISSING = 255


def utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return utc(value).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def choose_step(run_time: datetime) -> int:
    """Choose the 3-hour IFS step closest to the short-term aurora forecast time."""
    target = datetime.now(timezone.utc) + timedelta(hours=1)
    hours = max(0.0, (target - utc(run_time)).total_seconds() / 3600.0)
    step = int(round(hours / 3.0) * 3)
    return max(0, min(144, step))


def quantize_cloud(grib_path: Path):
    with grib_path.open("rb") as handle:
        gid = codes_grib_new_from_file(handle)
        if gid is None:
            raise RuntimeError("ECMWF cloud GRIB did not contain a field")
        try:
            units = str(codes_get(gid, "units"))
            param_id = int(codes_get(gid, "paramId"))
            source_resolution = float(codes_get(gid, "iDirectionIncrementInDegrees"))
            latitudes = codes_get_array(gid, "latitudes")
            longitudes = codes_get_array(gid, "longitudes")
            values = codes_get_array(gid, "values")
        finally:
            codes_release(gid)

    if not (len(latitudes) == len(longitudes) == len(values)):
        raise RuntimeError("ECMWF cloud GRIB arrays have inconsistent sizes")

    finite_values = [float(v) for v in values if math.isfinite(float(v))]
    if not finite_values:
        raise RuntimeError("ECMWF cloud GRIB contains no finite values")

    # ECMWF can expose tcc either as percent (228164) or as a 0..1 fraction (164).
    fractional = max(finite_values) <= 1.5
    multiplier = 100.0 if fractional else 1.0

    grid = bytearray([MISSING]) * (WIDTH * HEIGHT)
    written = 0

    for lat_raw, lon_raw, value_raw in zip(latitudes, longitudes, values):
        lat = float(lat_raw)
        if lat < LAT_MIN - 0.01 or lat > LAT_MAX + 0.01:
            continue
        value = float(value_raw)
        if not math.isfinite(value):
            continue

        lon = ((float(lon_raw) + 180.0) % 360.0) - 180.0
        x = int(round((lon + 180.0) / RESOLUTION)) % WIDTH
        y = int(round((lat - LAT_MIN) / RESOLUTION))
        if y < 0 or y >= HEIGHT:
            continue

        cloud = int(round(max(0.0, min(100.0, value * multiplier))))
        index = y * WIDTH + x
        if grid[index] == MISSING:
            written += 1
        grid[index] = cloud

    expected = WIDTH * HEIGHT
    coverage = written / expected
    if coverage < 0.98:
        raise RuntimeError(f"ECMWF cloud crop is incomplete: {coverage:.1%} coverage")

    valid_values = [value for value in grid if value != MISSING]
    return {
        "bytes": grid,
        "paramId": param_id,
        "units": units,
        "sourceResolution": source_resolution,
        "coverage": coverage,
        "min": min(valid_values),
        "max": max(valid_values),
        "mean": round(sum(valid_values) / len(valid_values), 1),
    }


def existing_identity():
    try:
        data = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return data.get("runTime"), data.get("validTime")
    except (OSError, json.JSONDecodeError):
        return None, None


def main():
    client = Client(source="ecmwf", model="ifs", resol="0p25")
    run_time = utc(client.latest(stream="oper", type="fc", levtype="sfc", param="tcc", step=0))
    step = choose_step(run_time)
    valid_time = run_time + timedelta(hours=step)

    run_iso = iso_z(run_time)
    valid_iso = iso_z(valid_time)
    if existing_identity() == (run_iso, valid_iso):
        print(f"ECMWF aurora cloud field already current: run {run_iso}, valid {valid_iso}")
        return

    with tempfile.TemporaryDirectory(prefix="aurora-cloud-") as temp_dir:
        grib_path = Path(temp_dir) / "tcc.grib2"
        client.retrieve(
            date=run_time.strftime("%Y%m%d"),
            time=run_time.hour,
            stream="oper",
            type="fc",
            levtype="sfc",
            step=step,
            param="tcc",
            target=str(grib_path),
        )
        cloud = quantize_cloud(grib_path)

    data = {
        "version": 1,
        "generatedAt": int(time.time()),
        "provider": "ECMWF IFS Open Data",
        "runTime": run_iso,
        "validTime": valid_iso,
        "stepHours": step,
        "latMin": LAT_MIN,
        "latMax": LAT_MAX,
        "lonMin": -180.0,
        "lonMax": 180.0,
        "resolution": RESOLUTION,
        "width": WIDTH,
        "height": HEIGHT,
        "encoding": "uint8-base64",
        "missing": MISSING,
        "values": base64.b64encode(cloud["bytes"]).decode("ascii"),
        "source": {
            "param": "tcc",
            "paramId": cloud["paramId"],
            "units": cloud["units"],
            "sourceResolution": cloud["sourceResolution"],
        },
        "stats": {
            "coverage": round(cloud["coverage"], 4),
            "min": cloud["min"],
            "max": cloud["max"],
            "mean": cloud["mean"],
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    temporary.replace(OUTPUT)

    print(
        f"ECMWF aurora cloud: run={run_iso} valid={valid_iso} step={step}h "
        f"coverage={cloud['coverage']:.1%} cloud={cloud['min']}..{cloud['max']}% "
        f"mean={cloud['mean']}%"
    )
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
