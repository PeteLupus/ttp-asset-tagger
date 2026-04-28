## MISSION: cluster-tag-all — 2026-04-28

**Objective:** Bulk-move every clustered image into `TTP Organized Assets/{Suburb STATE}/{YYYY-MM-DD}/` in one shot. Skip the per-cluster UI step. Operator decision: location + date is enough metadata; job-type can be assigned later if ever needed.

**Outcome:** Shipped

**What worked:**
- One-shot script (`scripts/cluster-tag-all.js`) reading the existing `cluster_report.json`. Dry-run by default, `--confirm` to execute. Same shape as `cull.js`.
- Re-used the move-not-trash pattern: `addParents`/`removeParents` only — no ownership required, fully reversible.
- Wrote through to `data/progress.json` so the live tagger UI's per-file queue auto-excludes everything moved without restart.
- Resumable log (`data/cluster_tag_log.json`) appended after every move; script skips file IDs already logged as moved if re-run.
- Independent verification script confirmed: **94/94 clusters present in Drive, 605/605 files counted in correct folders, 0 mismatches.**

**Findings:**
- Final move stats: **605 files / 2.0 GB / 0 errors / ~6 min wall time** at 120 ms rate limit.
- 94 cluster folders created spanning Sep 2012 → Feb 2026.
- Source dump folder now down to ~245 unhandled assets (148 ungrouped images + ~97 videos) — Vic handles those via the existing per-file Tagger.

**What broke:**
- Nothing. Bash timeout at 10 min moved execution to background mid-run; script wrote progress to disk continuously so this was harmless. Used `pgrep` polling on the log file count to confirm completion (602 → 605).

**Learnings:**
- For long-running Drive batch jobs (>10 min), default to `run_in_background: true` from the start. Avoid the timeout-then-poll dance.
- The recon → dedup → cluster → cluster-tag-all chain is now a clean four-stage pipeline, each stage reading the prior stage's report. Keep this shape for any future bulk Drive operation.
- Operators (Vic) often want less granularity than the UI offers. Asking "do you actually need job-type?" before building cluster-by-cluster UI flow would have saved an iteration. Build the dumb thing first; add UI gating only if needed.

**Open items:**
- Vic field-test on the now-organised Drive structure.
- 148 ungrouped images + ~97 videos still in source dump folder — handle via per-file Tagger if/when needed.
- HEIC dedup re-pass for the 11 originally-skipped files — still pending, separate mission.
- **Next front: social posting tool.**

**Files added/modified:**
- `scripts/cluster-tag-all.js` (new)
- `.gitignore` — added `data/cluster_tag_log.json`
- `data/progress.json` — auto-populated with 605 entries (gitignored, not committed)

**Commit:** `a6b8ddf [build] cluster-tag-all script — bulk move clustered files into Drive folders`
