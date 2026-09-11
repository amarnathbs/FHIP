-- AIE-1.3 — FDH bank-statement adapter: minimal ADDITIVE bridge from the
-- already-existing AIE-1.1 scaffold (migration 0140) to FDH's own,
-- already-certified bank-statement canonical tables (FDH-5 `bank-pdf`,
-- R7 `bank-csv`). This migration deliberately does NOT create a second
-- exception/review/reconciliation table for FDH bank statements — it adds
-- exactly one nullable column so `aie_write_batch` (already scoped to
-- `target_module = 'fdh_bank'` by 0140) can record WHICH canonical FDH row
-- an AIE-gated import actually produced, once FDH's own existing atomic
-- import service (`processBankPdfDocument()`,
-- `lib/financial-data-hub/services/bankPdfProcessingService.ts`) has run.
--
-- HELD LOCALLY. Not applied to any DEV or production database this pass —
-- see AIE-1.3's own final report for exact verification evidence.
--
-- Numbered 0141: main's highest is 0137, `feature/lr-1-upload-security-
-- lifecycle` claims 0138/0139, `feature/aie-1-1-document-gateway` (this
-- branch's own base) claims 0140, and the concurrently-developed
-- `feature/aie-1-2-investment-adapter` branch was re-checked immediately
-- before writing this file and had not diverged from
-- `feature/aie-1-1-document-gateway` (identical HEAD `cd2d4a2` at the time
-- of that check) — so 0141 is free on every branch this repository's own
-- collision-guard script (`scripts/check-migration-versions-against-
-- branch.mjs`) can see. Re-verify before ever applying this file for real,
-- exactly as AIE-1.1's own migration header instructs.

-- ---------------------------------------------------------------------------
-- 1. aie_write_batch — record which canonical FDH row a committed batch
--    produced. Nullable (a batch can fail/remain pending with no row yet),
--    and ON DELETE SET NULL so a later FDH-side correction/deletion never
--    blocks or cascades into AIE's own audit trail (AIE stays the
--    source-of-truth for "what happened during processing"; FDH stays
--    authoritative for "what the canonical row currently says").
-- ---------------------------------------------------------------------------
alter table aie_write_batch
  add column canonical_reference_table text check (canonical_reference_table in ('fdh_statement_uploads', null)),
  add column canonical_reference_id uuid references fdh_statement_uploads(id) on delete set null;

create index idx_aie_write_batch_canonical_reference on aie_write_batch (canonical_reference_id) where canonical_reference_id is not null;

comment on column aie_write_batch.canonical_reference_id is
  'AIE-1.3: the FDH canonical row (fdh_statement_uploads.id today) that this write batch produced once FDH''s own atomic-import service committed it. NULL until committed; stays NULL forever for a batch that never reached commit.';

-- ---------------------------------------------------------------------------
-- 2. aie_unresolved_item — no new column, no new table. AIE-1.3 reuses this
--    table AS-IS for both (a) account/holder ownership ambiguity surfaced by
--    FDH's own `resolveAccountIdentity()` outcome and (b) statement-balance /
--    PDF-CSV-overlap reconciliation failures — see
--    `lib/aie/adapters/fdhBankStatement/reconciliation.ts`'s own header for
--    the exact reason-code vocabulary this migration does NOT need to
--    enumerate in SQL (reason_code is already a free-form text column with
--    no CHECK constraint in 0140, by design — see that migration's own
--    comment on why unresolved-item reason codes are an application-layer,
--    not database-layer, vocabulary).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. No new RLS policy required. `aie_write_batch`'s existing
--    "select own aie_write_batch" policy (0140) already covers the two new
--    columns (RLS is row-scoped, not column-scoped) and its existing
--    `trg_aie_write_batch_owner` trigger already re-validates ownership on
--    any update touching `intake_id`/`user_id` — this migration adds no new
--    write surface (both new columns are written exclusively by the
--    service-role client, matching every other AIE table's discipline).
-- ---------------------------------------------------------------------------
