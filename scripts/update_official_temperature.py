"""Build a shared 10-minute snapshot of official Northern European temperatures.

The browser reads data/official-temperature.json instead of querying every
national API for every visitor. Recent history is retained for the 2-hour
playback where providers expose it; no model values are written to this file.
"""
from __future__ import annotations

import concurrent.futures as futures
import datetime as dt
import gzip
import json
import math
import pathlib
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

OUTPUT = pathlib.Path(__file__).resolve().parents[1] / "data/official-temperature.json"
HISTORY_SEC = 3 * 60 * 60
FUTURE_TOLERANCE_SEC = 10 * 60
BOUNDS = (48.5, 72.5, -26.0, 33.0)
USER_AGENT = "NorthernWeather/8.71 (github.com/Snowblind54/weather-page)"

SOURCES = {
    "EE": "Estonian Environment Agency",
    "LT": "Lithuanian Hydrometeorological Service / Meteo.lt",
    "FI": "Finnish Meteorological Institute (FMI)",
    "SE": "Swedish Meteorological and Hydrological Institute (SMHI)",
    "NO": "MET Norway / Seklima",
    "IS": "Icelandic Meteorological Office (IMO)",
    "PL": "IMGW – Państwowy Instytut Badawczy",
    "DK": "Danish Meteorological Institute (DMI)",
}


def download(url: str, timeout: int = 35) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(12 * 1024 * 1024 + 1)
    if len(raw) > 12 * 1024 * 1024:
        raise ValueError("temperature response too large")
    return gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw


def download_json(url: str, timeout: int = 35):
    return json.loads(download(url, timeout))


def num(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return round(n, 2) if math.isfinite(n) and -70 < n < 55 else None


def stamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        return int(n / 1000 if n > 1e11 else n)
    text = str(value).strip().replace(" ", "T", 1)
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def make_station(country, code, name, lat, lon, rows):
    lat, lon = float(lat), float(lon)
    south, north, west, east = BOUNDS
    if not (south <= lat <= north and west <= lon <= east):
        return None
    by_time = {}
    for time_value, temp_value in rows:
        t, v = stamp(time_value), num(temp_value)
        if t is not None and v is not None:
            by_time[t] = [t, v]
    if not by_time:
        return None
    return {
        "country": country,
        "code": str(code or ""),
        "name": str(name or "Weather station"),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "source": SOURCES[country],
        "rows": [by_time[t] for t in sorted(by_time)],
    }


def local(el):
    return el.tag.split("}")[-1]


def parse_estonia():
    root = ET.fromstring(download("https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php"))
    t = int(root.attrib["timestamp"])
    out = []
    for el in root.findall("station"):
        temperature = num(el.findtext("airtemperature"))
        if temperature is None:
            continue
        name = el.findtext("name") or "Estonian station"
        item = make_station("EE", el.findtext("wmocode") or name, name,
                            el.findtext("latitude"), el.findtext("longitude"), [(t, temperature)])
        if item:
            out.append(item)
    return out


def parse_lithuania():
    base = "https://api.meteo.lt/v1"
    stations_payload = download_json(base + "/stations")
    stations = stations_payload if isinstance(stations_payload, list) else stations_payload.get("stations", [])
    stations = stations[:60]

    def one(meta):
        code = meta.get("code") or meta.get("stationCode") or meta.get("id")
        if not code:
            return None
        data = download_json(base + "/stations/" + urllib.parse.quote(str(code)) + "/observations/latest", 25)
        observations = data.get("observations") or []
        details = data.get("station") or meta
        lat = details.get("latitude") or details.get("lat")
        lon = details.get("longitude") or details.get("lon") or details.get("lng")
        rows = []
        for obs in observations:
            rows.append((obs.get("observationTimeUtc") or obs.get("time") or obs.get("date"),
                         obs.get("airTemperature") if obs.get("airTemperature") is not None else obs.get("temperature")))
        return make_station("LT", code, details.get("name") or meta.get("name") or code, lat, lon, rows)

    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        return [x for x in pool.map(one, stations) if x]


def parse_finland():
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(minutes=190)
    params = urllib.parse.urlencode({
        "service": "WFS", "version": "2.0.0", "request": "getFeature",
        "storedquery_id": "fmi::observations::weather::simple", "bbox": "19,59,32,71.7",
        "starttime": start.isoformat().replace("+00:00", "Z"),
        "endtime": end.isoformat().replace("+00:00", "Z"), "timestep": "10", "parameters": "t2m",
    })
    root = ET.fromstring(download("https://opendata.fmi.fi/wfs?" + params, 40))
    grouped = {}
    for el in root.iter():
        if local(el) != "BsWfsElement":
            continue
        values = {local(child): (child.text or "").strip() for child in el.iter()}
        parameter = values.get("ParameterName", "").lower()
        if parameter and parameter != "t2m" and "temperature" not in parameter:
            continue
        pos = values.get("pos", "").split()
        if len(pos) < 2:
            continue
        lat, lon = map(float, pos[:2])
        name = values.get("LocationName") or values.get("StationName") or "FMI station"
        code = values.get("fmisid") or f"{lat:.4f},{lon:.4f}"
        key = str(code)
        grouped.setdefault(key, [name, lat, lon, []])[3].append((values.get("Time"), values.get("ParameterValue")))
    out = []
    for code, (name, lat, lon, rows) in grouped.items():
        item = make_station("FI", code, name, lat, lon, rows)
        if item:
            out.append(item)
    return out


def parse_sweden():
    data = download_json("https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/1/station-set/all/period/latest-hour/data.json")
    out = []
    for meta in data.get("station") or []:
        rows = [(v.get("date") or v.get("time"), v.get("value")) for v in (meta.get("value") or [])]
        item = make_station("SE", meta.get("key") or meta.get("id") or meta.get("name"),
                            meta.get("name") or "SMHI station", meta.get("latitude"), meta.get("longitude"), rows)
        if item:
            out.append(item)
    return out


def parse_norway():
    base = "https://rim.k8s.met.no/api/v1/"
    now = dt.datetime.now(dt.timezone.utc)
    start_date = (now - dt.timedelta(days=2)).date().isoformat()
    end_date = (now + dt.timedelta(days=1)).date().isoformat()
    station_q = urllib.parse.urlencode({"sourceName": "", "weatherElements": "air_temperature",
                                        "timeResolution": "hours", "from": start_date, "to": end_date,
                                        "includeRegions": "false"})
    meta_payload = download_json(base + "stations?" + station_q, 40)
    metadata = [s for s in (meta_payload.get("data") or []) if "MET.NO" in (s.get("stationHolders") or [])
                and len((s.get("geometry") or {}).get("coordinates") or []) >= 2]
    by_code = {str(s["id"]): s for s in metadata}
    batches = [metadata[i:i + 40] for i in range(0, len(metadata), 40)]

    def batch_load(batch):
        q = urllib.parse.urlencode({"sources": ",".join(str(s["id"]) for s in batch),
                                    "referenceTime": f"{start_date}/{end_date}",
                                    "elements": "air_temperature", "timeResolution": "hours"})
        payload = download_json(base + "observations?" + q, 40)
        grouped = {}
        for row in payload.get("data") or []:
            source = str(row.get("sourceId", "")).split(":")
            code = source[0]
            if code not in by_code or (len(source) > 1 and source[1] != "0"):
                continue
            for obs in row.get("observations") or []:
                if obs.get("elementId") != "air_temperature" or obs.get("timeSeriesId", 0) != 0:
                    continue
                if obs.get("qualityCode") not in (0, 2, 4):
                    continue
                grouped.setdefault(code, []).append((row.get("referenceTime"), obs.get("value")))
        return grouped

    combined = {}
    with futures.ThreadPoolExecutor(max_workers=3) as pool:
        for grouped in pool.map(batch_load, batches):
            for code, rows in grouped.items():
                combined.setdefault(code, []).extend(rows)
    out = []
    for code, rows in combined.items():
        meta = by_code[code]
        lon, lat = meta["geometry"]["coordinates"][:2]
        item = make_station("NO", code, meta.get("shortName") or meta.get("name") or code, lat, lon, rows)
        if item:
            out.append(item)
    return out


def parse_iceland():
    stations = download_json("https://api.vedur.is/weather/stations?active=true&station_type=sj", 30)
    observations = download_json("https://api.vedur.is/weather/observations/aws/hour/latest?parameters=basic", 30)
    station_rows = stations if isinstance(stations, list) else stations.get("stations") or stations.get("data") or []
    obs_rows = observations if isinstance(observations, list) else observations.get("observations") or observations.get("data") or []
    meta = {str(s.get("station") or s.get("id") or s.get("station_id")): s for s in station_rows}
    out = []
    for obs in obs_rows:
        code = str(obs.get("station") or obs.get("id") or obs.get("station_id") or "")
        station_meta = meta.get(code) or obs
        lat = station_meta.get("lat") or station_meta.get("latitude")
        lon = station_meta.get("lon") or station_meta.get("longitude")
        temperature = obs.get("t") if obs.get("t") is not None else obs.get("temperature")
        item = make_station("IS", code or station_meta.get("name"), obs.get("name") or station_meta.get("name") or f"IMO {code}",
                            lat, lon, [(obs.get("time") or obs.get("observed_at") or obs.get("date"), temperature)])
        if item:
            out.append(item)
    return out


def parse_poland():
    payload = download_json("https://danepubliczne.imgw.pl/api/data/meteo", 30)
    out = []
    for row in payload if isinstance(payload, list) else []:
        item = make_station("PL", row.get("kod_stacji"), row.get("nazwa_stacji") or row.get("kod_stacji"),
                            row.get("lat"), row.get("lon"),
                            [(row.get("temperatura_powietrza_data"), row.get("temperatura_powietrza"))])
        if item:
            out.append(item)
    return out


def parse_denmark():
    now = dt.datetime.now(dt.timezone.utc)
    start = now - dt.timedelta(hours=3)
    station_payload = download_json("https://opendataapi.dmi.dk/v2/metObs/collections/station/items?bbox=7.5,54.4,15.6,58&limit=1000", 30)
    station_map = {}
    for feature in station_payload.get("features") or []:
        p = feature.get("properties") or {}
        if p.get("country") != "DNK" or p.get("status") != "Active":
            continue
        station_map[str(p.get("stationId"))] = p
    query = urllib.parse.urlencode({"parameterId": "temp_dry", "bbox": "7.5,54.4,15.6,58",
                                    "datetime": start.isoformat().replace("+00:00", "Z") + "/" + now.isoformat().replace("+00:00", "Z"),
                                    "limit": "10000"})
    payload = download_json("https://opendataapi.dmi.dk/v2/metObs/collections/observation/items?" + query, 35)
    grouped = {}
    for feature in payload.get("features") or []:
        p = feature.get("properties") or {}
        if p.get("parameterId") != "temp_dry":
            continue
        code = str(p.get("stationId") or "")
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        lon, lat = coords[:2]
        grouped.setdefault(code, [lat, lon, []])[2].append((p.get("observed"), p.get("value")))
    out = []
    for code, (lat, lon, rows) in grouped.items():
        meta = station_map.get(code) or {}
        item = make_station("DK", code, meta.get("name") or f"DMI {code}", lat, lon, rows)
        if item:
            out.append(item)
    return out


LOADERS = {
    "EE": parse_estonia, "LT": parse_lithuania, "FI": parse_finland, "SE": parse_sweden,
    "NO": parse_norway, "IS": parse_iceland, "PL": parse_poland, "DK": parse_denmark,
}


def main():
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    cutoff = now - HISTORY_SEC
    stations, states = [], {}
    with futures.ThreadPoolExecutor(max_workers=len(LOADERS)) as pool:
        jobs = {pool.submit(loader): code for code, loader in LOADERS.items()}
        for job in futures.as_completed(jobs):
            code = jobs[job]
            try:
                rows = job.result()
                trimmed = []
                for station_item in rows:
                    station_item["rows"] = [r for r in station_item["rows"] if cutoff <= r[0] <= now + FUTURE_TOLERANCE_SEC]
                    if station_item["rows"]:
                        trimmed.append(station_item)
                stations.extend(trimmed)
                states[code] = {"ok": True, "count": len(trimmed)}
            except Exception as exc:
                print(f"{code}: {exc}")
                states[code] = {"ok": False, "count": 0, "error": str(exc)[:180]}

    stations.sort(key=lambda s: (s["country"], s["name"], s["code"]))
    if not stations:
        raise SystemExit("No official temperature observations were collected")

    snapshot = {
        "version": 1,
        "generatedAt": now,
        "refreshMinutes": 10,
        "historyHours": 3,
        "unit": "°C",
        "sources": states,
        "stations": stations,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("official temperature stations:", len(stations), states)


if __name__ == "__main__":
    main()
