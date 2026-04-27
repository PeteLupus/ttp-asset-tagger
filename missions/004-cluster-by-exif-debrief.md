## MISSION: cluster-by-exif — 2026-04-27

**Objective:** Pre-group source images into job batches (same suburb, same day) so Vic can bulk-tag entire clusters in one action instead of file-by-file. Cuts ~600 form submissions to ~94.

**Outcome:** Shipped

**What worked:**
- **Drive's `imageMediaMetadata` field returns parsed EXIF** including `location.latitude`, `location.longitude`, `time` directly — zero file downloads required. Killed half the planned scope (no exifr, no file streaming). Original plan called for downloading 65 KB per image; actual implementation just adds `imageMediaMetadata` to the existing `files.list` query.
- Nominatim with on-disk cache keyed by 3-decimal-rounded coords (~110 m bucketing). 753 images → ~50 unique geocode requests → finished in ~1 minute. No API key, no cost.
- Bulk-tag endpoint reuses existing `getOrCreateDestRoot()` + `ensureFolder()` + `moveFile()` from `/api/tag` — single source of truth for the move logic, no duplication.
- Files tagged via cluster auto-disappear from per-file `/api/next` queue because both write to the same `progress.tagged` map.
- Pure-analysis script (`scripts/cluster.js`), matches dedup.js pattern. No Drive writes during cluster build.

**Findings:**
- 850 source images/videos → 753 images with EXIF GPS+date → **94 clusters / 605 files clustered**. 148 files ungrouped (no GPS, no date, or geocode failed). All 76 dupes already pulled by Phase 2 cull.
- Biggest cluster: **Kew VIC 2017-11-02 — 71 files**. One tag-all click closes 71 entries.
- Top 5 clusters cover ~150 files. Vic could clear most of the source folder with <10 cluster decisions.

**What broke:**
- `exifr` and `@turf/*` installed per original plan but became dead code once `imageMediaMetadata` was discovered. Left installed (cheap) — could be removed in cleanup pass.
- Initial bitwise-AND bug in cache-hit count (`cachedKeys.size & uniqueKeys.size` vs proper Set intersection). Caught in first run, fixed.
- Original plan said extend `recon.js` per-file. Skipped — `imageMediaMetadata` made it unnecessary, separate `cluster.js` is cleaner.

**Learnings:**
- **Always check what the API gives you for free before parsing files.** Drive's metadata fields cost nothing extra in a `files.list` call. Could have saved 30+ minutes of planning around exifr/HEIC parsing.
- Nominatim with coord-rounding cache is the right reverse-geocoder for one-shot tagging tools. Polygon datasets are overkill at this scale.
- The "Dedup Review" tab pattern (separate screen, decision endpoints, progress file) generalises cleanly — Batch Tag is essentially the same shape.

**Open items:**
- Vic field-test on full 850-asset folder. UI starts on Batch Tab when clusters available.
- 148 ungrouped files (videos, screenshots, no-GPS) fall through to per-file Tagger tab unchanged.
- HEIC dedup re-pass for the 11 skipped files from Phase 1 — still pending, separate mission.
- Move on to social posting tool next.

**Files added/modified:**
- `scripts/cluster.js` (new) — analysis script, writes `data/cluster_report.json`
- `server.js` — `/api/clusters`, `/api/clusters/tag`, `/api/clusters/skip` endpoints
- `public/index.html` — Batch Tag tab + screen, keyboard shortcuts, thumbs grid
- `config.js` — `clusterReportPath`, `clusterProgressPath`
- `.gitignore` — cluster artifacts, geocode cache
- `package.json` — added `exifr`, `@turf/*` (currently unused)
