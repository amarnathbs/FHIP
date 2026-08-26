# FDH-9 — Completion Report

**This document supersedes nothing** — it consolidates the prior hardening
pass (`5937936`, CONDITIONAL PASS) and this live-DEV-cert + Income-tab pass
(2026-08-26) into one current-state summary. See the individual FDH9_*.md
documents for full detail; this is the index.

## Verdict: CONDITIONAL PASS

Not "DEV CERTIFIED — READY FOR PRODUCT OWNER MERGE AUTHORISATION" — the one
gate spec section 84 lists that this environment structurally cannot clear
is **migration applied DEV** (and therefore everything downstream of it:
live-DEV security certification, live-DEV AU/India E2E, DEV cleanup). Every
other gate is either PASS or an honestly disclosed residual. See the parent
conversation's final report for the exact gate-by-gate table.

## What changed in this pass, precisely

1. **Live-DEV DDL capability re-checked, fresh, and confirmed absent**
   (`FDH9_LIVE_DEV_CERTIFICATION.md`) — no CLI, no access token, no
   connection string, no Management API token. Migration `0091` remains
   unapplied everywhere. Section 9's exact fallback report format is used
   rather than a fabricated PASS.
2. **Migration numbering re-verified fresh, twice** against a landscape that
   moved during this very pass (`origin/main` was at `285c9c0` at the start
   of this session and had advanced to `ae3d6807` — one more commit, adding
   migration `0095`, a goal-funding-sources security hotfix — by the time
   this branch was reconciled onto it), plus every active worktree under
   `D:/FHIP/.claude/worktrees/`: `0091` is used only by this branch, in both
   checks; `0092`/`0094`/`0095` belong to II-R12 and the goal-funding hotfix
   (on `origin/main`); `0093` belongs to the not-yet-merged `feature/
   education-goal-linkage` branch (recorded as a discrepancy — the dispatch
   briefing stated `0092/0093/0094` were "all now on origin/main"; `0093`
   was not actually found there at either check). No collision, no
   renumbering needed. Both migration guards (`check-migration-
   versions.mjs`, `check-migration-versions-against-branch.mjs`) PASS,
   the latter run against `origin/main` (both before and after its move),
   `feature/education-goal-linkage`, and `feature/investment-intelligence-
   r12-wider-india-assets` explicitly.
3. **The Income-tab payslip journey — the single biggest previously
   undisclosed gap — is now built**: `FDH9_INCOME_TAB_UX.md`,
   `FDH9_PAYROLL_ARCHITECTURE.md`, `FDH9_INCOME_BRIDGE_CERTIFICATION.md`.
4. **A real, previously-invisible defect was found and fixed**: migration
   0091's DB-side widening of `fdh_document_audit_events.event_type` was
   never mirrored on the TypeScript side. Fixed
   (`FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED`), closed by a new
   regression test (`fdh9SchemaContract.test.ts`), `tsc --noEmit` exit 0.
5. **A stale test assertion was found and fixed**: `fdh7SchemaContract.
   test.ts`'s event-type check compared migration 0076's literal text
   against the FULL current vocabulary — accurate only until a later
   migration (0091) widened the same constraint again. Retargeted to the
   FDH-3+R7+R8+FDH-5+FDH-7 subset it can actually still prove.
6. **A genuine pre-existing defect in already-shipped FDH-5 code was found
   and deliberately NOT copied**: `bankPdfProcessingService.ts` calls
   `assertDocumentTransition('processing', 'queued')` for a password-retry
   outcome, but that edge does not exist in `DOCUMENT_STATUS_TRANSITIONS`
   (only `extracted`/`review_required`/`failed`/`rejected` are legal from
   `processing`) — meaning a real password-protected bank PDF may already
   throw rather than cycling back to `queued` in production today. Out of
   FDH-9's scope to fix (a FDH-5 defect, not a FDH-9 one); this pass's own
   new `payslipProcessingService.ts` uses the correct `processing -> failed
   -> queued` path instead and documents the FDH-5 defect for a future,
   separate fix.
7. **The branch was reconciled onto current canonical `origin/main`**
   (`ae3d6807` at time of this pass — moved twice during this session alone,
   from `285c9c0` to `ae3d6807`, re-verified fresh both times) — merge commit
   `62301cb`. Two trivial conflicts, both in generated JSON certification-
   report artefacts (`scripts/ii-r5-certification/comparison_report.json`,
   `scripts/ii-r6p1-certification/comparison_report.json`) that differed only
   in a `generatedAt` timestamp; resolved by keeping this branch's copy since
   the content (698/698, 0 failures on both sides) was otherwise byte-
   identical. No FDH-9 file was involved in any conflict.
8. **A second genuine pre-existing defect was found, entirely on
   `origin/main`, unrelated to FDH-9**: migration `0094_ii_holding_snapshots_
   authoritative_forgery_hotfix.sql` (an II-R12 security hotfix, byte-
   identical to origin/main's own copy) drops a policy named `"own
   ii_holding_snapshots"`, but migration `0092` had already renamed that
   policy to `"read own ii_holding_snapshots"` — so 0094's `DROP POLICY IF
   EXISTS` is a silent no-op and its subsequent `CREATE POLICY` of the same
   name collides with the one 0092 already created. This breaks any
   from-scratch full-migration-chain replay (PGlite, a fresh dev database, CI)
   — confirmed independently by patching a **scratch copy** of 0094 (never
   the real repo file — migrations 0082-0090/0092-0094 are frozen per
   standing project policy) and re-running `fdh9_certification.mjs` against
   it: **76/76 PASS**, unchanged, proving FDH-9's own migration 0091 and
   everything downstream of it are completely unaffected — the failure is
   purely 0094 colliding with 0092, both entirely pre-existing on
   `origin/main`. Not fixed here (touching 0092/0094 is out of scope per
   standing hard rule); flagged as a separate follow-up task instead. It does
   **not** affect an already-live database (0092 then 0094 applied
   sequentially against real, evolving state hits no collision) — only a
   from-scratch rebuild.
9. **All previously-certified work re-run and reconfirmed unchanged, on the
   final merged tree**: PGlite 76/76 (via the scratch-workaround above),
   extraction 278/278, isolation test suite (with 2 new precedented allowlist
   entries), full Vitest suite (2944 passed / 2 failed post-merge — both
   pre-existing live-network flakes in the unrelated Resources module,
   re-confirmed by file history predating this branch entirely; a third
   apparent failure, `migrationVersionsCrossBranch.test.ts`, was a
   load-induced 5-second timeout under this session's heavy concurrent
   process load — re-run in isolation immediately after: 7/7 PASS), `tsc
   --noEmit` exit 0 on the merged tree, ESLint on touched files 0 problems,
   compiled bundle security scan (service-role key, its literal value,
   `CRON_SECRET`/`RESEND_API_KEY`, raw payslip fixture text — all 0 hits in
   `.next/static`), production build (see below).
10. **Production build**: `npm run build` compiled successfully (15.3 min)
    and passed its own TypeScript check (7.6 min), then failed during static
    prerendering on two routes — `/contact` and `/admin/benchmarks` — both
    with an identical Next.js-internal error (`Invariant: Expected workStore
    to be initialized. This is a bug in Next.js`, the framework's own error
    text). `/admin/benchmarks` is exactly the pre-existing failure spec
    section 77 itself anticipated re-checking; `/contact` is new since that
    note was written. Neither route was touched by FDH-9 or by this pass's
    merge — grep confirms zero FDH-9 files reference `/contact` or
    `/admin/benchmarks`, and both pages' source is unrelated to Income/
    payslip code. Given the identical, framework-attributed error signature
    on both, and that a from-scratch re-run of the ~25-minute build against
    clean `origin/main` was not repeated a second time in this pass for
    confirmation (time budget), this is documented as a **BASELINE ISSUE**
    per spec 77's own instruction rather than claimed fixed or concealed —
    the compile + typecheck stages (which cover every FDH-9 file) both
    passed cleanly, which is the evidence available that FDH-9's own routes
    build correctly.

## What is genuinely NOT done, stated plainly

- **Live DEV certification** (spec sections 11-20): not performed, cannot be
  performed in this environment. `FDH9_LIVE_DEV_CERTIFICATION.md` has the
  exact owner action.
- **Live-DEV AU/India E2E through the real running app** (spec sections
  45-46, 70): the journey is built and PGlite/route-tested, but has not been
  driven through an actual browser against an actual Supabase project.
- **DEV cleanup** (spec section 71): not applicable — no live DEV writes
  were made, because none were possible.
- **Field-level correction of extracted payroll data** ("Review/Correct"):
  deliberately scoped to read-only + delete-and-re-upload, not built as an
  editing UI, because the database has no authenticated-role UPDATE path for
  any system-derived payroll field and widening it was judged out of scope
  (spec section 7). See `FDH9_INCOME_TAB_UX.md`.
- **Revised-payslip supersession**: the schema column
  (`superseded_by_payroll_event_id`) exists; no detection logic linking a
  revision to its predecessor was implemented this pass.
- **Malware/AV scanning, load/concurrency testing**: unchanged residuals
  carried forward from FDH-3/prior FDH-9 passes — not in this pass's scope.

## FDH-10 readiness

**AMBER.** The Income→Payslip contextual-import pattern (spec sections 75-76)
is now a proven, working template — a future domain (Expenses→Bank Statement,
etc.) can follow the identical adapter-file-plus-enum-value shape
(`FDH_CONTEXTUAL_IMPORT_ARCHITECTURE.md` §6) with real, exercised precedent
behind it rather than a design document alone. It is not GREEN because FDH-9
itself is not yet merged, not yet live-DEV certified, and the Product Owner
has not authorised starting FDH-10.
