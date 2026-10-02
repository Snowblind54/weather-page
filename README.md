# Baltic Weather Map

Interactive Baltic weather map covering Estonia, Latvia and Lithuania.

## Structure

- `index.html` — page markup and script loading only
- `css/style.css` — interface and Leaflet styling
- `js/config.js` — shared service configuration and geographic bounds
- `js/map.js` — map setup, shared state, base maps and location
- `js/warnings.js` — Estonia and Lithuania severe-weather warnings
- `js/temperature.js` — Baltic temperature field and labels
- `js/clouds.js` — EUMETSAT day/night cloud processing and animation
- `js/radar.js` — KAIA HDF5 rain radar and timeline frame loading
- `js/app.js` — controls, event handlers, refresh timers and startup

The live site is deployed by GitHub Pages from the `main` branch.
