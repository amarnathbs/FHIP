# FDH-14 — Scope & Certification Plan

## 1. Mission

FDH-14 certifies the **Financial Data Hub data plane** — FDH-0 through FDH-12 plus R7/R8 — as one coherent
standalone financial-ingestion and evidence-processing platform. It is a certification phase, not a feature
phase. FDH-13 (Admin governance) is explicitly out of scope and owned by the Admin Redesign workstream.

## 2. In scope

Document ingestion, secure document lifecycle, statement extraction, CSV/PDF parsing, normalisation, financial
classification, transfer intelligence, duplicate intelligence, recurring-pattern intelligence, reconciliation,
review, approval, structured evidence, canonical import proposals, safe Apply boundaries, economic-event
integrity, cross-module deduplication, tenant security, privacy, scale, failure handling, jurisdiction
behaviour, migration integrity.

## 3. Explicitly out of scope

Admin governance/UI, merchant-candidate Admin review, parser-management Admin UI, support-access Admin UX,
Admin analytics dashboards, Admin role redesign (all → FDH-13/Admin Redesign); FDH-15's contextual-bridge/
whole-product integration certification; FDH-16's terminal end-to-end certification; any new India investment
functionality (owned by the Investment Intelligence module); any speculative refactor of an already-certified
module absent a reproduced defect.

## 4. Certification methodology (per the spec's own §5, §128, §129)

FDH-0 through FDH-12 are treated as **frozen**. This certification pass:

1. Re-ran the repository-level gates fresh on the current worktree (git state, migration guards, `tsc`,
   `vitest`, `eslint`, production build) rather than citing old numbers.
2. Re-derived the core economic-classification taxonomy and the typed Apply boundaries by reading the
   **current** source files, not by trusting old completion reports' descriptions of them.
3. Ran a **fresh, live-DEV** read-only schema probe (34/34 representative FDH + bridge + canonical tables
   confirmed present in the real hosted DEV project) and a **fresh, live-DEV** cross-tenant + same-tenant
   authority-forgery proof across three canonical domains (Income/Liabilities/Retirement), using two
   newly-created synthetic tenants that were fully deleted afterwards and independently re-verified as gone.
4. **Reused** the extensive, already-live-DEV-certified evidence that FDH-1 through FDH-12, R7 and R8 each
   produced in their own certification rounds (see `FDH14_RESIDUAL_RISK_REGISTER.md` and
   `FDH14_LIVE_DEV_CERTIFICATION.md` for exactly which claims are reused vs fresh) rather than re-running every
   expensive per-adapter/per-scale scenario a second time for ceremony, per spec §129.
5. Did **not** build a new full-stack, five-domain, real-file-upload "golden household" E2E run through a live
   browser in this pass. That would duplicate, at a smaller scale, the exact live-DEV rounds FDH-9/10/11/12
   already ran (each independently proving its own slice of the same salary/card/loan/dividend/rollover
   oracle live). FDH-14's fresh contribution is (a) the cross-cutting economic-event **oracle document** that
   assembles all of those already-proven numbers into one register for the first time, and (b) the fresh
   cross-domain **security** proof described above. This is disclosed as a residual, not hidden — see
   `FDH14_RESIDUAL_RISK_REGISTER.md` item R-14-1.

## 5. Definition of done

FDH-14 becomes **STANDALONE FDH CORE DEV CERTIFIED — READY FOR PRODUCT OWNER CLOSURE** only if every gate in
spec §130 is genuinely PASS or an honestly-bounded residual, with zero P0/P1 defects open. See
`FDH14_COMPLETION_REPORT.md` for the verdict actually reached.

## 6. FDH-13 boundary (repeated per spec §3/§131, non-negotiable)

> FDH-14 certifies the standalone Financial Data Hub data plane. Administrative governance remains owned by
> the Admin Redesign under FDH-13 and is separately certified.
