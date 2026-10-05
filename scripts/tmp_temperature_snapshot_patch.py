from pathlib import Path

p=Path('scripts/update_official_temperature.py')
text=p.read_text()

old="def make_station(country, code, name, lat, lon, rows):\n    lat, lon = float(lat), float(lon)\n"
new="def make_station(country, code, name, lat, lon, rows):\n    try:\n        lat, lon = float(lat), float(lon)\n    except (TypeError, ValueError):\n        return None\n"
if old in text:
    text=text.replace(old,new,1)

text=text.replace('"starttime": start.isoformat().replace("+00:00", "Z"),\n        "endtime": end.isoformat().replace("+00:00", "Z"),',
                  '"starttime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),\n        "endtime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),')

old_lt="""        lat = details.get(\"latitude\") or details.get(\"lat\")
        lon = details.get(\"longitude\") or details.get(\"lon\") or details.get(\"lng\")
"""
new_lt="""        coords = details.get(\"coordinates\") or {}
        lat = details.get(\"latitude\") or details.get(\"lat\") or coords.get(\"latitude\") or coords.get(\"lat\")
        lon = details.get(\"longitude\") or details.get(\"lon\") or details.get(\"lng\") or coords.get(\"longitude\") or coords.get(\"lon\") or coords.get(\"lng\")
"""
if old_lt in text:
    text=text.replace(old_lt,new_lt,1)

p.write_text(text)
