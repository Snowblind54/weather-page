# Baltic Weather Map

Interactive Baltic weather map covering Estonia, Latvia and Lithuania.

## Structure

- `index.html` — page markup and script loading only
- `css/style.css` — interface and Leaflet styling
- `js/config.js` — shared service configuration and geographic bounds
- `js/map.js` — map setup, shared state, base maps and location
- `js/warnings.js` — Estonia and Lithuania severe-weather warnings
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
