# Weather data storage

The website code and static Estonian marine coastline stay in GitHub. Generated weather snapshots, radar PNGs, forecast images, and the 14-day snow archive are published directly to the `northern-weather-data` R2 bucket under `weather/data/`.

Each updater restores its own verified last successful R2 inputs, runs its existing provider processing, and publishes only its own output paths. GitHub Actions caches reduce repeated archive downloads. A conditional renewable R2 lease serializes restore/publication operations; generating new data does not hold the lease.

Assets are uploaded and verified before manifests. A publication intent protects new assets if a later manifest upload fails. Existing live assets remain protected until the replacement succeeds. Older generated snapshots cannot overwrite newer snapshots. A failed provider update retains its restored previous snapshot.

## Expiry and budget

Hourly maintenance and every publisher remove retired weather assets: radar and prepared satellite files after one day, other files after two days, and snow history after sixteen days. Files required by the current last successful snapshot stay protected, including during provider outages. Current 14-day snow history is preserved.

Automatic uploads refuse a conservative projected bucket usage above **8,000,000,000 bytes**, including replacement files and a registry reserve. The count includes other objects in this bucket. There is no native hard bucket capacity setting: this guard controls these workflows, not manual uploads or unrelated writers. The 2 GB margin is intended to keep automated weather storage below 10 GB.

Reports are emitted to workflow logs; hourly maintenance stores a seven-day Actions report artifact. Registry and renewable publication lock are under `_weather/control/`.

## Configuration

GitHub Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`. Credentials are only used by Actions; no credentials are delivered to browsers. The browser public base URL is configured in `index.html` and routed by `js/r2-storage.js`.

R2 bucket CORS allows GET/HEAD from `https://snowblind54.github.io` and `https://northweather.app`. Weather files use `https://data.northweather.app`. Its Cloudflare Cache Rule makes `/weather/data/` eligible and respects the publisher's cache headers: current JSON snapshots expire after 60 seconds, immutable images after 24 hours.

## Prepared satellite clouds

The ten-minute satellite workflow downloads official Meteosat, GOES-East/West and Metop-C imagery and runs the existing shared cloud extraction and regional blending code centrally. Padded Web Mercator blocks preserve the current zoom-6 native sampling. Blocks have small overview images and larger detail images so phones need only the visible portion at the selected zoom. Content-addressed WebP files are published before `cloud-tiles.json` and reused when source observations are unchanged.

The archive keeps three hours for the two-hour timeline, plus the last successful block independently for each area when a source fails. Actual source timestamps remain in the manifest; historical selections never borrow future observations. Processing is bounded to 180 blocks / 12 minutes per run and a 600 MiB archive. The shared 8 GB bucket guard still applies. A cold start fills latest coverage first and then backfills history over subsequent runs. The browser falls back to its existing provider path where prepared coverage or delivery is unavailable.

Decoded prepared blocks and cropped display tiles have separate bounded caches (8 + 16 MiB on phones), with stale work cancelled during map movement. Workflow logs report block counts, processing time and archive size; central preparation adds upload operations while CDN hits reduce visitor reads.

Code changes and deployments continue through GitHub Pages. Generated files are ignored by Git. Removing the current generated tree does not rewrite existing Git history.
