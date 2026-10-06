"""Extend the shared official-temperature snapshot with Latvia.

The core collector lives in update_official_temperature.py. Latvia uses the
same LVGMC operational CKAN feed already used by the official wind collector,
with TDRY as the measured dry-bulb air-temperature parameter.
"""
from __future__ import annotations

import json
import urllib.parse

import update_official_temperature as core

LATVIA_DATASTORE = "https://data.gov.lv/dati/api/3/action/datastore_search?"
LATVIA_STATIONS_RESOURCE = "c32e88fe-e3c2-46b1-ae5d-ac3b35c2c2c7"
LATVIA_OBS_RESOURCE = "17460efb-ae99-4d1d-8144-1068f184b05f"
LATVIA_TEMP_PARAMETER = "TDRY"


def datastore_records(resource_id: str, **params):
    query = {"resource_id": resource_id, **params}
    payload = core.download_json(LATVIA_DATASTORE + urllib.parse.urlencode(query), 35)
    result = payload.get("result") or {}
    records = result.get("records") or []
    if not isinstance(records, list):
        raise ValueError("Unexpected LVGMC datastore response")
    return records


def parse_latvia():
    metadata = datastore_records(LATVIA_STATIONS_RESOURCE, limit=1000)
    stations = {}
    for item in metadata:
        code = str(item.get("STATION_ID") or "").strip()
        if not code:
            continue
        try:
            lat = float(item.get("GEOGR2"))
            lon = float(item.get("GEOGR1"))
        except (TypeError, ValueError):
            continue
        stations[code] = {
            "name": item.get("NAME") or item.get("STATION_NAME") or code,
            "lat": lat,
            "lon": lon,
        }

    observations = datastore_records(
        LATVIA_OBS_RESOURCE,
        limit=5000,
        sort="DATETIME desc",
        filters=json.dumps({"ABBREVIATION": LATVIA_TEMP_PARAMETER}),
    )

    grouped = {}
    for item in observations:
        code = str(item.get("STATION_ID") or "").strip()
        if code not in stations or not item.get("DATETIME"):
            continue
        grouped.setdefault(code, []).append((item["DATETIME"], item.get("VALUE")))

    out = []
    for code, rows in grouped.items():
        meta = stations[code]
        station = core.make_station(
            "LV", code, meta["name"], meta["lat"], meta["lon"], rows
        )
        if station:
            out.append(station)

    if not out:
        raise ValueError("No current Latvian TDRY temperature observations")
    return out


core.SOURCES["LV"] = "Latvian Environment, Geology and Meteorology Centre (LVGMC)"
core.LOADERS["LV"] = parse_latvia


if __name__ == "__main__":
    core.main()
