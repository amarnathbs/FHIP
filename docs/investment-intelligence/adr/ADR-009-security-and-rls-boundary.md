# ADR-009: Security and RLS Boundary

## Status
Accepted (R0)

## Context
No investment data should rely merely on client-side filtering (spec Section 16), and R0 must determine how existing household/member access currently works before designing the R1 requirement. Discovery found a uniform, consistently-applied owner-only RLS pattern across every existing table, but also found that FHIP has **no real multi-person household access model today** — `household_members` is reference data within one owning user's RLS boundary, not a second authenticated party (`R0_CURRENT_STATE_DISCOVERY.md` section 10).

## Decision
Every `ii_*` user-owned table uses the identical owner-only RLS policy already proven across the entire platform (`auth.uid() = user_id`) — no new policy idiom is introduced. Because no genuine household-level access model exists platform-wide, Investment Intelligence's R1 design does not attempt to build one on its own; "household" remains a reference/tagging concept via `household_members`, exactly as it already is in Goals. Admin access reuses the existing `admin_users`/`requireAdmin()` pattern verbatim. Adviser/professional access is explicitly deferred (not built in R0/R1). Full detail: `R0_SECURITY_RLS_ARCHITECTURE.md`.

## Alternatives considered
1. **Design and build a genuine multi-person household RLS model as part of Investment Intelligence, since it's the module that most needs "family member" access per the spec** — rejected: this is a platform-wide gap (Goals has the identical limitation today), and solving it unilaterally inside Investment Intelligence would create an inconsistent, one-module-only access model that the rest of FHIP doesn't share — a worse outcome than accurately documenting the gap and deferring the platform-wide fix to whenever it's prioritized holistically.
2. **Simulate household sharing by loosening RLS to `household_id`-scoped access using the existing `households` table** — rejected: `households.user_id` is itself single-owner (`R0_CURRENT_STATE_DISCOVERY.md` section 10) with no member-invitation/second-login mechanism; loosening RLS to household scope without a real second authenticated principal would not actually enable "spouse logs in and sees this" — it would just be a false sense of security scoping around a boundary that still resolves to one user.
3. **Client-side filtering for anything not yet covered by RLS (e.g. professional access), to move faster** — rejected outright per explicit spec instruction ("No investment data should rely merely on client-side filtering").

## Consequences
- Positive: Investment Intelligence's RLS model is exactly as strong as, and no more fragile than, every other FHIP module's — reviewers already know how to audit this pattern.
- Positive: honestly surfaces a platform-wide gap (no real household access model) rather than papering over it with a module-local workaround that would need to be redone later anyway.
- Negative: the spec's "family-member access" requirement is **not achievable** within Investment Intelligence R1 alone — flagged explicitly in `R0_ACCEPTANCE_REPORT.md` as an outstanding, platform-level prerequisite, not an Investment-Intelligence defect.

## Migration implications
None for R0. R1's actual RLS policies (once `ii_*` tables are migrated) must be reviewed against this ADR before merge — every policy should be the same `auth.uid() = user_id` shape unless a specific, documented exception applies (reference tables: world-read/admin-write).

## Testing implications
R1 must include an actual RLS security test (attempting cross-user access to another user's `ii_*` rows via the anon/authenticated client and confirming it is rejected) — this is listed as a required R1 test category in `R1_IMPLEMENTATION_SPEC.md`, not satisfied by R0's design-only verification.
