# WORKLOG — TTP Asset Tagger

## STATUS
605 of 850 assets auto-filed by EXIF cluster. Sheet delivered to Vic; operator polishing dropdown/multi-select in Excel locally before re-upload. | last commit: ce9a86e | phase: Paused — awaiting cleaned sheet from operator

## ACTIVE MISSION
**Paused — clusters-to-excel polish.**
Operator downloaded `clusters_for_vic` (native Google Sheet `1L9cAY6m9ZeEWWSc0ZYnqmGtkBR-y768mvjKUhENL71s`) to Excel to apply multi-select on Job Type column manually. Will re-upload to the source Drive folder when done.

**Resume cue:** when operator says the cleaned file is back, verify it's in source Drive folder, then either move to next front or iterate on Vic feedback.

Sheets API blocker: OAuth credentials live in a GCP project (`1036350278736`) the operator does not own, so programmatic Sheets validation is not available without reissuing credentials.

Next front: **social posting tool** (still on deck).

## CODEX MISSION QUEUE
empty

## COMPLETED

| # | Mission | Outcome | Debrief |
|---|---------|---------|---------|
| 002 | dedup-pass — perceptual-hash all 821 images, identify 76 duplicates (406 MB) | SHIPPED | [missions/002-dedup-pass-debrief.md](missions/002-dedup-pass-debrief.md) |
| 003 | cull-execute — quarantine 76 dupes into `_DUPLICATES_CULL` Drive folder | SHIPPED | [missions/003-cull-execute-debrief.md](missions/003-cull-execute-debrief.md) |
| 004 | cluster-by-exif — cluster source images by (suburb, date) using Drive's `imageMediaMetadata` + Nominatim. Built Batch Tag UI tab. 94 clusters / 605 files | SHIPPED | [missions/004-cluster-by-exif-debrief.md](missions/004-cluster-by-exif-debrief.md) |
| 005 | cluster-tag-all — bulk-move every clustered file into `{Suburb VIC}/{YYYY-MM-DD}/`. 605/605 moved, 2.0 GB, 0 errors. Drive verified | SHIPPED | [missions/005-cluster-tag-all-debrief.md](missions/005-cluster-tag-all-debrief.md) |
| 006 | clusters-to-excel — `clusters_for_vic.xlsx` punch-list, 94 clusters + 148 ungrouped tabs, hyperlinks + dropdowns, uploaded to source Drive folder | SHIPPED | [missions/006-clusters-to-excel-debrief.md](missions/006-clusters-to-excel-debrief.md) |

## PIPELINE
recon → dedup → cull → cluster → cluster-tag-all. Each stage reads prior stage's `data/*_report.json`. All stages idempotent + resumable.

## CARRIED FORWARD
- 148 ungrouped images + ~97 videos remain in source dump folder. Vic handles via per-file Tagger tab.
- HEIC re-pass for the 11 dedup-skipped files (sharp streaming can't seek HEIC). Separate mission, low priority.
- Operator to manually delete `_DUPLICATES_CULL` folder in Drive after spot-check.
