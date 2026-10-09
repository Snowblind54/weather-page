# Weather delivery when R2 is unavailable

The website normally reads snapshots and prepared images from the R2/CDN URL. It retries failed snapshot requests against the public `weather-fallback` branch after a four-second connection timeout. A small status file, checked at most once per minute, also signals when the updaters have switched to GitHub because publishing to R2 failed or was paused. This handles R2 returning an old successful response during a publishing pause.

The hourly **Maintain GitHub weather fallback** workflow keeps a standby copy of weather snapshots, forecast images, Denmark/Iceland radar images and 14-day snow history. Each updater restores verified GitHub inputs and publishes its own scope to this branch if R2 is unavailable. Provider failures preserve the last successful data and its actual timestamps; a fallback cannot make unavailable observations fresh.

Set the repository Actions variable `R2_PAUSED` to `true` to deliberately skip R2 reads/writes in weather updaters. Clear it or set it to `false` to resume normal publication. This does not suspend the Cloudflare account, change billing, or implement a monthly operations counter. The independent storage-maintenance workflow remains separate.

Prepared radar and satellite tile archives are deliberately excluded from the GitHub mirror. Their existing direct-provider loaders keep the map/timeline working, but loading may be slower during an outage. Forecast images retry their GitHub copies when their primary image request fails. After transient errors the browser retries R2 after a minute; an updater's active-fallback signal lasts 30 minutes and is renewed while publishers use GitHub.

The snapshot branch is separate from `main`. Publications merge other updater scopes using force-with-lease and retry conflicts. Each new snapshot is a parentless commit, leaving one reachable data version. GitHub may retain unreachable objects until its garbage collection; this is not a hard guarantee against all repository storage growth. Retired forecast/radar/snow files are removed from the current snapshot when their updater replaces its scope. Publications exceeding 400 MiB total or 50 MiB per file retain the previous snapshot. The regular hourly backup downloads changed inputs only and adds some R2 read operations.

Run the outage checks with:

```sh
python3 -m unittest discover -s tests -p test_github_fallback.py -v
node tests/r2-storage.test.cjs
node --test tests/forecast-map.test.cjs
```
