# Baltic Weather Map

Interactive weather map covering the Baltics and Northern Europe.

## Structure

- `index.html` — page markup and script loading only
- `css/style.css` — interface and Leaflet styling
- `js/config.js` — shared service configuration and geographic bounds
- `js/map.js` — map setup, shared state, base maps and location
- `js/warnings.js` — official Baltic and Nordic severe-weather warnings
- `js/warning-filters.js` — local-day filtering and automatic exact-time expiry
- `js/national-warnings.js` — official IMGW/DMI polygons and snapshot freshness
- `js/latvia-warnings.js` — official Latvian warning polygons and freshness checks
- `js/temperature.js` — coastline-clipped regional model heatmaps and labels
- `js/stations.js` — official national temperature observations
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

Wind requests also include `wind_gusts_10m` in m/s. The popup labels sustained
wind and gusts separately; trail colours and motion continue to use sustained
wind. Gusts are spatially interpolated scalar values from the hourly maximum
for the hour containing the selected time (the API timestamp marks its end).
Gusts are not blended across hours, and their hour-ending timestamp is shown.
Missing gusts display as unavailable rather than zero. Wind cache schema v3
invalidates old vector-only caches and earlier grid bounds.

Latvian warnings use LVĢMC's public `https://bridinajumi.meteo.lv/list.php`
and linked CAP documents. `scripts/update_latvia_warnings.py` retains the English
warning text and simplifies native polygons within 0.0007 degrees (about 80 m).
The scheduled `Update official Latvia, Poland and Denmark warnings` workflow refreshes
`data/latvia-warnings.json` approximately every 15 minutes; scheduled GitHub jobs
can be delayed. Browsers fetch the current snapshot from raw GitHub, which supports
CORS and updates independently of a Pages rebuild. Snapshots older than one hour
are reported unavailable. Expired warnings are removed and the shared today/tomorrow
filter uses Europe/Riga. No-warning snapshots contain an empty records array.
The temperature heatmap is off by default and can be enabled separately.

All warning countries use their exact official expiry timestamps, including
Lithuania. A local timer removes expired polygons and list cards and updates
counts without waiting for the next 15-minute feed refresh. Returning to a
background tab rechecks expiry immediately. Lithuanian cancellation notices
are ignored.

Polish temperature points come directly from IMGW–PIB's public METEO API
(`https://danepubliczne.imgw.pl/api/data/meteo`), using its published station
coordinates and air-temperature observation timestamps. Danish points use
DMI's public MetObs API (`https://opendataapi.dmi.dk/v2/metObs/`), parameter
`temp_dry`, with a two-hour observation window and the latest valid reading per
station. Both support browser CORS without credentials. Station feeds refresh
on demand at ten-minute intervals; labels use observations within 95 minutes
of the selected map time. Missing temperature values are omitted, not zeroed.

Poland and Denmark have dedicated Open-Meteo model grids. Heatmaps use Natural
Earth country polygons in Web Mercator to clip coastlines and national borders,
including Danish islands and Bornholm. If coastline data are unavailable, no
unmasked tile is drawn. Numeric readings work independently with heatmap off.

The default base map is Esri satellite imagery with transportation and place
labels. Switching to Streets adds sea-only EMODnet Bathymetry 2024 DTM shading
in its own pane below the weather layers. Its transparent land pixels preserve
the existing OpenTopoMap roads and land terrain; it is removed in Satellite mode.

The Wind section now has a Sustained wind / Wind gusts selector. Gust animation
uses the hourly maximum magnitude and the sustained wind direction, since the
source does not provide a separate gust direction. Gust magnitudes interpolate
spatially as scalars, and do not blend across hours. Both modes retain the regular
speed colours; gusts above (strictly greater than) 33 m/s add pink. At exactly
33 m/s gusts remain purple. Missing gusts are not replaced with sustained speed.
The regional wind grid extends south to 48°N to include Poland, and cache schema
v3 prevents old grid bounds being reused.

`update_national_warnings.py` fetches IMGW's public county-warning service and
DMI's public WarningAreas service, plus their own published boundary geometries.
It preserves islands and polygon holes and simplifies rings within 0.0007°.
Poland's severity levels and Denmark's categories 1–3 map to yellow/orange/red.
DMI category 0 risk advisories are omitted. Offset-bearing validity timestamps
are retained; timestamps without offsets use Europe/Warsaw or Europe/Copenhagen.
The shared scheduled warning workflow updates `data/national-warnings.json`
about every 15 minutes (GitHub scheduled jobs may be delayed). Country timestamps
advance only after a successful source fetch; snapshots over one hour old are
unavailable. Raw GitHub supplies browser CORS, with same-site and browser-cache
fallbacks. All expiry timers and popup/list times use the warning country's local
timezone, including daylight-saving rules. No new hosting server is required.

The heatmap continues to use Open-Meteo's terrain-adjusted model field. National
station coverage and observation times vary; interpolating only displayed station
values would smooth across mountain/valley differences and create gaps. Official
observations still take priority for numeric labels, and heatmaps remain optional.

## Rainfall accumulation and depth labels (v8.14)

The rain radar card also has independent 1, 24 and 48-hour rainfall toggles. One
period colours the map at a time; disabling radar does not disable accumulation.
`js/rainfall.js` requests Open-Meteo hourly `rain` + `showers` in millimetres with
54 past hours and one current hour. Totals are rolling completed-hour sums ending
at the hour at or before the selected radar timeline time, capped at the present.
Snow is excluded. The maps are interpolated model estimates, not gauge or radar
measurements. Rainfall uses the five existing model grids and the country masks
for EE, LV, LT, FI, SE, NO, IS, PL and DK. Dry ground is transparent; missing hours
remain unavailable. Masks include coastlines, islands and holes; missing masks
prevent an unmasked rectangular overlay. The source data is cached for 30 minutes,
with hourly coverage checked before reuse. Images are cached by period and end
hour. Switches and timeline changes invalidate in-flight renders. Map clicks show
all three totals in mm and also wind readings when wind is enabled.

Streets adds the official transparent EMODnet `emodnet:contours` WMS layer above
the existing bathymetry shading, from zoom 5. Small contour labels are depths in
metres (50, 100, 200, 500, 1000, 2000 and 5000); their placement follows the
provider's generalized isobaths. Both sea layers are removed on Satellite.

Run rainfall regression checks with `node --test tests/rainfall.test.cjs`.
