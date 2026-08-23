# II-R10 — Reports & Premium Packaging — Acceptance Report

**Verdict: FAIL** (honest, itemized — see below). This is not a rounded-up
CONDITIONAL PASS: per spec sections 190-191, financial-correctness/
provenance/entitlement/security/canonical-ownership scope can never be
CONDITIONAL, and the core mandatory scope (Investment Intelligence chapters
in the premium report, the 200-case certification pack, 50-report visual
certification, 30 manual reconciliations, 25 live-DEV cases, 8 negative
controls) was not attempted this session. What follows is a precise account
of what genuinely was delivered, verified, and disclosed as gaps.

## What was genuinely completed and verified this session

1. **Section 7 gate**: confirmed `origin/main` at `ddfc19e723cb6bb2472565607b001d7d12096d6d`
   (identical to the worktree's starting point), `git merge-base --is-ancestor ddfc19e origin/main` → true.
2. **Section 8**: ran both the local (`scripts/check-migration-versions.mjs`) and
   cross-branch (`scripts/check-migration-versions-against-branch.mjs`)
   migration guards against `origin/main` and the concurrent FDH-5 branch
   (`doclife/bank-pdf-statement-engine`, 67 files, missing `0067`/`0069` —
   evidently forked before R9 merged) — zero collisions, `0070` confirmed
   free at both allocation time and immediately before finalising this
   report.
3. **R10-P0 discovery** (`R10_REPORT_ARCHITECTURE_DISCOVERY.md`): full audit
   of the existing report stack (5,691 lines across engines/services/
   components, 12 API routes, real PDF pipeline) and REUSE/EXTEND/REPLACE
   classification per capability.
4. **Source-of-truth map** (`R10_REPORT_SOURCE_OF_TRUTH_MAP.md`): documents
   both what's already correctly wired (Dashboard, Health Score, Resilience,
   DNA, Goals, Forecast) and the concrete, code-verified read paths the next
   session needs for the II chapters that are NOT yet wired.
5. **A real, serious, pre-existing CRITICAL security defect found, reproduced live on real DEV, and fixed in code + migration**:
   the entire `reports` table family (`reports`, `report_sections`,
   `report_snapshots`, `report_exports`, `report_generation_runs`,
   `report_access_events`) allowed the owning user to forge report status,
   the report's own displayed financial numbers/narrative, fabricated
   provenance, forged "ready" PDF exports with arbitrary storage paths, and
   forged its own generation audit trail — all via direct REST calls with a
   real, valid session, no RLS violation. 5/5 attacks succeeded live against
   real DEV before the fix (disposable test user, cleaned up immediately).
   Fixed via `supabase/migrations/0070_ii_r10_reports_authoritative_write_hardening.sql`
   (SELECT-own-only RLS) plus an application-code refactor moving every
   legitimate write to the service-role admin client
   (`lib/services/reportsData.ts` and four API routes). PGlite-certified
   from a **clean 70/70 migration replay** (174 tables, 202 policies, 0
   RLS-disabled): 15/15 checks pass, including a negative control proving
   the suite can detect the exact regression it fixed. Full detail in
   `R10_REPORT_SECURITY_MODEL.md`.
6. **Live cross-user isolation check** (`scripts/r10_repro_cross_user.mjs`,
   real DEV, two disposable users, cleaned up after): 5/5 — a second real
   user cannot read another user's `reports`/`report_sections`/
   `report_exports` rows, list them by `report_id`, or obtain a signed
   storage URL for the victim's real object path. This was always
   correctly enforced (row-scoped by `user_id`) and is unaffected by the
   forgery fix — confirmed, not assumed.
7. **Regression checks**: `npx tsc --noEmit` clean (0 errors). `npx eslint`
   on every changed file: 0 errors (one harmless unused-var warning in a
   throwaway script, fixed). `npm run build` completed successfully,
   including every `/api/reports/**` and `/investment-intelligence/**`
   route. Full `npx vitest run --no-file-parallelism`: **1979 passed, 67
   skipped, 1 failed** across 109 files — the single failure
   (`resourcesAdminR1_2.test.ts`, a 5s timeout) plus 3 fully-failed suites
   (`resourcesEditorR1_3`, `resourcesR1_1`, `resourcesR1_4LiveDev`) are all
   pre-existing, unrelated to this session's changes: they hit real
   Supabase Auth OTP verification against live DEV and failed with
   `Request rate limit reached` — an environmental/rate-limit condition,
   not a code regression (none of the four touch `reports`, `report_*`, or
   any file this session modified). `tests/unit/reports.test.ts` (the
   existing report-engine unit suite): 12/12 pass, unaffected.

## What was NOT completed — disclosed honestly, not rounded up

- **Migration `0070` is not applied to live DEV.** This agent has
  `SUPABASE_SERVICE_ROLE_KEY` REST/data-plane access only — no `supabase db
  push`, no linked project, no DB connection string was available in this
  environment (verified: no `supabase/config.toml`, no
  `SUPABASE_ACCESS_TOKEN`, no `DATABASE_URL`). Per orchestration guidance,
  delivering the migration and stopping honestly here is correct — but per
  spec section 190(10)/191, security cannot be CONDITIONAL, so this alone
  is sufficient to make the overall verdict FAIL until the migration is
  applied and re-verified live (re-run
  `scripts/r10_repro_reports_forgery.mjs`, expect 0/5).
- **Zero Investment Intelligence chapters were implemented.** R4
  (Performance/Benchmark), R5 (SIP/X-Ray), R6 (Tax & Cost), and R9
  (Goals/Forecasting/Review Centre) integration into the premium report —
  the actual primary objective of R10 (spec sections 3-4, 19, 26-27,
  37-50, 93) — was not attempted this session. The concrete read paths were
  identified (`R10_REPORT_SOURCE_OF_TRUTH_MAP.md`) but no chapter code, no
  new `PremiumSourceData` fields, no new provenance rows, no storytelling
  rules for II content, and no compliance-taxonomy classification (spec
  section 31) were written.
- **Certification pack (spec sections 116-133): not built.** No
  `R10-TC001`-`R10-TC200` cases, no independent oracle
  (`scripts/r10_independent_report_oracle.*`), no 1,500+ atomic comparisons.
- **50-report visual certification (section 122): not run.** 0/50.
- **30 manual reconciliations (section 123): not run.** 0/30.
- **8 negative controls 126-133: only partially exercised.** The reports-RLS
  negative control (old-policy-shape reinstated → forgery succeeds again)
  was run and passed as part of the security certification above — that
  covers the spirit of negative control 6 (cross-user/RLS class) for the
  reports family specifically, but the other 7 named controls (net-worth
  duplication, local XIRR recomputation, stale forecast, narrative
  contradiction, premium gate, pagination, provenance swap) require the II
  chapters and certification pack to exist first, and were not run.
- **25 live-DEV cases LIVE-R10-001 through 025 (sections 134-159): not
  run**, beyond the two ad hoc live probes described above (forgery
  reproduction and cross-user isolation), which map loosely to
  LIVE-R10-021/022 in spirit but were not run as the spec's own formal
  25-case matrix.
- **15 independent live reconciliations (section 160): not run.**
- **>1,000-row pagination hard test (sections 104-107): not run** — no II
  chapter exists yet to depend on paginated data.
- **Documentation**: only 4 of the 20 named documents were produced this
  session (`R10_REPORT_ARCHITECTURE_DISCOVERY.md`,
  `R10_REPORT_SOURCE_OF_TRUTH_MAP.md`, `R10_REPORT_SECURITY_MODEL.md`, this
  file). `R10_REPORT_DATA_CONTRACT.md`, `R10_FREE_REPORT_SPEC.md`,
  `R10_PREMIUM_REPORT_SPEC.md`, `R10_STORYTELLING_RULES.md`,
  `R10_COMPLIANCE_AND_LANGUAGE.md`, `R10_REPORT_PROVENANCE.md`,
  `R10_REPORT_VERSIONING.md`, `R10_ENTITLEMENT_AND_PACKAGING.md`,
  `R10_PDF_RENDERING_ARCHITECTURE.md`, `R10_200_CASE_CERTIFICATION.md`,
  `R10_50_REPORT_VISUAL_CERTIFICATION.md`, `R10_MANUAL_RECONCILIATION.md`,
  `R10_LIVE_DEV_VERIFICATION.md`, `R10_SECURITY_VERIFICATION.md`,
  `R10_PAGINATION_CERTIFICATION.md`, `R10_TESTING_AND_VERIFICATION.md` were
  not produced — most of them describe scope (the II chapters, the
  certification pack) that does not yet exist to document.

## Why this session prioritised the security fix over starting the chapters

Once the RLS defect was found during discovery, building even one II
chapter on top of an actively-forgeable report data model would have meant
shipping new financial content into a system where a user could already
directly overwrite `section_data_json` and `report_snapshots` — i.e. the new
chapter's own provenance and displayed numbers would have been exactly as
forgeable as everything else, undermining the very guarantee sections 66-69
ask for. Fixing the foundation first, completely and verifiably (live
reproduction → migration → code refactor → PGlite certification →
regression-tested), was judged the higher-value, lower-risk use of a
single session than a partial, untested first chapter that risks tripping
one of section 190's non-conditional FAIL conditions (double counting,
wrong numbers, broken provenance) — which is explicitly worse than not
shipping the chapter at all.

## Files changed this session

- `supabase/migrations/0070_ii_r10_reports_authoritative_write_hardening.sql` (new)
- `lib/services/reportsData.ts` (write paths → admin client)
- `app/api/reports/[id]/exports/route.ts`
- `app/api/reports/[id]/retry/route.ts`
- `app/api/report-exports/[exportId]/download/route.ts`
- `app/api/report-exports/[exportId]/route.ts`
- `scripts/r10_repro_reports_forgery.mjs` (new — live-DEV reproduction, disposable/self-cleaning)
- `scripts/r10_repro_cross_user.mjs` (new — live-DEV cross-user check, disposable/self-cleaning)
- `scripts/r10_reports_rls_certification.mjs` (new — PGlite certification, 15/15)
- `scripts/r10-repro-reports-forgery-results.json` (new — raw pre-fix live results)
- `docs/investment-intelligence/R10_REPORT_ARCHITECTURE_DISCOVERY.md` (new)
- `docs/investment-intelligence/R10_REPORT_SOURCE_OF_TRUTH_MAP.md` (new)
- `docs/investment-intelligence/R10_REPORT_SECURITY_MODEL.md` (new)
- `docs/investment-intelligence/R10_ACCEPTANCE_REPORT.md` (new, this file)

## DEV cleanup

Every disposable test user created this session (3 total: one for the
5-attack forgery reproduction, one for the isolated status-only variant,
two for the cross-user check — 4 total, all via `admin.auth.admin.createUser`)
was deleted via `admin.auth.admin.deleteUser()` in each script's `finally`
block, cascading all rows they owned. No pre-existing DEV data was touched.
Verified: each script logged "cleaned up" and none reported a deletion
failure.
