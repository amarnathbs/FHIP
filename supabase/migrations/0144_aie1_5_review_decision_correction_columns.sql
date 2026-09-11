-- AIE-1.5 — User Exception Review and Acceptance Integration.
--
-- NUMBERING NOTE: `origin/main` is at 0137. This branch's own base
-- (`feature/aie-1-1-document-gateway`) claims 0140. The three sibling
-- adapter branches built concurrently off that same base claim 0141
-- (`feature/aie-1-2-investment-adapter`), 0142
-- (`feature/aie-1-3-fdh-bank-adapter`) and 0143
-- (`feature/aie-1-4-other-modules`, merged into THIS branch for real
-- integration testing — see AIE_1_5_IMPLEMENTATION.md section 1). This file
-- is numbered 0144 to leave no gap and avoid a collision with any of them —
-- confirmed by fetching all four refs directly and running both
-- `scripts/check-migration-versions.mjs` (134 active migrations before this
-- file, next version 0144) and
-- `scripts/check-migration-versions-against-branch.mjs` against
-- `origin/main`, `feature/lr-1-upload-security-lifecycle`,
-- `feature/aie-1-2-investment-adapter` and `feature/aie-1-3-fdh-bank-adapter`
-- in turn — all four report "OK: no cross-branch migration collisions".
--
-- PRODUCTION AUTHORITY: NONE. Held locally on
-- feature/aie-1-5-exception-review-ux, NOT applied to any DEV or production
-- database — AIE-1.5 section 4 restates AIE-1.1's P9 verbatim ("no
-- production activation or user migration without separate authority").
--
-- SCOPE. AIE-1.5's own non-negotiable prohibitions forbid a second
-- exception table/state machine/queue (section 4) — this migration adds NO
-- new table. It ADDITIVELY widens the existing, single source-of-truth
-- `aie_review_decision` table (migration 0140) with three nullable columns
-- so a "correct a specific field" decision (AIE15-ACT-02/VALID-04: "enter
-- correction with schema-aware type/format/bounds" / "preserve raw user
-- input... store canonical normalized decision value") has somewhere typed
-- to live, instead of being smuggled into the free-text `rationale` column
-- as an ad hoc JSON blob. This is the ONLY schema change AIE-1.5 makes.
--
-- WHY THIS IS SAFE AND NOT MASS-ASSIGNMENT (AIE15-ACT-09). These columns
-- store the OUTCOME of a correction the server has already validated
-- against a per-reason-code allowlist of correctable fields and a typed
-- per-field validator (lib/aie/review/validation.ts) — they are never
-- written from a raw client `{field, value}` pair without that check
-- (lib/aie/review/decide.ts). `correction_field_name` is deliberately a
-- free-text column (not a new enum) because the set of correctable field
-- names is adapter-owned and open-ended (Insurance's `currencyCode`,
-- Investment Intelligence's `accountId`, FDH's `transactionSign`, etc.) —
-- exactly like `aie_unresolved_item.reason_code` and
-- `aie_field_candidate.field_name` already are in migration 0140. The
-- allowlist enforcement lives in application code (per AIE-1.1's own
-- established division of labour: the DB enforces vocabulary/ownership, the
-- application enforces the specific transition/value permitted), not a DB
-- CHECK constraint, because the permitted set varies per reason code.
--
-- `correction_value_raw` preserves exactly what the user typed (before
-- normalisation) and `correction_value_normalized` is the canonical value
-- actually used for revalidation/reconciliation/eventual canonical write —
-- VALID-04's own required distinction. Both are nullable because most
-- decision types (`accept`, `reject_document`, `defer`, `not_present`,
-- `request_reprocessing`) carry no corrected value at all.

alter table aie_review_decision
  add column correction_field_name text,
  add column correction_value_raw text,
  add column correction_value_normalized text;

comment on column aie_review_decision.correction_field_name is
  'AIE-1.5: the specific field this decision corrects, when decision_type is a correction. Server-validated against the reason code''s own permitted-field allowlist before insert (never arbitrary/client-chosen) — see lib/aie/review/decide.ts.';
comment on column aie_review_decision.correction_value_raw is
  'AIE-1.5: exactly what the user typed, before normalisation (VALID-04). Null for non-correction decisions.';
comment on column aie_review_decision.correction_value_normalized is
  'AIE-1.5: the canonical, schema-validated value actually used for revalidation/reconciliation (VALID-04/VALID-10). Null for non-correction decisions.';
