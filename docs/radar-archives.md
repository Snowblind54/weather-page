# Prepared radar archives

Each official station/observation now has one immutable `.bin` file containing
the exact original PNG tiles for zooms 3–7. No re-encoding or time interpolation.
Native feeds still provide close-zoom detail above zoom 7 and recover if an
archive cannot load. The normal observation selection and 2.5-hour retention,
including the last successful frame per station, are unchanged.

Format: `NWRAD001` (8 bytes), little-endian unsigned 32-bit JSON index length,
UTF-8 index `{tiles: {"z/x/y": [offset, length]}, payloadBytes: number}`, then
concatenated PNG bytes. Offsets are relative to the payload. The producer checks
every tile byte against its input before atomic publication. Descriptors include
size, index size, and SHA-256. Existing storage publication verifies upload checksums.
Limits: 64 KiB index and 8 MiB frame. Dry scans have an empty index.

The browser retrieves the entire archive if <=256 KiB, or <=64 KiB for detected
slow/data-saving connections. Otherwise it reads the header/index and visible
tile ranges. If a host ignores Range and returns a valid complete file, that file
is retained rather than repeatedly downloaded. Immutable URLs allow CDN caching;
`.bin` is a default Cloudflare-cacheable extension. No new cache rule is required.

Compressed cache: 4 MiB on light/mobile mode, 12 MiB otherwise, at most 40 frames.
Only visible tiles are decoded, drawn into the existing bounded canvas, and
released. Existing queue limits, preload selection, and mosaic memory budgets
remain in force. Requests share in-flight byte downloads. Old viewport results
cannot be cached after panning or zooming.

Archives use the existing `data/radar-tiles` scope, R2 guard and expiry, hourly
GitHub standby backup, and active GitHub fallback publication. The delivery
router preserves Range headers. Healthy updaters convert restored individual
tiles once, then publish one object per new frame. Retired individual R2 tiles
are removed through normal central expiry rather than a special bucket scan.
A first conversion uploads all retained frames; later updates upload only new
ones. Manifests, locks, and publication registry still have their own operations.

Validation: producer losslessness/dry-scan/retention tests; browser whole/range,
ignored-Range, malformed/truncated response, caching and memory tests; viewport
and existing R2/GitHub pause/recovery tests. Verify public 200 and 206 responses
with browser Origin headers after first live publication. Phone speed must still
be assessed on a real device; local tests do not establish iPhone timings.
