# NAV 1 — Stage E Full Cleanup & VACUUM FULL — Final Certification

**Date:** 2026-09-30
**Supersedes:** `NAV1_Production_Final_Certification_2026-09-27.md` for everything Stage E–related. That report's STOP GATE 1 (canary-only authorization) is now superseded by an explicit, separate authorization to run the full remaining candidate set, given 2026-09-30, after the canary (documented in that same report) completed and was independently verified.

---

## 1. What this closes

The brute-force full-universe NAV backfill left `ii_prices_nav` holding price history for essentially the entire ~14,358-scheme AMFI catalogue, when only a small number of instruments are genuinely user-held. This report certifies the complete removal of that orphaned residue and the physical reclamation of its storage.

## 2. Scope executed

- **Stage E canary** (9,275 rows / 5 instruments): completed and verified 2026-09-29, documented separately. Held rows unaffected throughout.
- **Stage E full cleanup** (remaining candidate set, ~22.3M rows): authorized 2026-09-30 ("yes, proceed with the full remaining candidate set"), executed as a resumable, checkpointed script run directly by the Product Owner (never executed by the assistant, per this session's standing rule for all production-mutating operations). One real issue was hit and fixed mid-run: a statement timeout on a single dense/wide-date-range instrument, root-caused to the script's 50,000-row chunk ceiling being too large for that instrument, and resolved with an adaptive halve-and-retry pattern (down to a 200-row floor) already proven elsewhere in this codebase.
- **`VACUUM FULL ii_prices_nav`**: authorized and run directly by the Product Owner via the Supabase SQL Editor, 2026-09-30, immediately after a hydration tick completed (avoiding lock contention with the scheduled job).

## 3. Logical row-count reconciliation

| Metric | Before cleanup | After cleanup + VACUUM FULL |
|---|---|---|
| `ii_prices_nav` total rows | 22,460,985 | **152,079** |
| Rows deleted (this cleanup pass) | — | **22,302,553** |
| Instruments skipped during cleanup (protected-but-flagged mid-run) | — | **0** |
| Held instruments (`pc6_user_held_instrument_ids()`) | 17 (original baseline) | **19** (real user activity in the interim — expected drift, not a defect) |
| Rows belonging to held instruments | 85,485 (baseline, mid-cleanup check) | **85,485** (exact match, re-verified independently after full cleanup AND after `VACUUM FULL`) |

The held-row count is unchanged to the row across the entire cleanup and the subsequent vacuum — this is the single most important correctness signal for this operation: zero held rows were lost, at any point, despite ~22.3M rows being deleted around them.

## 4. Physical storage reclamation

`VACUUM FULL` was the step that actually shrinks the on-disk file (a plain `DELETE` only marks space reusable for future inserts — it does not return space to the OS). Per the Supabase project dashboard, immediately before and after:

| | Before `VACUUM FULL` | After `VACUUM FULL` |
|---|---|---|
| Database size | ~14.2 GB | **~6.8 GB** |

The project's own Disk Usage graph shows this as a sharp, single-point drop at the exact time the vacuum completed, corroborating the dashboard figure independently rather than relying on the summary number alone.

## 5. Operational health, before and after

Checked via `scripts/nav1_scheduled_proof_check.mjs hydration` (read-only, GET-only against production), run once before `VACUUM FULL` and once immediately after:

| Check | Before | After |
|---|---|---|
| Hydration batches since 2026-09-30T00:00Z | 26, all on-tick | 26, all on-tick (same set — no new tick had fired yet in the gap) |
| Missed ticks | 0 | 0 |
| Overlapping/stale runs | 0 | 0 |
| Held funds examined per batch | 19/19 every run | 19/19 every run |
| Consecutive failures | 0 | 0 |
| Last clean success | 2026-09-30T12:30:01Z | 2026-09-30T12:30:01Z (unchanged — confirms the vacuum introduced no gap) |

No disruption to the scheduled hydration job was observed at any point.

## 6. What remains open

- The next several scheduled hydration ticks after this certification should be watched once for a fresh post-vacuum data point (this report's own check ran in the same gap as the last known-good tick, so it confirms *no damage*, not yet *a new success after the vacuum* — that will appear automatically on the next `:00`/`:30` tick and can be spot-checked with the same script).
- The one previously-disclosed permanent gap remains unchanged and out of scope for this pass: the HSBC Short Term Fund (AMFI 151069) 2,274-row pre-2022-09-20 coverage gap, protected from any deletion throughout by migration 0219's `ii_nav_source_coverage_gaps`.

## 7. Verdict

**Stage E (full historical NAV cleanup) and the physical storage reclamation via `VACUUM FULL`: CLOSED.** Logical correctness independently re-verified at three checkpoints (mid-cleanup, post-cleanup, post-vacuum) with an exact, unchanged held-row count throughout. Physical storage genuinely reclaimed (~14.2 GB → ~6.8 GB, corroborated by the dashboard's own usage graph). Operational health (hydration) independently confirmed undisturbed before and after.
