# Weather data storage

The website code and static Estonian marine coastline stay in GitHub. Generated weather snapshots, radar PNGs, forecast images, and the 14-day snow archive are published directly to the `northern-weather-data` R2 bucket under `weather/data/`.

Each updater restores its own verified last successful R2 inputs, runs its existing provider processing, and publishes only its own output paths. GitHub Actions caches reduce repeated archive downloads. A conditional renewable R2 lease serializes restore/publication operations; generating new data does not hold the lease.

Assets are uploaded and verified before manifests. A publication intent protects new assets if a later manifest upload fails. Existing live assets remain protected until the replacement succeeds. Older generated snapshots cannot overwrite newer snapshots. A failed provider update retains its restored previous snapshot.

## Expiry and budget

Hourly maintenance and every publisher remove retired weather assets: radar files after one day, other files after two days, and snow history after sixteen days. Files required by the current last successful snapshot stay protected, including during provider outages. Current 14-day snow history is preserved.

Automatic uploads refuse a conservative projected bucket usage above **8,000,000,000 bytes**, including replacement files and a registry reserve. The count includes other objects in this bucket. There is no native hard bucket capacity setting: this guard controls these workflows, not manual uploads or unrelated writers. The 2 GB margin is intended to keep automated weather storage below 10 GB.

Reports are emitted to workflow logs; hourly maintenance stores a seven-day Actions report artifact. Registry and renewable publication lock are under `_weather/control/`.

## Configuration

GitHub Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`. Credentials are only used by Actions; no credentials are delivered to browsers. The browser public base URL is configured in `index.html` and routed by `js/r2-storage.js`.

R2 bucket CORS must allow GET/HEAD from `https://snowblind54.github.io`. The existing `r2.dev` endpoint works for this migration. A production custom domain can later replace the public base URL to enable Cloudflare edge caching and avoid development endpoint rate limits.

Code changes and deployments continue through GitHub Pages. Generated files are ignored by Git. Removing the current generated tree does not rewrite existing Git history.
