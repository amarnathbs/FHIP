-- =============================================================================
-- Financial Data Hub — FDH-7 (0076): Reconciliation, Transaction Review &
-- User Approval Workflow.
-- =============================================================================
-- REUSE-FIRST. FDH-1 (0047-0048) already built the entire review/relationship
-- domain model this phase operates on: fdh_review_items, fdh_reconciliation_
-- results, fdh_transaction_links (transfer/refund/reversal/duplicate),
-- fdh_duplicate_candidates, fdh_transaction_allocations (splits),
-- fdh_recurring_transactions, fdh_classification_history and (R7, 0064)
-- fdh_transaction_corrections. R8 (0068) already built the confirm/reject
-- transitions for links and recurring series, with real DB-level transition
-- guards. FDH-7 adds NO second copy of any of this. It adds exactly the two
-- things that did not already exist: (1) a genuine, deliberate, user-driven
-- APPROVAL concept (transaction-level and statement-level) that is NOT
-- silently implied by "successfully parsed"/"certified" — see the note on
-- `approved_by` below — and (2) the Approved Financial Summary this approval
-- produces.
--
-- THE "APPROVAL IS NOT IMPORT SUCCESS" GAP (spec sections 14, 55, 159).
-- `bankCsvProcessingService.ts`/`bankPdfProcessingService.ts` already move
-- `fdh_statement_uploads.processing_status` all the way to 'approved' for a
-- statement R7/FDH-5 certifies as fully clean and reconciled — WITHOUT any
-- user action. `approved_at` (migration 0046) has never actually been
-- written by any existing code path (confirmed by inspection before writing
-- this migration). This migration deliberately does NOT touch that
-- certified, live-tested R7/FDH-5 behaviour (out of narrow scope; additive
-- only) and does NOT repurpose `processing_status`'s existing meaning.
-- Instead it adds `approved_by` as the ONE new, load-bearing signal of
-- GENUINE user approval — a statement is only ever treated as "the user has
-- reviewed and approved this" when `approved_by is not null`, never merely
-- because `processing_status = 'approved'`. The Approved Financial Summary
-- and any future FDH-15 bridge must gate on `approved_by`/the existence of
-- an `fdh_approved_financial_summaries` row, never on `processing_status`
-- alone. See FDH7_APPROVAL_MODEL.md for the full rationale.
--
-- WHY NO CHANGE TO fdh_statement_uploads.processing_status OR ITS TRANSITION
-- TABLE. `lib/financial-data-hub/domain/documentLifecycle.ts` is a certified,
-- live-tested FDH-3 state machine with `approved` deliberately terminal
-- except for the purge path. FDH-7's REOPEN workflow (spec 63-64) therefore
-- does not attempt to move `processing_status` backwards — the document WAS
-- genuinely, successfully processed and that fact does not change on reopen.
-- What reopens is specifically the FDH-7 approval gate: `approved_by` is
-- cleared, `reopened_at`/`reopened_by`/`reopen_reason` record the event, and
-- the previous `fdh_approved_financial_summaries` row is marked superseded.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads — additive statement-level approval/reopen columns.
-- ---------------------------------------------------------------------------
alter table fdh_statement_uploads
  add column approved_by uuid references auth.users(id) on delete set null,
  add column approval_version int not null default 0 check (approval_version >= 0),
  add column reopened_at timestamptz,
  add column reopened_by uuid references auth.users(id) on delete set null,
  add column reopen_reason text,
  add constraint chk_fdh_uploads_genuine_approval
    check (approved_by is null or approved_at is not null);

comment on column fdh_statement_uploads.approved_by is
  'FDH-7. The ONLY authoritative signal of genuine user approval. NULL means '
  'not (or no longer) user-approved, regardless of processing_status.';


-- ---------------------------------------------------------------------------
-- fdh_transactions — additive transaction-level approval columns.
-- ---------------------------------------------------------------------------
alter table fdh_transactions
  add column approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null,
  add constraint chk_fdh_txn_approval_requires_fields
    check (approval_status <> 'approved' or (approved_at is not null and approved_by is not null));

create index idx_fdh_txn_approval_pending
  on fdh_transactions(user_id, statement_upload_id)
  where approval_status = 'pending';


-- ---------------------------------------------------------------------------
-- Centralised blocking-issue policy (spec sections 21, 53-54, 109-110, 123).
-- ONE definition, reused by: the DB trigger guards below (real enforcement —
-- a forged direct PostgREST request cannot bypass this), an RPC the service
-- layer calls for a friendly pre-check, and documented 1:1 in
-- FDH7_APPROVAL_MODEL.md. The UI must never compute its own competing
-- blocking-issue formula (spec 17, extended to approval blocking rules).
--
-- A transaction blocks approval when: its economic classification is still
-- 'unknown'; it carries an OPEN 'blocking'-severity review item; it is one
-- side of a still-PENDING transfer/refund/reversal/duplicate link
-- (fdh_transaction_links); it is party to a still-PENDING duplicate
-- candidate; or it has allocations (a split) whose sum does not exactly
-- equal the parent amount (spec 45-46 — exact numeric(20,4) comparison, no
-- floating point anywhere in this check).
-- ---------------------------------------------------------------------------
create or replace function fdh7_transaction_has_blocking_issue(p_user_id uuid, p_transaction_id uuid)
returns boolean
language sql
stable
as $$
  select
    exists (
      select 1 from fdh_transactions t
      where t.id = p_transaction_id and t.user_id = p_user_id
        and t.economic_transaction_type = 'unknown'
    )
    or exists (
      select 1 from fdh_review_items
      where user_id = p_user_id and transaction_id = p_transaction_id
        and severity = 'blocking' and status in ('open', 'in_progress')
    )
    or exists (
      select 1 from fdh_transaction_links
      where user_id = p_user_id and status = 'pending'
        and (transaction_id_from = p_transaction_id or transaction_id_to = p_transaction_id)
    )
    or exists (
      select 1 from fdh_duplicate_candidates
      where user_id = p_user_id and status = 'pending'
        and (transaction_id_a = p_transaction_id or transaction_id_b = p_transaction_id)
    )
    or exists (
      select t.amount_original from fdh_transactions t
      join fdh_transaction_allocations a on a.transaction_id = t.id
      where t.id = p_transaction_id and t.user_id = p_user_id and a.user_id = p_user_id
      group by t.id, t.amount_original
      having sum(a.amount) <> t.amount_original
    );
$$;

-- A statement blocks approval when: it has an open blocking review item of
-- its own (e.g. reconciliation_failure raised at statement level); its
-- reconciliation result explicitly FAILED (spec 18 — never silently
-- overridden); or ANY of its transactions individually blocks (above).
create or replace function fdh7_statement_has_blocking_issue(p_user_id uuid, p_statement_id uuid)
returns boolean
language sql
stable
as $$
  select
    exists (
      select 1 from fdh_review_items
      where user_id = p_user_id and statement_upload_id = p_statement_id
        and severity = 'blocking' and status in ('open', 'in_progress')
    )
    or exists (
      select 1 from fdh_reconciliation_results
      where user_id = p_user_id and statement_upload_id = p_statement_id and status = 'failed'
    )
    or exists (
      select 1 from fdh_transactions t
      where t.user_id = p_user_id and t.statement_upload_id = p_statement_id
        and fdh7_transaction_has_blocking_issue(p_user_id, t.id)
    );
$$;

grant execute on function fdh7_transaction_has_blocking_issue(uuid, uuid) to authenticated;
grant execute on function fdh7_statement_has_blocking_issue(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- DB-level approval guards (spec 109-110, 123 — "a forged direct API
-- request must not bypass review"). Mirrors the exact house pattern R8
-- (migration 0068) already established for transaction-link/recurring-series
-- transitions: application code checks first for a clean error message, and
-- the trigger is the actual, un-bypassable enforcement.
-- ---------------------------------------------------------------------------
create or replace function fdh7_guard_transaction_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approval_status = 'approved' and old.approval_status is distinct from 'approved' then
    if fdh7_transaction_has_blocking_issue(new.user_id, new.id) then
      raise exception 'fdh_transactions: cannot approve a transaction with an unresolved blocking review issue';
    end if;
    if new.approved_at is null then
      new.approved_at := now();
    end if;
    if new.approved_by is null then
      raise exception 'fdh_transactions: an approval must name the approving user';
    end if;
  end if;
  if old.approval_status = 'approved' and new.approval_status = 'pending' then
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;

create trigger trg_fdh7_guard_transaction_approval
  before update of approval_status on fdh_transactions
  for each row execute function fdh7_guard_transaction_approval();

create or replace function fdh7_guard_statement_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approved_by is not null and old.approved_by is null then
    if fdh7_statement_has_blocking_issue(new.user_id, new.id) then
      raise exception 'fdh_statement_uploads: cannot approve a statement with unresolved blocking review issues';
    end if;
    new.approval_version := old.approval_version + 1;
    if new.approved_at is null then
      new.approved_at := now();
    end if;
  elsif new.approved_by is null and old.approved_by is not null then
    -- Reopen: processing_status is deliberately left untouched (see header
    -- note) — only the FDH-7 approval gate itself moves.
    new.approved_at := null;
    if new.reopened_at is null then
      new.reopened_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_fdh7_guard_statement_approval
  before update of approved_by on fdh_statement_uploads
  for each row execute function fdh7_guard_statement_approval();


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads.processing_status — DB-level transition guard
-- (spec sections 109-110, 123, 127 — "state machine: bypass server
-- transition guard, invalid transition test must detect it").
--
-- PRE-EXISTING GAP CLOSED. `lib/financial-data-hub/domain/
-- documentLifecycle.ts`'s `DOCUMENT_STATUS_TRANSITIONS` table (FDH-3,
-- certified) has governed every APPLICATION code path since migration 0058,
-- but no DATABASE constraint or trigger ever enforced it — a forged direct
-- PostgREST request carrying the row owner's own valid JWT (bypassing the
-- Next.js API route entirely) could set `processing_status` to ANY value
-- from ANY state, including jumping straight to 'approved' (which
-- `isPurgeEligible()` in the same file treats as purge-eligible) without
-- ever having been processed. This is disclosed as a genuine pre-existing
-- residual, not introduced by FDH-7 — see FDH7_SECURITY_MODEL.md. FDH-7
-- closes it here because it is exactly this phase's own concern (spec 109)
-- and the fix is purely ADDITIVE and MIRRORS an already-agreed, already-
-- certified transition table: it can only ever REJECT a transition the
-- application layer would already have rejected; no legitimate write path
-- changes behaviour.
-- ---------------------------------------------------------------------------
create or replace function fdh7_guard_document_processing_status()
returns trigger
language plpgsql
as $$
declare
  v_allowed boolean;
begin
  if new.processing_status = old.processing_status then
    return new;
  end if;
  v_allowed := case old.processing_status
    when 'created' then new.processing_status in ('uploaded', 'failed', 'rejected')
    when 'uploaded' then new.processing_status in ('validating', 'failed', 'rejected')
    when 'validating' then new.processing_status in ('queued', 'failed', 'rejected')
    when 'queued' then new.processing_status in ('processing', 'failed', 'rejected')
    when 'processing' then new.processing_status in ('extracted', 'review_required', 'failed', 'rejected')
    when 'extracted' then new.processing_status in ('review_required', 'ready_for_approval', 'failed', 'rejected')
    when 'review_required' then new.processing_status in ('ready_for_approval', 'rejected', 'failed')
    when 'ready_for_approval' then new.processing_status in ('approved', 'review_required', 'rejected')
    when 'approved' then new.processing_status in ('purge_pending')
    when 'rejected' then false
    when 'failed' then new.processing_status in ('queued', 'rejected')
    when 'purge_pending' then new.processing_status in ('purged', 'failed')
    when 'purged' then false
    else false
  end;
  if not v_allowed then
    raise exception 'fdh_statement_uploads: processing_status transition % -> % is not permitted', old.processing_status, new.processing_status;
  end if;
  return new;
end;
$$;

create trigger trg_fdh7_guard_document_processing_status
  before update of processing_status on fdh_statement_uploads
  for each row execute function fdh7_guard_document_processing_status();


-- ---------------------------------------------------------------------------
-- fdh_approved_financial_summaries — the canonical, versioned, per-statement
-- approved-activity record (spec 57, 63, 102-107). One row per
-- (statement_upload_id, approval_version); reopening never deletes a prior
-- row, it marks it `superseded` and a fresh approval inserts the next
-- version (spec 63 — approval history is never erased).
--
-- Every total here is computed by
-- lib/financial-data-hub/domain/approvedSummary.ts using exact minor-unit
-- arithmetic (lib/financial-data-hub/domain/money.ts) over the transactions'
-- OWN persisted numeric(20,4) values — this table stores the RESULT, it
-- computes nothing itself. Transfers/duplicates/refunds/splits are excluded/
-- netted exactly as documented in FDH7_APPROVED_FINANCIAL_SUMMARY.md.
-- ---------------------------------------------------------------------------
create table fdh_approved_financial_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  financial_account_id uuid not null references fdh_financial_accounts(id) on delete cascade,
  approval_version int not null check (approval_version >= 1),
  period_start date,
  period_end date,
  currency_code char(3) references currencies(currency_code) on delete restrict,
  approved_transaction_count int not null default 0 check (approved_transaction_count >= 0),
  unresolved_transaction_count int not null default 0 check (unresolved_transaction_count >= 0),
  income_total numeric(20,4) not null default 0,
  expense_total numeric(20,4) not null default 0,
  transfer_total numeric(20,4) not null default 0,
  refund_total numeric(20,4) not null default 0,
  tax_total numeric(20,4) not null default 0,
  fee_total numeric(20,4) not null default 0,
  cash_withdrawal_total numeric(20,4) not null default 0,
  investment_total numeric(20,4) not null default 0,
  debt_principal_total numeric(20,4) not null default 0,
  debt_interest_total numeric(20,4) not null default 0,
  asset_purchase_total numeric(20,4) not null default 0,
  asset_sale_total numeric(20,4) not null default 0,
  unknown_total numeric(20,4) not null default 0,
  -- {category_id: {label, total}} — structured, never raw narrative text.
  category_aggregates jsonb,
  superseded boolean not null default false,
  approved_at timestamptz not null default now(),
  approved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint uq_fdh_summary_statement_version unique (statement_upload_id, approval_version),
  constraint chk_fdh_summary_period check (period_end is null or period_start is null or period_end >= period_start)
);
create index idx_fdh_summary_user on fdh_approved_financial_summaries(user_id);
create index idx_fdh_summary_statement on fdh_approved_financial_summaries(statement_upload_id, approval_version desc);
-- The dominant future FDH-15 bridge read: "give me the CURRENT approved
-- summary per account". Partial index keeps it small as reopen/reapprove
-- accumulates history.
create index idx_fdh_summary_account_current
  on fdh_approved_financial_summaries(financial_account_id) where not superseded;

alter table fdh_approved_financial_summaries enable row level security;
create policy "own rows - fdh_approved_financial_summaries" on fdh_approved_financial_summaries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_document_audit_events.event_type — additive widening (spec section 74).
-- Five new FDH-7 event types. TRANSFER_CONFIRMED/REJECTED, DUPLICATE_
-- CONFIRMED/REJECTED, RECURRING_CONFIRMED and REFUND_CONFIRMED are already
-- fully covered by the EXISTING 'transaction_link_reviewed' /
-- 'transaction_duplicate_resolved' / 'recurring_series_reviewed' event types
-- (each already carries a `decision`/`resolution` metadata field
-- distinguishing confirm from reject) — no duplicate event vocabulary is
-- introduced for those. See the migration header note on widening
-- discipline (established by 0064/0068/0071).
-- ---------------------------------------------------------------------------
alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058).
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064).
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions (migration 0068).
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created',
      -- FDH-5 additions (migration 0071).
      'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
      'pdf_native_extraction_started', 'pdf_native_extraction_completed',
      'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
      'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed',
      -- FDH-7 additions (spec section 74).
      'transaction_split_created', 'transaction_approved', 'statement_approved',
      'statement_reopened', 'bulk_review_action_completed'
    ));
