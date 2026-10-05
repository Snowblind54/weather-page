from pathlib import Path

p=Path('scripts/update_official_temperature.py')
text=p.read_text()
old="""        lat = details.get(\"latitude\") or details.get(\"lat\")
        lon = details.get(\"longitude\") or details.get(\"lon\") or details.get(\"lng\")
"""
new="""        coords = details.get(\"coordinates\") or {}
        lat = details.get(\"latitude\") or details.get(\"lat\") or coords.get(\"latitude\") or coords.get(\"lat\")
        lon = details.get(\"longitude\") or details.get(\"lon\") or details.get(\"lng\") or coords.get(\"longitude\") or coords.get(\"lon\") or coords.get(\"lng\")
"""
if old not in text:
    raise SystemExit('Lithuania coordinate block missing')
text=text.replace(old,new,1)
p.write_text(text)
