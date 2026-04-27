## MISSION: cull-execute — 2026-04-27

**Objective:** Execute Phase 2 cull — move 76 duplicate files (406 MB) flagged in dedup_report.json out of the source folder so the tagger only sees unique assets.

**Outcome:** Shipped

**What worked:**
- Move-based quarantine (re-parent into `_DUPLICATES_CULL` at Drive root) over hard-trash. Re-parenting only needs writer access; trashing requires ownership. The OAuth user is a writer on the source folder but not the file owner — so move succeeded where trash would not have.
- `cull_log.json` written after every file → fully resumable if interrupted.
- 120 ms rate limit kept well under Drive's 10 req/sec quota; zero throttling.
- 76/76 moved, 0 errors, 406 MB relocated in one pass.

**What broke:**
- OAuth refresh token from prior session was revoked → `invalid_grant`. Required operator to delete `data/token.json` and re-auth via `node server.js`.
- Tagger UI's `/api/dedup/trash-all` endpoint (separate from the script) was triggered post-re-auth and flooded the console with "insufficient permissions" errors — same root cause: trash requires ownership. Disabled both the UI button and the endpoint as part of this mission.

**Findings:**
- Drive API permission model: `addParents`/`removeParents` works for non-owners with writer role; `trashed: true` does not. For shared/dump folders where the OAuth user isn't the owner, move-to-quarantine is the only viable cull path via API.
- The 285 MB MP4 (`6B03ACF6-…-1.mp4`) was the single biggest reclaim — confirmed exact-size video duplicate detection paid off.

**Learnings:**
- Bake refresh-token failure recovery into any script that depends on `data/token.json`. Either prompt re-auth automatically or fail with a clear "run `node server.js` to re-auth" message instead of `[FATAL] invalid_grant`.
- For client/end-user distributions (Vic's tagger), redundant destructive paths in the UI are a liability. Removed `/api/dedup/trash-all` to prevent confused button-mashing.

**Open items:**
- Operator to spot-check `_DUPLICATES_CULL` in Drive UI, then manually delete the folder when satisfied (Drive Trash holds 30 days as final undo).
- HEIC re-pass for the 11 files skipped in Phase 1 (sharp streaming can't seek HEIC) — separate mission.
- End-user distribution polish (`runtime/` bundle, `START.bat`, README rewrite for Vic) committed alongside this mission but not yet field-tested on Vic's machine.
