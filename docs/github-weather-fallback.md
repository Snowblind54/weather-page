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

## Automatic operation cutoff

The account usage guard stops these weather workflows' R2 requests when Cloudflare reports **950,000 Class A** or **9,700,000 Class B** operations in the current billing cycle. Both limits apply account-wide, including other buckets and visitor requests. It uses `r2OperationsAdaptiveGroups` rather than estimating uploads or counting only this repository's jobs. Unfamiliar dashboard/configuration operations are conservatively counted against both limits, so totals may slightly exceed billable usage. Malformed/partial analytics and API errors fail closed after activation. The new monitor schedules checks every five minutes; running S3 clients recheck at most once per minute before their next call, including paginator calls. Manual `R2_PAUSED=true` still overrides the automatic guard.

Activation requires:

1. Create a Cloudflare API token with **Account → Account Analytics → Read**, scoped to the account containing R2. Save it as the GitHub Actions repository secret **`CLOUDFLARE_R2_ANALYTICS_TOKEN`**. This is a Cloudflare Analytics token, not an R2/S3 access key. Never place it in website code or chat.
2. Under Manage Account → Billing → Billable Usage, find the current billing period's start date. Save its day of month (1–31) as the GitHub Actions repository variable **`R2_BILLING_DAY`**. Cloudflare billing follows the account's billing cycle in UTC, not necessarily the first of the calendar month.
3. Run **Guard monthly R2 operations** manually, or wait for its next scheduled run. Verify the job reports `enabled: true` and `within_limits` or `operations_limit`.

Until the Analytics token is configured, the new automatic guard reports that it is **not activated** and preserves normal R2 service. Adding a token without a valid billing day pauses R2 until configuration is complete. After activation, removing the token also pauses R2 rather than silently disabling protection.

Once either threshold trips, the cutoff remains latched for the rest of that billing cycle even if reported counts temporarily decrease. The monitor publishes a small GitHub budget control and a persistent fallback signal; later updater publications cannot clear it. Updater restores, uploads, verification and central storage maintenance stop making R2 calls; weather snapshots keep updating on the GitHub fallback. The next verified billing cycle releases the automatic cutoff. The browser checks the signal before new snapshot requests and once per minute while visible. Prepared radar/cloud archives remain excluded from GitHub; original providers keep their layers available. No Analytics credential or account-wide count is published to the website.

This is a **soft usage safeguard, not a Cloudflare billing cap**. Analytics may be delayed/sampled, GitHub cron schedules can be delayed, and already-started or retrying requests can finish. Cached older versions of the site, direct requests to public R2 addresses, other applications and other buckets are outside this cutoff. Pausing uploads alone would not stop Class B usage; this guard also redirects current clients and blocks updater reads, but does not disable Cloudflare's public bucket or change account billing. Storage can still incur charges. The five-minute monitor does not perform any R2 reads, writes or bucket listings.

References: [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/), [R2 operation classes](https://developers.cloudflare.com/r2/pricing/), [Analytics token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/), [billing period](https://developers.cloudflare.com/billing/manage/billable-usage/).
