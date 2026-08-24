# FDH-8 — Live DEV Certification

## Honest ceiling for this session

This worktree (`D:\FHIP\.claude\worktrees\agent-a44f9e6f3dcfdbe12`) has **no DEV Supabase credentials** — `.env.local` does not exist, only `.env.example` is present, and no `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are set in the shell environment. This is the same gap `scripts/fdh7_certification.mjs` disclosed for FDH-7 ("no live DEV DDL credential exists in this environment"). Per the standing orchestration constraints for this task, production access is explicitly out of scope; DEV access, while normally in scope for this program, was simply not provisioned into this particular worktree.

**What this means concretely:** the spec-116-129 checklist below (Tenant A/B live browser flows, real synthetic CSV→FDH-8 pipeline walk, live cross-format UX equivalence, live transfer/split/refund/pending cases, DEV cleanup) could not be executed against an actual hosted Supabase project in this session. It was NOT skipped by omission — it was structurally unreachable, and is reported as such rather than rounded up to "PASS".

## What substitutes for it, and how far that substitute actually reaches

`scripts/fdh8_certification.mjs` runs the same class of check — real Postgres (PGlite), every migration replayed, real RLS enforcement via `set role authenticated` + JWT claims, real forged-filter and dropped-predicate negative controls — against an in-process database rather than a hosted one. This genuinely proves the SQL/RLS/aggregation layer is correct; it does NOT prove:

- The actual deployed Next.js server, real cookies/session handling, and real network round-trips behave the same way (no live HTTP request was made against any `/api/financial-data-hub/activity/*` route in this session).
- A real synthetic CSV or PDF statement was uploaded, processed through FDH-3→FDH-4/FDH-5→FDH-6→FDH-7 approval, and then rendered correctly in an FDH-8 page — this end-to-end walk requires a running application against a real database and was not performed.
- DEV cleanup / zero-orphan-fixture verification — not applicable, since no DEV fixtures were created.

## Checklist status (spec 116-129)

| Item | Status |
|---|---|
| Tenant B cannot access Tenant A overview/transactions/category/merchant/account/recurring/review/search/approved-summary | Certified at the DB/RLS layer (PGlite) — **not** certified against a live hosted project. |
| Forged filter/account/statement/merchant/transaction id returns no unauthorized data | Certified at the DB/RLS layer for the account_id case (`scripts/fdh8_certification.mjs` SECTION 2) — **not** exercised through the real HTTP API surface. |
| `.next/static` scan for service-role key / admin-client bundling | Not run in this session (requires a completed production build pass — see completion report Regression section for whether the build itself succeeded). |
| Synthetic CSV → FDH-8 overview live walk | **Not run** — no DEV credentials. |
| Synthetic PDF → FDH-8 walk, cross-format UX equivalence | **Not run** — no DEV credentials. |
| Live transfer/split/refund/pending/multi-account cases | Certified at the pure-oracle-function and PGlite-DB level (see `FDH8_FINANCIAL_INTEGRITY_CERTIFICATION.md`) — **not** certified against live application + live DEV data. |
| DEV cleanup / zero orphan fixtures | Not applicable — no DEV fixtures created. |

## Verdict for this section

**NOT ATTAINED — structurally blocked by missing DEV credentials in this environment, not by a discovered defect.** This is disclosed precisely so a human with DEV access can run the equivalent live walk before treating FDH-8 as terminally closed, exactly as the spec's own "your realistic ceiling this session is CONDITIONAL PASS" framing anticipates.
