"""Extend the shared official-temperature snapshot with Latvia.

The core collector lives in update_official_temperature.py. Latvia uses the
same LVGMC operational CKAN feed already used by the official wind collector,
with TDRY as the measured dry-bulb air-temperature parameter.
"""
from __future__ import annotations

import json
import urllib.parse

import update_official_temperature as core
import update_north_america_temperature
import update_atlantic_temperature
import update_us_temperature
import update_western_temperature
import update_central_temperature

LATVIA_DATASTORE = "https://data.gov.lv/dati/api/3/action/datastore_search?"
LATVIA_STATIONS_RESOURCE = "c32c7afd-0d05-44fd-8b24-1de85b4bf11d"
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


def parse_latvia_ckan():
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


def parse_latvia_portal_or_synop():
    try:
        rows=parse_latvia_ckan()
        now=core.dt.datetime.now(core.dt.timezone.utc)
        if not any(s['rows'] and s['rows'][-1][0]>=int(now.timestamp())-3*3600 for s in rows):raise ValueError('No recent Latvian portal temperatures')
        return rows
    except Exception as error:
        print('Latvian temperature portal unavailable; using official SYNOP:',str(error)[:150],flush=True)
        from europe_synop import load_latvian_temperature
        return load_latvian_temperature(core.dt.datetime.now(core.dt.timezone.utc),core.download)


def parse_latvia():
    try:
        import latvia_observations as lv
        result=[]
        for s in lv.load(core.dt.datetime.now(core.dt.timezone.utc),core.download_json):
            item=core.make_station('LV',s['code'],s['name'],s['lat'],s['lon'],[(r[0],r[1]) for r in s['rows']])
            if item:item['source']=lv.SOURCE;result.append(item)
        if not any(s['rows'][-1][0]>=int(core.dt.datetime.now(core.dt.timezone.utc).timestamp())-2*3600 for s in result):raise ValueError('No recent LVĢMC temperatures')
        return result
    except Exception as error:
        print('LVĢMC website temperature feed unavailable:',str(error)[:150],flush=True)
        return parse_latvia_portal_or_synop()


core.SOURCES["LV"] = "Latvian Environment, Geology and Meteorology Centre (LVGMC)"
core.LOADERS["LV"] = parse_latvia


def parse_france():
    import meteofrance_observations as mf
    now=core.dt.datetime.now(core.dt.timezone.utc)
    try:
        rows=mf.load_temperature(now,core.download)
        print('FR: Météo-France national API:',len(rows),'temperature stations',flush=True)
        return rows
    except Exception as error:
        print('FR national temperature API unavailable:',str(error)[:180],'; using official SYNOP backup',flush=True)
        from europe_synop import load_temperature
        rows=load_temperature('FR',now,core.download)
        for s in rows:s['observationNetwork']='france-synop'
        return rows


def parse_andorra():
    from andorra_observations import load_temperature
    return load_temperature(core.dt.datetime.now(core.dt.timezone.utc),core.download_json)


core.SOURCES.update({'FR':'Météo-France / national six-minute API with official three-hourly SYNOP backup',
                     'AD':'Servei Meteorològic Nacional (Andorra) / Meteo.ad'})
core.COUNTRY_BOUNDS.update({'FR':(41,51.5,-5.5,10),'AD':(42.4,42.7,1.4,1.8)})
core.LOADERS.update({'FR':parse_france,'AD':parse_andorra})


def parse_spain():
    from iberia_observations import load_temperature
    return load_temperature('ES',core.dt.datetime.now(core.dt.timezone.utc),core.download)


def parse_portugal():
    from iberia_observations import load_temperature
    return load_temperature('PT',core.dt.datetime.now(core.dt.timezone.utc),core.download)


from iberia_observations import BOUNDS as IBERIA_BOUNDS, SOURCES as IBERIA_SOURCES
core.SOURCES.update(IBERIA_SOURCES)
core.COUNTRY_BOUNDS.update(IBERIA_BOUNDS)
core.LOADERS.update({'ES':parse_spain,'PT':parse_portugal})


if __name__ == "__main__":
    core.main()


