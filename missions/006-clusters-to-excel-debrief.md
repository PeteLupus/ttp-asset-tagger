## MISSION: clusters-to-excel — 2026-04-28

**Objective:** Hand Vic a working Excel punch-list of all 94 clusters with clickable Drive links, plus a second sheet for the 148 ungrouped files. Goal is to remove the friction of using the web tagger UI — Vic lives in Excel.

**Outcome:** Shipped, awaiting Vic's feedback.

**What worked:**
- Pure read of existing reports (`cluster_report.json` + `progress.json`) → no new data pipeline. Folder IDs already on every tagged file via `progress.tagged[id].destFolderId` from cluster-tag-all.
- `exceljs` for the .xlsx build: native HYPERLINK objects, frozen header, autofilter, data validation drop-downs in two cells (Job Type from `config.jobTypes`, Status). ~150 KB lib, MIT, zero deps.
- Drive upload uses replace-in-place (`files.update` if a prior file with same name exists, else `files.create`) — re-running the script doesn't proliferate copies.
- Same standalone-script shape as `cull.js` / `cluster-tag-all.js` — auth helper, `data/` outputs, no UI surface.

**Findings:**
- 94 clusters + 148 ungrouped, exactly matches cluster_report. Top cluster (Kew 2017-11-02, 71 files) lands at row 2 because sheet sorted by `fileCount` desc.
- Drive uploaded to the source dump folder so Vic finds it next to the photos he already knows. URL: https://drive.google.com/file/d/1fjn2BNeB0jkNHXCNcvQYIsFTGyYP6v0J/view

**What broke:**
- Nothing. Single clean run.

**Learnings:**
- For Excel handoff, hyperlinks beat embedded thumbnails: zero download time, no auth issues, one consistent rendering across Excel/Numbers/Sheets. Consider this the default for any future operator-facing exports.
- Drive's `imageMediaMetadata` discovery (Mission 004) keeps paying off: every downstream tool can rely on the cluster report being authoritative. No need to re-touch raw files.

**Open items:**
- **Vic feedback loop** — wait for him to use the sheet, see what's missing.
- If Vic wants edits in the sheet to flow back into the tagger / Drive structure, build a one-way **import** script (read filled Status/Job Type cols, apply moves). Out of scope for v1.
- Social posting tool — still the next front.
- HEIC dedup re-pass — still pending, low priority.

**Files added/modified:**
- `scripts/export-vic-sheet.js` (new)
- `package.json` — added `exceljs`
- `.gitignore` — added `data/clusters_for_vic.xlsx`

**Commit:** `f7cc913 [build] export-vic-sheet — Excel punch-list for Vic`
