from pathlib import Path

# Extend official temperature retention to 24 hours.
p=Path("scripts/update_official_temperature.py")
t=p.read_text(encoding="utf-8")
assert "HISTORY_SEC = 3 * 60 * 60" in t
t=t.replace("HISTORY_SEC = 3 * 60 * 60","HISTORY_SEC = 24 * 60 * 60",1)
assert '"historyHours": 3,' in t
t=t.replace('"historyHours": 3,','"historyHours": HISTORY_SEC // 3600,',1)
p.write_text(t,encoding="utf-8")

# Temperature renderer: expose snapshot freshness, keep 24h history, fit the chart.
p=Path("js/stations.js")
t=p.read_text(encoding="utf-8")
assert "const OFFICIAL_TEMP_HISTORY_SEC=3*60*60;" in t
t=t.replace("const OFFICIAL_TEMP_HISTORY_SEC=3*60*60;","const OFFICIAL_TEMP_HISTORY_SEC=24*60*60;",1)
assert "officialTemperatureSourceState=snapshot.sources||{};" in t
t=t.replace("officialTemperatureSourceState=snapshot.sources||{};",
            "officialTemperatureSourceState=snapshot.sources||{};\n      window.__officialTemperatureGeneratedAt=snapshot.generatedAt;",1)
assert "maxWidth:280,className:'wind-popup-container'" in t
t=t.replace("maxWidth:280,className:'wind-popup-container'","maxWidth:340,className:'wind-popup-container'",1)
p.write_text(t,encoding="utf-8")

# Expose the true newest rendered satellite source observation time.
p=Path("js/clouds.js")
t=p.read_text(encoding="utf-8")
old="  layer.observationLabel=cloudTimeDescription(successful);\n  weatherFront();"
assert old in t
new="""  layer.observationLabel=cloudTimeDescription(successful);
  const freshnessTimes=successful.flatMap(tile=>tile.times.flatMap(source=>[source.day,source.night].filter(Number.isFinite)));
  window.__cloudFreshnessTime=freshnessTimes.length?Math.max(...freshnessTimes):null;
  weatherFront();"""
t=t.replace(old,new,1)
p.write_text(t,encoding="utf-8")

# Load the new lightweight feature modules after the static scripts are available.
p=Path("js/config.js")
t=p.read_text(encoding="utf-8")
anchor="  document.body.appendChild(spaceWeatherScript);\n});"
assert anchor in t
replacement="""  document.body.appendChild(spaceWeatherScript);

  const temperatureHistoryScript=document.createElement('script');
  temperatureHistoryScript.src='js/temperature-history.js?v=1';
  document.body.appendChild(temperatureHistoryScript);

  const freshnessScript=document.createElement('script');
  freshnessScript.src='js/data-freshness.js?v=1';
  document.body.appendChild(freshnessScript);
});"""
t=t.replace(anchor,replacement,1)
p.write_text(t,encoding="utf-8")

# Cache-bust changed static files and update temperature attribution/help copy.
p=Path("index.html")
t=p.read_text(encoding="utf-8")
for old,new in [
    ("js/config.js?v=8.88","js/config.js?v=8.89"),
    ("js/stations.js?v=8.73","js/stations.js?v=8.74"),
    ("js/clouds.js?v=8.33","js/clouds.js?v=8.34"),
]:
    assert old in t, old
    t=t.replace(old,new,1)
old_copy="Click an official reading for station name, exact measured temperature, observation time, station ID, coordinates and source."
if old_copy in t:
    t=t.replace(old_copy,"Click an official reading for station details and its measured temperature history graph (up to 24 hours as retained observations accumulate).",1)
old_lv="Latvia currently keeps model-based temperatures where an official observation feed is not available."
if old_lv in t:
    t=t.replace(old_lv,"Latvia is included through official LVGMC dry-bulb temperature observations.",1)
p.write_text(t,encoding="utf-8")
