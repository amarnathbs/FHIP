-- =============================================================================
-- R8 — Transaction Categorisation & Merchant Intelligence: schema hardening
-- and the two minimal additive columns the engine needs.
--
-- R8-P0 (docs/financial-data-hub/R8_ASSUMPTION_RECONCILIATION.md) found that
-- the ENTIRE classification schema already exists, unused, since FDH-1
-- (migration 0047): `fdh_transactions.economic_transaction_type`/
-- `category_id`/`subcategory_id`/`merchant_id`/`classification_confidence`/
-- `classification_method`, `fdh_transaction_links`, `fdh_recurring_
-- transactions`, `fdh_classification_history`, `fdh_transaction_corrections`,
-- `fdh_user_classification_rules`. FDH-2 (0050-0057) separately built the
-- full reference/governance layer (taxonomy, MCC map, merchant master, 60
-- classification rules, a pure precedence resolver). Nothing has ever
-- written a real classification. This migration therefore does NOT create a
-- parallel schema — it adds exactly two columns the existing schema is
-- missing, and closes six concrete, currently-live authoritative-write gaps
-- that would otherwise let an authenticated user forge R8's own output the
-- same way `reconciliation_status` was forged and fixed in migration 0065.
--
-- SCOPE OF THIS FILE: schema + security only. No classification logic, no
-- seed data (all reference data already exists from FDH-2), no new table.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Two additive columns.
-- ---------------------------------------------------------------------------

-- `fdh_transaction_links` has no field for WHY a link was proposed beyond the
-- coarse `created_by_method` enum (system_rule|algorithm|ai|user_manual|
-- admin) — R8 spec section 45 requires a deterministic, human-readable
-- explanation ("Matched an equal and opposite transaction in another
-- household-owned account"). Structured jsonb, not free text, so the exact
-- comparison facts (amounts, dates, accounts, rule name) survive machine-
-- readably for the review UI and for audit.
alter table fdh_transaction_links
  add column match_evidence jsonb;

comment on column fdh_transaction_links.match_evidence is
  'R8: structured deterministic evidence for why this link was proposed '
  '(rule name + comparison facts), e.g. '
  '{"rule":"internal_transfer_exact_amount_opposite_direction",'
  '"amount":"120.00","date_delta_days":1,"account_from":"...","account_to":"..."}. '
  'Never free text a user supplies; always written by the matching engine.';

-- `fdh_recurring_transactions` has no linkage back to its member
-- transactions at all. R8 spec section 54 requires exposing "recurring-
-- series membership" per transaction. Nullable, single-series membership
-- (a transaction belongs to at most one recurring series — if evidence ever
-- supports two candidate series, R8's engine must pick the stronger one or
-- leave both unset and mark the transaction for review, never silently
-- assign both).
alter table fdh_transactions
  add column recurring_transaction_id uuid references fdh_recurring_transactions(id) on delete set null;

create index idx_fdh_txn_recurring
  on fdh_transactions(recurring_transaction_id)
  where recurring_transaction_id is not null;

comment on column fdh_transactions.recurring_transaction_id is
  'R8: which fdh_recurring_transactions series this row belongs to, if any. '
  'System-authoritative — see the hardening below.';


-- ---------------------------------------------------------------------------
-- 1b. `fdh_document_audit_events.event_type` — additive widening (spec
-- sections 32, 46-48, 53, 61), following the exact precedent migration 0064
-- established for its own R7 event types (see that migration's header note
-- on widening discipline: drop-and-immediately-re-add the same constraint
-- name, union of every prior set, never a removal).
-- ---------------------------------------------------------------------------
alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058) — unchanged.
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064) — unchanged.
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions.
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created'
    ));


-- ---------------------------------------------------------------------------
-- 2. Evidenced-write helper.
--
-- The correction feature (fdh_transaction_corrections + correctTransaction(),
-- shipped since R7) already lets a user legitimately overwrite
-- `economic_transaction_type`/`category_id`/`subcategory_id`/`merchant_id`
-- on their OWN transaction via the ordinary RLS-scoped session — never
-- service-role (see bankTransactionActionsService.ts). Blocking authenticated
-- writes to those columns outright, the way 0065 did for
-- `reconciliation_status`, would break that already-shipped feature.
--
-- Instead: an authenticated write to one of these columns is allowed ONLY
-- when a matching row was JUST inserted into fdh_transaction_corrections for
-- the exact same transaction/field/value, by the same user, within the last
-- 5 minutes. correctTransaction() always inserts the correction row BEFORE
-- updating fdh_transactions (see bankTransactionActionsService.ts:96-109),
-- so this ordering is exactly what the shipped code path produces. A direct
-- forged PATCH with no corresponding correction row fails this check.
-- ---------------------------------------------------------------------------
create or replace function r8_transaction_field_evidenced(
  p_transaction_id uuid, p_field text, p_value jsonb
) returns boolean as $$
  select exists (
    select 1 from fdh_transaction_corrections
    where transaction_id = p_transaction_id
      and user_id = auth.uid()
      and field_name = p_field
      and corrected_value = p_value
      and corrected_at > now() - interval '5 minutes'
  );
$$ language sql stable security definer set search_path = public;


-- ---------------------------------------------------------------------------
-- 3. Widen the EXISTING `fdh_transactions` authoritative-field trigger
-- (create or replace on the same function/trigger name, per the 0065
-- precedent — never a parallel trigger on the same table).
-- ---------------------------------------------------------------------------
create or replace function r7_assert_transaction_authoritative_fields() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    -- R7's own dedup/provenance fields (0064) — unchanged.
    if new.source_row_hash is distinct from old.source_row_hash
      or new.economic_fingerprint is distinct from old.economic_fingerprint
      or new.economic_fingerprint_version is distinct from old.economic_fingerprint_version
      or new.balance_after is distinct from old.balance_after
      or new.transaction_type_hint is distinct from old.transaction_type_hint
      or new.parser_version_id is distinct from old.parser_version_id
    then
      raise exception 'fdh_transactions: authoritative R7 dedup/provenance fields may not be written directly by the authenticated role';
    end if;
    if new.dedup_status is distinct from old.dedup_status then
      if old.dedup_status <> 'duplicate_candidate'
        or new.dedup_status not in ('user_confirmed_distinct', 'user_confirmed_duplicate')
      then
        raise exception 'fdh_transactions: dedup_status may only move from duplicate_candidate to a user_confirmed_* resolution';
      end if;
    end if;

    -- R8 (NEW): classification fields with a legitimate correction path.
    -- Each requires a matching, fresh fdh_transaction_corrections row.
    if new.economic_transaction_type is distinct from old.economic_transaction_type then
      if not r8_transaction_field_evidenced(new.id, 'economic_transaction_type', to_jsonb(new.economic_transaction_type)) then
        raise exception 'fdh_transactions: economic_transaction_type may only be changed via a recorded correction';
      end if;
    end if;
    if new.category_id is distinct from old.category_id then
      if not r8_transaction_field_evidenced(new.id, 'category_id', to_jsonb(new.category_id)) then
        raise exception 'fdh_transactions: category_id may only be changed via a recorded correction';
      end if;
    end if;
    if new.subcategory_id is distinct from old.subcategory_id then
      if not r8_transaction_field_evidenced(new.id, 'subcategory_id', to_jsonb(new.subcategory_id)) then
        raise exception 'fdh_transactions: subcategory_id may only be changed via a recorded correction';
      end if;
    end if;
    if new.merchant_id is distinct from old.merchant_id then
      if not r8_transaction_field_evidenced(new.id, 'merchant_id', to_jsonb(new.merchant_id)) then
        raise exception 'fdh_transactions: merchant_id may only be changed via a recorded correction';
      end if;
    end if;

    -- R8 (NEW): review_status has exactly one legitimate authenticated
    -- transition — the correction service moving it to 'resolved', which it
    -- always does in the same statement as a genuine field correction. Any
    -- other change (e.g. self-clearing 'pending'/'in_review' with no
    -- correction behind it, or fabricating a review outcome) is blocked.
    if new.review_status is distinct from old.review_status then
      if new.review_status <> 'resolved'
        or not exists (
          select 1 from fdh_transaction_corrections
          where transaction_id = new.id
            and user_id = auth.uid()
            and corrected_at > now() - interval '5 minutes'
        )
      then
        raise exception 'fdh_transactions: review_status may only move to resolved alongside a recorded correction';
      end if;
    end if;

    -- R8 (NEW): fields with NO legitimate authenticated write path at all —
    -- absent from fdh_transaction_corrections.field_name's closed vocabulary,
    -- system-computed only.
    if new.classification_confidence is distinct from old.classification_confidence
      or new.classification_method is distinct from old.classification_method
      or new.recurring_flag is distinct from old.recurring_flag
      or new.subscription_flag is distinct from old.subscription_flag
      or new.transfer_flag is distinct from old.transfer_flag
      or new.recurring_transaction_id is distinct from old.recurring_transaction_id
    then
      raise exception 'fdh_transactions: authoritative R8 classification fields may not be written directly by the authenticated role';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- `trg_r7_transaction_authoritative_fields` already exists (migration 0064)
-- and fires `before update ... for each row` — replacing the function body
-- is sufficient, no new CREATE TRIGGER needed.


-- ---------------------------------------------------------------------------
-- 4. `fdh_transaction_links` — engine-only INSERT, guarded UPDATE.
--
-- This table has NEVER had any write-side hardening since it was created in
-- FDH-1 (0047): plain `for all using (auth.uid() = user_id)`. R8 is its
-- first real writer, so per the established rule (0065's own stated
-- precedent) it needs the full pattern from day one, not a later patch.
-- ---------------------------------------------------------------------------
create trigger trg_r8_block_authenticated_insert_transaction_links
  before insert on fdh_transaction_links
  for each row execute function r7_block_authenticated_insert();

create or replace function r8_assert_transaction_link_authoritative_fields() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    if new.transaction_id_from is distinct from old.transaction_id_from
      or new.transaction_id_to is distinct from old.transaction_id_to
      or new.link_type is distinct from old.link_type
      or new.confidence is distinct from old.confidence
      or new.created_by_method is distinct from old.created_by_method
      or new.match_evidence is distinct from old.match_evidence
    then
      raise exception 'fdh_transaction_links: authoritative match fields may not be written directly by the authenticated role';
    end if;
    -- The one legitimate user action (spec section 32/61): reviewing a
    -- proposed link. status may only move pending -> confirmed/rejected,
    -- and user_confirmed may only be set true alongside that transition.
    if new.status is distinct from old.status then
      if old.status <> 'pending' or new.status not in ('confirmed', 'rejected') then
        raise exception 'fdh_transaction_links: status may only move from pending to confirmed or rejected';
      end if;
    end if;
    if new.user_confirmed is distinct from old.user_confirmed then
      if new.user_confirmed is not true or new.status <> 'confirmed' then
        raise exception 'fdh_transaction_links: user_confirmed may only be set true alongside status=confirmed';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_r8_transaction_link_authoritative_fields
  before update on fdh_transaction_links
  for each row execute function r8_assert_transaction_link_authoritative_fields();


-- ---------------------------------------------------------------------------
-- 5. `fdh_recurring_transactions` — same pattern: engine-only INSERT,
-- guarded UPDATE (user may confirm/pause/end their own detected series, but
-- not fabricate the detection facts behind it).
-- ---------------------------------------------------------------------------
create trigger trg_r8_block_authenticated_insert_recurring_transactions
  before insert on fdh_recurring_transactions
  for each row execute function r7_block_authenticated_insert();

create or replace function r8_assert_recurring_transaction_authoritative_fields() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    if new.merchant_id is distinct from old.merchant_id
      or new.financial_account_id is distinct from old.financial_account_id
      or new.frequency is distinct from old.frequency
      or new.expected_amount is distinct from old.expected_amount
      or new.amount_tolerance is distinct from old.amount_tolerance
      or new.currency_code is distinct from old.currency_code
      or new.next_expected_date is distinct from old.next_expected_date
      or new.confidence is distinct from old.confidence
    then
      raise exception 'fdh_recurring_transactions: authoritative detection fields may not be written directly by the authenticated role';
    end if;
    -- Legitimate user actions: confirm a candidate series, or pause/end an
    -- active one. Never move backward into 'candidate', never resurrect an
    -- 'ended' series (a genuinely restarted subscription becomes a new
    -- series through re-detection, not a status flip).
    if new.status is distinct from old.status then
      if old.status = 'candidate' and new.status in ('active', 'ended') then
        null; -- confirming a candidate, or dismissing one the user doesn't want tracked
      elsif old.status = 'active' and new.status in ('paused', 'ended') then
        null; -- user pausing/ending an active series
      elsif old.status = 'paused' and new.status in ('active', 'ended') then
        null; -- user resuming/ending a paused series
      else
        raise exception 'fdh_recurring_transactions: status transition % -> % is not a permitted authenticated-role action', old.status, new.status;
      end if;
    end if;
    if new.user_confirmed is distinct from old.user_confirmed then
      if new.user_confirmed is not true then
        raise exception 'fdh_recurring_transactions: user_confirmed may only be set true, never unset, by the authenticated role';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_r8_recurring_transaction_authoritative_fields
  before update on fdh_recurring_transactions
  for each row execute function r8_assert_recurring_transaction_authoritative_fields();


-- ---------------------------------------------------------------------------
-- 6. `fdh_classification_history` — restrict authenticated INSERT to
-- self-attested `changed_by_type = 'user'` rows only. This table is an
-- audit trail (SELECT+INSERT-only RLS since 0047, deliberately no UPDATE/
-- DELETE policy at all); without this guard a user could freely fabricate a
-- row claiming `changed_by_type = 'system'` with an arbitrary confidence and
-- rule reference, polluting their own audit history with a fake system
-- decision. System/admin rows must come from the service-role engine, which
-- bypasses RLS/triggers entirely and is unaffected by this.
-- ---------------------------------------------------------------------------
create or replace function r8_assert_classification_history_actor() returns trigger as $$
begin
  if auth.role() = 'authenticated' and new.changed_by_type <> 'user' then
    raise exception 'fdh_classification_history: only changed_by_type=''user'' rows may be inserted directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_r8_classification_history_actor
  before insert on fdh_classification_history
  for each row execute function r8_assert_classification_history_actor();
