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
Snow is excluded from the model fallback. Since v8.15 official hourly gauge
precipitation takes priority where a complete window and nearby gauges exist. Rainfall uses the five existing model grids and the country masks
for EE, LV, LT, FI, SE, NO, IS, PL and DK. Dry ground is transparent; missing hours
remain unavailable. Masks include coastlines, islands and holes; missing masks
prevent an unmasked rectangular overlay. The source data is cached for 30 minutes,
with hourly coverage checked before reuse. Images are cached by period and end
hour. Switches and timeline changes invalidate in-flight renders. Map clicks show
all three totals in mm and also wind readings when wind is enabled.

Streets adds small numeric EMODnet DTM depth labels over the existing bathymetry
shading, from zoom 5. `js/bathymetry.js` samples only visible sea points through
the official `/depth_sample` REST service. Mean negative seabed elevations are
displayed as positive depths in metres. Land and unavailable values are omitted.
Requests are limited to four concurrent queries and 48 points per view; samples
are cached for reuse. Panning/zooming adapts spacing and invalidates old label
renders. Labels and shading are removed on Satellite.

Run rainfall regression checks with `node --test tests/rainfall.test.cjs`.

Wind and accumulation popups disable Leaflet `autoPan` and `keepInView` (v8.14.2).
Updating a reading with the two-hour timeline preserves the selected map view,
including when its existing probe popup has been panned outside the viewport.


## Official rainfall / precipitation (v8.15)

`update-rainfall.yml` collects official observations every 15 minutes and on
collector changes. `scripts/update_rainfall.py` publishes a same-origin
`data/official-rainfall.json` snapshot, retaining 72 hours. It uses Estonia's
hourly XML precipitation, LHMT station observation histories, FMI hourly WFS
`r_1h`, SMHI parameter 7 (good-quality hourly observations), and DMI
`precip_past1h` with bounded pagination. SMHI histories bootstrap from the last
months, then refresh from the last day. Estonia's longer totals become available
only after collecting consecutive hours; missing hours are never synthesized.
Source failures retain valid prior measurements and don't stop other countries.

`js/official-rainfall.js` selects a complete 1/24/48-hour window per country.
Reporting lag up to two hours is allowed with the actual end time displayed.
Older snapshots or incomplete windows fall back to Open-Meteo. Heatmap values
use inverse-distance weighting of up to six gauges within 100 km, restricted to
the same country and clipped to coastlines. Model values fill coverage gaps.
Numeric labels from zoom 6 show actual station totals and open gauge popups.
Normal map clicks show each period's source, actual end and nearest gauge; a
gauge click never substitutes model data for an unavailable measurement.
Official precipitation includes snow water equivalent; model fallback remains
rain plus showers. DMI trace codes are stored as zero plus a trace flag, and
popups disclose amounts below 0.1 mm. Units are mm throughout.

Latvia, Norway, Iceland and Poland currently use the model fallback. Poland's
latest METEO feed provides 10-minute observations rather than a complete hourly
history; Iceland's tested hourly feed had no usable precipitation values. No
unverified reporting interval is treated as a rolling rainfall total. Source
status and the active period's gauge coverage are shown under rain radar.

Run `python3 -m unittest discover -s tests -v` and
`node --test tests/*.test.cjs` for parsing, history, missing data, source fallback,
country separation, reporting times and existing map-layer regression checks.


## Cyclones (v8.16)

The separate Cyclones card covers the North Atlantic (25–78°N, 80°W–12°W)
and northern Europe (45–78°N, west to 40°E). `update-cyclones.yml` checks every
three hours for a recent complete NOAA/NCEP GFS 0.5° run. A cropped GRIB subset
from NOMADS supplies mean sea-level pressure and 10 m u/v wind at three-hour
intervals through +96 h. This avoids exposing a third-party API key or making
large GRIB downloads in the browser. Install `scripts/requirements-cyclones.txt`
when running the collector locally.

`scripts/update_cyclones.py` smooths pressure, finds minima at/below 1020 hPa,
requires a closed 400 km ring at least 2 hPa higher, suppresses duplicate centres
within 350 km, and associates centres by position, predicted motion and pressure
using one-to-one assignment. Tracks must persist at least 9 hours. It retains
IDs across overlapping model runs where possible. Associations can bridge up
to 6 h; longer gaps are not extrapolated. Dissipation, mergers, developing lows
and weak/open centres can end or change tracks. These are derived model tracks,
not an official cyclone catalogue, warning, or forecast uncertainty cone.

`data/cyclones.json` contains the consistent model cycle, valid times, pressure,
centre coordinates and maximum modeled 10 m wind within 200 km. Official NHC
`CurrentStorms.json` names/advisory details are attached only for fresh Atlantic
storms that match a model centre; Pacific names and stale advisories are ignored.
Other lows are explicitly unnamed with a GFS tracking ID. European storm names
are not guessed. Failures retain the previous snapshot with an error flag;
forecasts older than 18 hours are hidden.

`js/cyclones.js` shows counterclockwise rotating markers with pressure colours,
clickable movement (km/h and m/s), direction, pressure/6-hour change, nearby wind,
model run and local valid times. Symbol spin rate is illustrative. Optional
48-hour dashed paths have 12-hour labels. A separate 0–48 h slider and playback
move the centres, independent of the radar timeline. Toggling, forecasts and
popups preserve the map view; only the explicit View coverage button moves it.
Reduced-motion preferences disable symbol rotation. Turning Cyclones off removes
its paths, popups and playback. Manual refresh works even if radar is offline.

Run `python -m unittest discover -s tests -v` and `node --test tests/*.test.cjs`.
Cyclone Python tests skip when the optional numerical dependencies are absent,
so the existing warnings and rainfall workflows keep working independently.


## Extended wind coverage and cyclone gusts (v8.17)

Wind and gust animation now spans 25–78°N and 85°W–42°E: the eastern United
States, North Atlantic, all of Europe and the Moscow area. A broad 300-point
grid plus 187 European and 81 Baltic detail points keeps first loads bounded
(568 locations, sequential batches of 50) and preserves European/Baltic detail.
Wind data still uses Open-Meteo, cached for 45 minutes. The cache key changes
with coverage so a smaller old grid cannot silently replace the expanded one.

Cyclone collection also requests the official GFS surface GUST diagnostic
(m/s) at each forecast valid time. Wind and gust maxima within 200 km of each
centre appear side by side in the popup. They are regional model maxima, not
measurements at the centre or an NHC reported gust. Each is interpolated between
three-hour forecast steps; an absent gust is shown as unavailable. The new
windFieldsVersion forces regeneration even for a cached model cycle without
gusts. Invalid or missing GFS gust fields cannot publish a partial snapshot.
