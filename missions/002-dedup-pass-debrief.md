## MISSION: dedup-pass — 2026-04-22

**Objective:** Perceptual hash all images in source Drive folder, identify duplicate groups, produce dedup_report.json. Read-only — no Drive writes.

**Outcome:** Shipped

**What worked:**
- dHash via sharp streaming transform (no full-file buffer) — memory efficient, processed 821 images concurrently (8 workers)
- Union-find grouping on all-pairs hamming comparison — O(n²) comparisons in <1ms for 821 files
- Two-tier approach: pHash for images, exact-size match for videos/oversized
- `failOnError: false` on sharp prevented one bad file from killing the batch

**What broke:**
- 11 HEIC files all errored with "bad seek" — HEIC/HEIF format requires random file access to decode; sharp's streaming mode can't seek. These need to be buffered first before passing to sharp. Workaround for next pass: detect `image/heif`/`image/heic` mimeType and use full-buffer approach instead of streaming.

**Findings:**
- 61 pHash dupe groups (129 image files) — mostly exact copies (hamming=0), a few near-dupes (thumbnail+original pairs)
- 8 exact-size video groups (16 files) — all clear duplicates (same filename, same size)
- 76 total files flagged for deletion → 850 unique files remaining (from 926)
- 406MB bytes to reclaim
- 272MB MP4 pair is the biggest single win

**Learnings:**
- HEIC streaming dedup: buffer-first required. Add HEIC-specific branch in next pass.
- dHash threshold=5 seems well-calibrated: catches thumbnail/original pairs (hamming=1) and exact copies (hamming=0) without false positives
- pHash all-pairs on 821 files is instant — don't bother with pre-filtering by size for images

**Open items:**
- Phase 2: Operator reviews dedup_report.json, greenlights cull list
- Phase 3: Execute cull script (batch trash in Drive) from approved kill_ids
- Fix: Add buffered HEIC pass for the 11 skipped files
