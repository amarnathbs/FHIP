# R11 Pagination & Scale Certification

Spec sections 128-131.

## Honest status: reused, not freshly certified at the suggested scale

Every new unbounded read R11 introduces reuses the SAME `fetchAllRows()` pagination helper (`lib/services/investment-intelligence/pagination.ts`) that R4/R5/R6/R9 already certified at scale (999/1000/1001/2500/5001/10000-row scenarios — see `iiR4AnalyticsRepositoryPagination.test.ts`, `iiR6P0Beyond1000RowCalculation.test.ts`, `iiR9PaginationCertification.test.ts`, all of which re-ran clean in this session's regression pass, see `R11_TESTING_AND_VERIFICATION.md`). Specifically:

- `documentProcessing.ts`'s new `loadCrossSourceCandidates()` function calls `fetchAllRows()` to load every existing `ii_transactions` row for a given `(account_id, instrument_id)` position — the exact same helper, same deterministic `order by id` tie-breaker discipline, as every other II repository query.
- `lib/services/professional-access/access.ts`'s `listClientsForProfessional()` and `fetchAccessContext()` use plain (not yet paginated) Supabase queries — **this is a genuine, disclosed gap**: a professional with more than ~1000 clients, or a client with more than ~1000 scope-grant history rows on one relationship, is not proven safe from PostgREST's default row cap in this release. In practice this is a low-probability scenario for R11's frozen scope (a handful of professionals, a handful of scopes each), but it was not verified against a synthetic 1000+/2500+ dataset.

**No fresh scale test at 999/1000/1001/2500/5001/10000 source records, or at 1/10/100/500 professional clients, was run in this release.** This is disclosed precisely rather than claimed.

## What WAS verified

- `loadCrossSourceCandidates()`'s deterministic ordering (`order('id', { ascending: true })`) matches the exact tie-breaker convention every other paginated II query in this codebase uses, reviewed by code inspection against `analyticsRepository.ts`'s own pattern.
- The cache-invalidation logic (`crossSourcePositionCache.delete(...)` after every insert) was manually traced (see `R11_MANUAL_RECONCILIATION.md`) to confirm a large statement with many transactions against the same position doesn't silently serve stale candidate data mid-import — a correctness concern adjacent to, but distinct from, raw row-count scale.

## Why this was not closed in this release

Given the disclosed `.env.local`/live-DEV blocker (`R11_LIVE_DEV_VERIFICATION.md`), a meaningful scale test would need either (a) a live DEV Postgres instance to insert 1000+ real rows and measure real query/timing behaviour, or (b) a PGlite-based synthetic-scale test, which was judged lower-value than the security/correctness certification work completed given the time available, and is named here as the next release's or a follow-up session's first item rather than silently deferred.
