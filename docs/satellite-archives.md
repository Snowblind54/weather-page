# Satellite delivery archives

Satellite block generation, source selection, cloud extraction, WebP quality,
256/512/1024 resolutions, observation times, native coverage and timeline remain
unchanged. The archives contain exactly the existing WebP bytes.

New blocks are grouped by ten-minute observation bucket and a coarse geographic
region, splitting at a 4 MiB payload budget. Existing archives are never rewritten
when another block arrives. This preserves incremental upload savings and cache
stability. Older payloads retire when no retained record references their archive;
the last successful block per map coordinate remains protected on provider failure.
Accounting uses unique active archive sizes, including unused bytes in a partially
retired archive, against the existing 600 MiB satellite processing budget. R2's
central storage, expiry and monthly-operation guards are unchanged.

Format: `NWCLOUD1`, uint32 little-endian index length, JSON index mapping existing
WebP basenames to payload offset/length, concatenated unchanged WebP images.
Immutable content-hash filenames end in `.bin`, a default Cloudflare-cacheable
extension. No new cache rule, Worker or library is required. Producer checks each
original block against its packed bytes. R2 publication verifies upload checksums.

Small archives (<=256 KiB, or <=64 KiB for detected slow/data-saving connections)
load whole. Larger archives use HTTP byte ranges. The browser decodes only the
required existing resolution, then applies the original viewport crop. Compressed
cache: 4 MiB on coarse-pointer/mobile devices, 12 MiB otherwise, maximum 40
archives. Existing decoded cloud canvas cache and cancellation remain in force.
If a host ignores Range, a valid complete archive is reused. Errors recover via
R2/GitHub routing and then existing native source logic.

Both storage modes use the existing data/cloud-tiles scope. Hourly GitHub standby
backup includes archives; during an R2 pause, updater archives publish directly
to GitHub. Retired individual R2 WebP objects expire centrally, without an extra
bucket scan. First migration packs the verified existing snapshot; scheduled
updates continue preparing new official imagery normally.

Validation includes exact block bytes, incremental reuse, size splitting, original
coverage/crops/times, whole/range/ignored-range downloads, memory budgets, invalid
responses and native recovery. Migration performs public CORS, whole download,
partial download and byte-equality checks. Read savings depend on cache and view;
archive packing primarily reduces Class A writes, not a guaranteed Class B total.
