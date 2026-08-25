# R11 Pagination & Scale Certification

Spec sections 128-131.

## R11-FINAL closure round update (2026-08-25): live >1000 proof delivered, full 999/1000/1001/2500/5001/10000 matrix still not run

**LIVE-R11-025 (>1000 live case) executed for real against DEV**: 1005 real `ii_transactions` rows bulk-inserted for one `(account_id, instrument_id)` position, using deterministic ids chosen so the ONE row that must actually match a new incoming candidate transaction sorts strictly last (row 1005) in `loadCrossSourceCandidates()`'s own `order('id', {ascending:true})` — i.e. past PostgREST's silent 1000-row page-1 cap. Result: `preCount=1005`, `postCount=1005` (had pagination silently truncated at 1000, the candidate at row 1005 would have been invisible and the real transaction would have wrongly inserted as a duplicate, making `postCount=1006`) — confirms `fetchAllRows()` genuinely retrieves past the boundary in a real live query, not just in a unit test against a mocked query builder. See `R11_LIVE_DEV_VERIFICATION.md`.

**Still not run this round**: the full suggested 999/1000/1001/2500/5001/10000 distribution across every R11 surface (source evidence, reconciliation candidates, source-to-canonical links, professional relationships, professional client list, consent/audit history) — one real live data point at ~1005 rows was delivered as the highest-value single proof achievable in the time available, not the complete matrix. This is disclosed precisely, not rounded up to "scale-certified."

## A real, previously-undetected pagination gap found and fixed this round

`lib/services/professional-access/access.ts`'s `listClientsForProfessional()` and the scope-grant read inside `fetchAccessContext()` used bare, unbounded `.select()` calls — not yet paginated, despite spec sections 47-49 explicitly naming "professional client list" and "consent... history" as R11 scale-certification surfaces. Fixed this round: both now use `fetchAllRows()` with a genuinely unique `order('id', {ascending:true})` tie-breaker, matching the exact convention `documentProcessing.ts`'s `loadCrossSourceCandidates()` and every other II repository query already uses. **Not live-testable this round** — migration `0083` (the tables these functions read) is not yet applied to DEV (see `R11_LIVE_DEV_VERIFICATION.md`) — but the fix itself is real, `tsc`-clean, and regression-safe (2509/2509 non-skipped tests unaffected).

## What WAS verified (preserved from the prior round, still accurate)

- `loadCrossSourceCandidates()`'s deterministic ordering (`order('id', { ascending: true })`) matches the exact tie-breaker convention every other paginated II query in this codebase uses, reviewed by code inspection against `analyticsRepository.ts`'s own pattern, and now proven live (see LIVE-R11-025 above).
- The cache-invalidation logic (`crossSourcePositionCache.delete(...)` after every insert) was manually traced (see `R11_MANUAL_RECONCILIATION.md`) to confirm a large statement with many transactions against the same position doesn't silently serve stale candidate data mid-import — a correctness concern adjacent to, but distinct from, raw row-count scale.

## Why the full matrix was still not closed this round

Time available this round was prioritised toward: (1) getting ANY genuine live-DEV proof running at all (the prior round's blocker was total — 0/25), (2) the 8 remaining manual reconciliation cases, and (3) chasing down and fixing the 3 real defects the live testing surfaced. A full 999/1000/1001/2500/5001/10000 sweep across every named surface — several of which (professional relationships, client list, consent/audit history) cannot be meaningfully live-tested until migration `0083` is applied anyway — is named here as the next session's first item once `0083`/`0086` are live, rather than silently deferred.
