# Nordic and Baltic prepared radar trial

A ten-minute GitHub Actions job downloads official observations once and publishes immutable lossless 256px PNG tiles at zooms 3–7. The map loads only published tiles intersecting the viewport, paints each provider independently, and retains the existing Denmark/Sweden and Estonia ownership masks. At zoom 8 and above it uses the native feeds to preserve close-view detail. Iceland keeps its existing prepared IMO PNG path during this regional trial.

The job uses FMI (Finland), SMHI (Sweden), MET Norway, DMI (Denmark), KAIA (Estonia), LHMT (Lithuania) and LVĢMC (Latvia). Provider failures stay visible in manifest errors. No synthetic observation timestamps or interpolation are introduced. Real observation times remain displayed. Ten-minute buckets select their earliest real scan, so ordinary ten-minute timeline positions do not select a later five-minute scan.

## Bounds and failure behaviour

- Keep 2.5 hours plus the last successful frame per station when a publisher fails.
- Prepare at most 24 new observations per run, latest first, round-robin across providers.
- Cap the published archive at 240 MiB. Skip a new frame if it would exceed the cap.
- Publish the manifest only after complete tile directories are ready; never advertise unfinished tiles.
- On a manifest/tile failure, missing observation, or unsupported zoom, use the native feed.
- Keep the previous displayed observation on native-source failure and disclose its actual time.
- Download four foreground tiles at most; background buffering uses one slot and yields to selected frames.
- Retain 20 MiB of assembled viewport canvases on phones, 40 MiB on desktop. The existing native image cache also remains bounded.

## Measurements

`data/radar-tiles.json` records total processing seconds, archive bytes, and raw bytes/tile bytes/tile count/processing seconds per newly prepared observation. Each rendered prepared canvas exposes `data-radar-source`, `data-radar-tiles`, and `data-radar-load-ms`, providing a local measurement of preparing the visible view; no telemetry is sent anywhere. Warm frames reuse the viewport cache.

The first local official-data run on 2026-10-08 produced 19 observations from EE/SE/NO/DK in 334.751 seconds, with 2,862,591 bytes across all zoom levels. This is a pipeline baseline, not an iPhone loading benchmark. It exposed a Finnish XML-value parsing issue and Lithuanian image redirect handling, resolved before deployment. Latvia was not publishing recent images. Actual GitHub-run measurements and browser visible-tile timings supersede this initial baseline.

GitHub scheduling is best effort. A ten-minute check does not guarantee a ten-minute publication delay. Git history retains old binary assets even after the rolling archive deletes them: if the trial proves useful, move tile objects to separate CDN/object storage instead of treating git as permanent image storage. The website code and source selection can remain unchanged.

Satellite processing is intentionally outside this first radar trial.
