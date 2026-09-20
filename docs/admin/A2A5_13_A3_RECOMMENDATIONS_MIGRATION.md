# A3.2 — Recommendations Migration

**Status: DONE** (see `A2A5_11` §3/§4 for the register row detail).

## Scope confirmed migrated

- Recommendation definitions, conditions, imports, atomic updates, ordering: `api/admin/recommendations`, `recommendations/[id]`, `recommendations/upload` (4 files) — reachable under the canonical Recommendations top-level area (`lib/admin/adminAreas.ts`), unchanged URLs.
- Authorization: gated by `requireRecommendationsAdmin()` (this dispatch's A3.3 capability split, commit `1e38609`) — behaviourally identical to the prior broad `requireAdmin()`, verified by direct source comparison (`A2A5_07` §8) and unit tests (`tests/unit/adminCapabilitySplit.test.ts`).
- Audit: `admin_upsert_recommendation_atomic`/`admin_import_recommendation_conditions`'s existing atomic-audit RPCs are unchanged (zero diff to any RPC/migration file).

## The Recommendations Gap route remains withdrawn (mission's explicit requirement)

`api/admin/recommendations/gaps` remains a permanent 503-returning stub, per `A1_08` §2's PO-9 privacy-unsafe-route carve-out (immediate fail-closed withdrawal, no monitor-and-authorize cycle required for this specific case, already ruled on before this dispatch). **Confirmed not reintroduced anywhere**: no route, Home queue item, Analytics destination, or export in this dispatch's changes references gap-review data. Direct grep for any new reference to the withdrawn feature across this dispatch's diff returns nothing.

## Scheduling (not part of this migration)

Recommendations scheduling, if it existed, would fall under the separate Scheduling area (`ADM-10`, `A3-WP` rows 06/14/22/30/38/46/54 in `A2A5_11`) — **NOT STARTED**, not part of this domain's DONE status, and not conflated with it here.

## Still blocked

Same as `A2A5_12` — live-DEV proof of the migrated shell for a real session is part of the BLOCKED `A2A5_09` live-role matrix.
