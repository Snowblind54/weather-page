# Baltic Weather Map

Interactive Baltic weather map covering Estonia, Latvia and Lithuania.

## Structure

- `index.html` — page markup and script loading only
- `css/style.css` — interface and Leaflet styling
- `js/config.js` — shared service configuration and geographic bounds
- `js/map.js` — map setup, shared state, base maps and location
- `js/warnings.js` — Estonia and Lithuania severe-weather warnings
- `js/latvia-warnings.js` — official Latvian warning polygons and freshness checks
- `js/temperature.js` — Baltic temperature field and labels
- `js/wind.js` — cached hourly wind grids, offshore sampling and animated canvas trails
- `js/clouds.js` — EUMETSAT day/night cloud processing and animation
- `js/radar.js` — KAIA HDF5 rain radar and timeline frame loading
- `js/app.js` — controls, event handlers, refresh timers and startup

The live site is deployed by GitHub Pages from the `main` branch.

Wind has an independent toggle and follows the radar timeline (or current time if
radar is unavailable). It samples a continuous land/sea grid from Open-Meteo with
`cell_selection=nearest`, plus a finer Baltic grid. Wind direction is converted
from meteorological "from" bearings to east/north velocity before spatial and
temporal interpolation. Data load only on demand, in sequential batches, and are
cached for 45 minutes. The canvas runs at at most 30 fps, pauses during map moves
and while the tab is hidden, and stops completely when disabled. Trail motion is
scaled for readability rather than representing real travel distance. Wind data:
Open-Meteo, CC BY 4.0.

Trails use speed bands in m/s: blue 0–3, green 3–6, yellow 6–10,
orange 10–15, red 15–25, purple 25+. These are visual bands, not warning
thresholds. Clicking the map while Wind is enabled shows the interpolated
10 m wind speed (one decimal place), meteorological from-direction, coordinates
and selected time. An open wind popup follows timeline changes and data refreshes
and closes when Wind is disabled. Existing warning/marker click actions remain.

Latvian warnings use LVĢMC's public `https://bridinajumi.meteo.lv/list.php`
and linked CAP documents. `scripts/update_latvia_warnings.py` retains the English
warning text and simplifies native polygons within 0.0007 degrees (about 80 m).
The scheduled `Update Latvia warnings` workflow refreshes
`data/latvia-warnings.json` approximately every 15 minutes; scheduled GitHub jobs
can be delayed. Browsers fetch the current snapshot from raw GitHub, which supports
CORS and updates independently of a Pages rebuild. Snapshots older than one hour
are reported unavailable. Expired warnings are removed and the shared today/tomorrow
filter uses Europe/Riga. No-warning snapshots contain an empty records array.
The temperature heatmap is off by default and can be enabled separately.
