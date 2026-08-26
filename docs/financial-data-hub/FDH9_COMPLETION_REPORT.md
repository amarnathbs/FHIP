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
2. **Migration numbering re-verified fresh** against the moved landscape
   (`origin/main` now at `285c9c0`, plus every active worktree under
   `D:/FHIP/.claude/worktrees/`): `0091` is used only by this branch;
   `0092`/`0094` belong to II-R12 (already on `origin/main`); `0093` belongs
   to the not-yet-merged `feature/education-goal-linkage` branch (recorded
   as a discrepancy — the dispatch briefing stated `0092/0093/0094` were "all
   now on origin/main"; `0093` was not actually found there — see the final
   report). No collision, no renumbering needed. Both migration guards
   (`check-migration-versions.mjs`, `check-migration-versions-against-
   branch.mjs`) PASS, the latter run against `origin/main`,
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
7. **All previously-certified work re-run and reconfirmed unchanged**:
   PGlite 76/76, extraction 278/278, isolation test suite (with 2 new
   precedented allowlist entries), full Vitest suite (2851 passed / 3 failed
   — all 3 pre-existing live-network flakes unrelated to this pass, see
   the final report's Repository Gates section), `tsc --noEmit` exit 0,
   ESLint on touched files 0 problems / full-repo baseline unchanged,
   production build (see final report for result).

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
