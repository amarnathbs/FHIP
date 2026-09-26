-- 0209 -- FDH-10 liability LEDGER Apply: approved credit-card and loan
-- statement activities become canonical transaction events, atomically with
-- the liability update (work package WP-11 of the Approved Upload -> Canonical
-- programme -- the MANDATORY GATE; gaps G1, G2, G4, G7, G8, G10, G11, G12,
-- G13, X-01, X-02).
--
-- THE DEFECT. Before this file, `fdh10_apply_liability_proposal` (0096 Part I,
-- never redefined since) wrote exactly four things: the liability row, the
-- fhip_import_applications row, the liability provenance columns and the
-- proposal status. It wrote NO fdh_transactions, NO allocations and NO links,
-- and nothing else in the liability pipeline did either. So an approved card
-- statement's purchases, interest and fees, and a loan statement's
-- principal/interest/fee split, never reached any canonical figure: purchases
-- $200 + $20 repaid by $220 gave household expense $0 once the bank debit was
-- treated as a settlement, and a $2,000 loan payment gave cost of debt $0.
--
-- WHAT THE APPLY NOW DOES, IN ONE TRANSACTION (the brief: liability update +
-- transaction writes + allocations + links + provenance + proposal status):
--   1. proposal row lock + compare-and-swap (unchanged, 0096);
--   2. statement row FOR UPDATE; approval required;
--   3. every blocker checked BEFORE the first write (a returned error never
--      leaves a partial write): unresolved ADJUSTMENT/OTHER lines (unless the
--      user acknowledged they are recorded as not counted), a repayment with
--      several possible bank debits, a loan PAYMENT whose disclosed
--      principal/interest/fee do not add up, a matched bank debit that is not
--      the user's (FOREIGN_TRANSACTION) or does not match in direction,
--      currency and amount, an unsupported currency (G13), a currency that
--      differs from the liability's;
--   4. the liability insert/update (owner from p_owner on add_new, G8;
--      "update existing" with nothing ticked no longer applies fields that
--      need the user's confirmation, X-01 -- a card minimum payment never
--      reaches monthly_repayment unticked);
--   5. the card/loan FACILITY account: resolved or created
--      (account_fingerprint 'fdh10:liability:<id>', liability_id, owner_role);
--   6. ONE approved fdh_transactions row per activity on that account
--      (mapping below, mirrored from classifyStatementActivity), a loan
--      PAYMENT with disclosed components as a header plus allocations 1..3
--      that sum exactly to it; overlap with an earlier statement of the same
--      facility is detected by an account-scoped economic fingerprint and
--      recorded, never re-inserted;
--   7. for each matched repayment: the bank debit is locked and re-verified,
--      the bank side's open settlement link is completed (or a confirmed one
--      inserted), and the bank leg is reclassified to 'transfer' through
--      0207's fdh_internal_reclassify_corroborated_leg (correction evidence
--      written, user_override respected);
--   8. activities.ledger_transaction_id / ledger_disposition, statement
--      liability_id / financial_account_id / ledger_status written back;
--   9. fhip_import_applications.ledger_effects and the audit events, with
--      document_id = the statement's upload, INSIDE the RPC (G12).
-- 'keep_existing' still records the statement's activities against the kept
-- liability (G10). A new 'reject_statement' decision records every activity
-- as explicitly not counted, with a visible reason (disposition E).
--
-- WHY THE WRITES ARE ALLOWED (X-02). Three existing guards stand in the way of
-- an authenticated caller, and each is passed only through the internal-write
-- GUC `fhip.import_bridge_internal_write` that this SECURITY DEFINER function
-- sets for its own transaction:
--   * r7 authenticated-INSERT block on fdh_transactions and
--     fdh_transaction_links (0064:392-405, 0068:221) -- made GUC-aware by 0207;
--   * the r8 link authoritative-field trigger (0068:225-253), made GUC-aware
--     HERE (section C) so an open settlement link can be completed;
--   * the r8 correction-evidence check on economic_transaction_type
--     (0068:129-165) -- satisfied by the correction row 0207's helper writes.
-- The 0076 approval guard fires on UPDATE of approval_status only; ledger rows
-- are INSERTED approved (approved_at/approved_by set, satisfying
-- chk_fdh_txn_approval_requires_fields) because they come from a statement the
-- user already approved and have no unknown type, no pending link and no
-- unreconciled split -- i.e. none of the conditions the guard blocks on.
--
-- IDEMPOTENCY. Repeat Apply: the proposal CAS refuses it (ALREADY_APPLIED).
-- A second proposal for the same statement: impossible while one is ready or
-- applied (partial unique index, section D), and the ledger phase is skipped
-- when the statement's ledger_status is no longer 'not_applied'. Per activity:
-- an activity with a ledger_transaction_id or a ledger_disposition is never
-- written again. Concurrent Applies serialise on the proposal and statement
-- row locks; concurrent statements of the same facility serialise on the
-- facility account row lock.
--
-- DEPENDS ON 0207 (liability_id/owner_role on accounts, ledger_transaction_id,
-- ledger_effects, the GUC-aware r7 block, the reclassify helper, the audit
-- event types) and 0208 (bank_match_candidate_ids, the extended F.1/F.2).
--
-- DEPLOY NOTE. The Dashboard consumers must read the canonical read models
-- (WP-02/WP-03) in the same release: the legacy dashboard reads the
-- fdh_transactions HEADER only and would count loan interest both inside
-- monthly_repayment and as a ledger row.
--
-- MIGRATION NUMBER: pre-assigned to WP-11 (0207-0214 reserved per package);
-- collision scan of every ref and worktree on 2026-09-27: no other 0209.
-- IDEMPOTENT: every statement is guarded or create-or-replace; a second apply
-- is a no-op (scripts/fdh10_0209_pglite_verification.mjs).

-- ============================================================================
-- A. Ledger disposition columns.
-- ============================================================================
alter table fdh_liability_statements
  add column if not exists ledger_status text not null default 'not_applied',
  add column if not exists ledger_applied_at timestamptz,
  add column if not exists ledger_rejected_reason text;

alter table fdh_liability_statement_activities
  add column if not exists ledger_disposition text,
  add column if not exists ledger_duplicate_of_transaction_id uuid references fdh_transactions(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_liability_statements'::regclass and conname = 'chk_fdh_liability_statements_ledger_status_0209') then
    alter table fdh_liability_statements add constraint chk_fdh_liability_statements_ledger_status_0209
      check (ledger_status in ('not_applied', 'applied', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_liability_statement_activities'::regclass and conname = 'chk_fdh_liability_activities_ledger_disposition_0209') then
    alter table fdh_liability_statement_activities add constraint chk_fdh_liability_activities_ledger_disposition_0209
      check (ledger_disposition is null or ledger_disposition in ('ledger_row', 'duplicate_of_existing', 'excluded_unclassified', 'rejected'));
  end if;
end $$;

create index if not exists idx_fdh_liability_activities_ledger_dup_0209
  on fdh_liability_statement_activities(ledger_duplicate_of_transaction_id) where ledger_duplicate_of_transaction_id is not null;

-- Same-tenant guard for the new reference (FDH1-F1 discipline).
create or replace function fdh0209_assert_activity_ledger_duplicate_owner() returns trigger as $$
declare
  v_owner uuid;
begin
  if new.ledger_duplicate_of_transaction_id is null then
    return new;
  end if;
  select user_id into v_owner from fdh_transactions where id = new.ledger_duplicate_of_transaction_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'fdh_liability_statement_activities: cross-tenant or missing reference -- ledger_duplicate_of_transaction_id %', new.ledger_duplicate_of_transaction_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_liability_activities_ledger_dup_owner_0209 on fdh_liability_statement_activities;
create trigger trg_fdh_liability_activities_ledger_dup_owner_0209
  before insert or update of user_id, ledger_duplicate_of_transaction_id on fdh_liability_statement_activities
  for each row execute function fdh0209_assert_activity_ledger_duplicate_owner();

-- ============================================================================
-- B. Authoritative-write triggers, EXTENDED (strict supersets).
--    F.1 predecessor: 0186 (no later definition; 0207 and 0208 did not touch it) --
--    extended here with the 0207 extraction_warnings, the (previously
--    unprotected) capitalised_total, and the ledger columns. F.2 predecessor: 0208.
-- ============================================================================
create or replace function fdh10_liability_statements_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.financial_account_id is distinct from old.financial_account_id
     or new.currency_code is distinct from old.currency_code
     or new.statement_type is distinct from old.statement_type
     or new.facility_type is distinct from old.facility_type
     or new.opening_balance is distinct from old.opening_balance
     or new.closing_balance is distinct from old.closing_balance
     or new.opening_principal is distinct from old.opening_principal
     or new.closing_principal is distinct from old.closing_principal
     or new.purchases_total is distinct from old.purchases_total
     or new.cash_advances_total is distinct from old.cash_advances_total
     or new.interest_total is distinct from old.interest_total
     or new.fees_total is distinct from old.fees_total
     or new.payments_total is distinct from old.payments_total
     or new.refunds_total is distinct from old.refunds_total
     or new.adjustments_total is distinct from old.adjustments_total
     or new.drawdowns_total is distinct from old.drawdowns_total
     or new.principal_repayments_total is distinct from old.principal_repayments_total
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.parser_name is distinct from old.parser_name
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.liability_id is distinct from old.liability_id
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
     or new.user_corrected_fields is distinct from old.user_corrected_fields
     or new.last_corrected_at is distinct from old.last_corrected_at
     or new.last_corrected_by is distinct from old.last_corrected_by
     or new.extraction_warnings is distinct from old.extraction_warnings
     or new.capitalised_total is distinct from old.capitalised_total
     -- Added by 0209: the ledger outcome is system-authoritative.
     or new.ledger_status is distinct from old.ledger_status
     or new.ledger_applied_at is distinct from old.ledger_applied_at
     or new.ledger_rejected_reason is distinct from old.ledger_rejected_reason
  then
    raise exception 'fdh_liability_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function fdh10_liability_activities_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.activity_type is distinct from old.activity_type
     or new.amount is distinct from old.amount
     or new.principal_component is distinct from old.principal_component
     or new.interest_component is distinct from old.interest_component
     or new.fee_component is distinct from old.fee_component
     or new.linked_transaction_id is distinct from old.linked_transaction_id
     or new.bank_match_status is distinct from old.bank_match_status
     or new.bank_match_candidate_ids is distinct from old.bank_match_candidate_ids
     or new.gst_amount_raw is distinct from old.gst_amount_raw
     or new.ledger_transaction_id is distinct from old.ledger_transaction_id
     -- Added by 0209.
     or new.ledger_disposition is distinct from old.ledger_disposition
     or new.ledger_duplicate_of_transaction_id is distinct from old.ledger_duplicate_of_transaction_id
  then
    raise exception 'fdh_liability_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- C. r8 link authoritative-field trigger: GUC-aware.
--    Predecessor: 0068:225-253 (the only definition). The authenticated-role
--    rules are unchanged; only a transaction that set the internal-write GUC
--    (which only SECURITY DEFINER functions can do) may complete a link.
-- ============================================================================
create or replace function r8_assert_transaction_link_authoritative_fields() returns trigger as $$
begin
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
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

-- ============================================================================
-- D. One live proposal per liability statement (G11), with a loud pre-check.
-- ============================================================================
do $$
declare
  v_dup int;
begin
  select count(*) into v_dup from (
    select source_liability_statement_id from fhip_import_proposals
     where source_liability_statement_id is not null and status in ('ready', 'applied')
     group by source_liability_statement_id having count(*) > 1) d;
  if v_dup > 0 then
    raise exception '0209 PRE-CHECK FAILED: % liability statement(s) have more than one ready/applied proposal. List them with: select source_liability_statement_id, array_agg(id order by generated_at), array_agg(status order by generated_at) from fhip_import_proposals where source_liability_statement_id is not null and status in (''ready'',''applied'') group by 1 having count(*) > 1; the PO remedy is to mark every READY duplicate superseded (never an applied one). Nothing was applied.', v_dup;
  end if;
end $$;

create unique index if not exists uq_fhip_import_proposals_live_liability_statement_0209
  on fhip_import_proposals(source_liability_statement_id)
  where source_liability_statement_id is not null and status in ('ready', 'applied');

-- ============================================================================
-- E. Internal helpers. None is executable by public/anon/authenticated.
-- ============================================================================

-- E.1 What would stop the ledger phase, checked before any write.
create or replace function fdh10_internal_ledger_blockers(p_user uuid, p_statement_id uuid, p_acknowledge_unclassified boolean)
returns jsonb as $$
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', x.id, 'activity_type', x.activity_type, 'reason', x.reason)
                            order by x.source_row_number nulls last, x.id), '[]'::jsonb)
  from (
    select a.id, a.activity_type, a.source_row_number,
      case
        when a.activity_type in ('ADJUSTMENT', 'OTHER') and not coalesce(p_acknowledge_unclassified, false) then 'unclassified_line'
        when a.bank_match_status = 'multiple_candidates' then 'multiple_bank_candidates'
        when a.activity_type = 'PAYMENT'
             and (a.principal_component is not null or a.interest_component is not null or a.fee_component is not null)
             and coalesce(a.principal_component, 0) + coalesce(a.interest_component, 0) + coalesce(a.fee_component, 0) <> a.amount
          then 'component_mismatch'
        when a.bank_match_status = 'matched' and a.linked_transaction_id is not null
             and not exists (select 1 from fdh_transactions t where t.id = a.linked_transaction_id and t.user_id = p_user)
          then 'foreign_transaction'
        when a.bank_match_status = 'matched' and a.linked_transaction_id is not null
             and not exists (select 1 from fdh_transactions t
                              where t.id = a.linked_transaction_id and t.user_id = p_user and t.credit_debit = 'debit'
                                and t.currency_original = a.currency_code and t.amount_original = a.amount)
          then 'bank_match_invalid'
        else null
      end as reason
    from fdh_liability_statement_activities a
    where a.user_id = p_user and a.statement_id = p_statement_id
      and a.ledger_disposition is null and a.ledger_transaction_id is null
  ) x
  where x.reason is not null;
$$ language sql stable security definer set search_path = public;

-- E.2 Complete the settlement between one bank debit and its facility leg.
-- Returns one of: 'linked', 'link_completed', 'already_linked', 'deferred'.
-- Raises on a verification failure (the caller's transaction rolls back).
create or replace function fdh10_internal_link_payment_leg(
  p_user uuid, p_activity_id uuid, p_bank_txn uuid, p_ledger_txn uuid, p_link_type text
) returns text as $$
declare
  v_act record;
  v_bank record;
  v_link record;
  v_outcome text;
  v_reclass text;
begin
  if p_link_type not in ('credit_card_settlement', 'loan_payment') then
    raise exception 'FDH10_LINK_INVALID_TYPE';
  end if;
  select id, user_id, amount, currency_code into v_act
    from fdh_liability_statement_activities where id = p_activity_id and user_id = p_user;
  if not found then raise exception 'FDH10_LINK_ACTIVITY_NOT_FOUND'; end if;

  select id, user_id, credit_debit, currency_original, amount_original, approval_status, dedup_status, user_override,
         economic_transaction_type
    into v_bank
    from fdh_transactions where id = p_bank_txn for update;
  if not found or v_bank.user_id <> p_user then
    raise exception 'FOREIGN_TRANSACTION';
  end if;
  if v_bank.credit_debit <> 'debit' or v_bank.currency_original <> v_act.currency_code or v_bank.amount_original <> v_act.amount then
    raise exception 'BANK_MATCH_INVALID';
  end if;
  -- A bank debit still awaiting its own statement's approval, or settled as
  -- a duplicate, is not linked now; the post-bank-approval back-match links
  -- it once it is approved.
  if v_bank.approval_status <> 'approved' or v_bank.dedup_status in ('duplicate_confirmed', 'user_confirmed_duplicate') then
    return 'deferred';
  end if;

  select * into v_link from fdh_transaction_links
   where user_id = p_user and transaction_id_from = p_bank_txn and transaction_id_to = p_ledger_txn
     and link_type in ('credit_card_settlement', 'loan_payment')
   limit 1;
  if found then
    if v_link.status <> 'confirmed' then
      update fdh_transaction_links set status = 'confirmed', user_confirmed = true, updated_at = now() where id = v_link.id;
    end if;
    v_outcome := 'already_linked';
  else
    -- The bank side's OPEN settlement candidate (transferMatching.openCandidateLink):
    -- completed in place, never duplicated (uq_fdh_links_open).
    select * into v_link from fdh_transaction_links
     where user_id = p_user and transaction_id_from = p_bank_txn and transaction_id_to is null
       and link_type in ('credit_card_settlement', 'loan_payment') and status in ('pending', 'confirmed')
     order by created_at limit 1
     for update;
    if found then
      update fdh_transaction_links
         set transaction_id_to = p_ledger_txn, link_type = p_link_type, status = 'confirmed', user_confirmed = true,
             created_by_method = 'system_rule', confidence = 1,
             match_evidence = coalesce(match_evidence, '{}'::jsonb) || jsonb_build_object('rule', 'fdh10_statement_payment_match', 'liability_activity_id', p_activity_id),
             updated_at = now()
       where id = v_link.id;
      v_outcome := 'link_completed';
    else
      insert into fdh_transaction_links (user_id, transaction_id_from, transaction_id_to, link_type, confidence, status,
                                         created_by_method, user_confirmed, match_evidence)
      values (p_user, p_bank_txn, p_ledger_txn, p_link_type, 1, 'confirmed', 'system_rule', true,
              jsonb_build_object('rule', 'fdh10_statement_payment_match', 'liability_activity_id', p_activity_id));
      v_outcome := 'linked';
    end if;
  end if;

  -- The bank leg is a transfer to the facility. A split the user made, or a
  -- row the user settled, is left exactly as it is.
  if not v_bank.user_override
     and v_bank.economic_transaction_type in ('unknown', 'expense', 'debt_principal', 'debt_interest', 'fee')
     and not exists (select 1 from fdh_transaction_allocations al where al.transaction_id = p_bank_txn) then
    v_reclass := fdh_internal_reclassify_corroborated_leg(p_user, p_bank_txn, 'transfer',
      'bank debit settles a card/loan statement repayment', 'liability_statement_activity', p_activity_id);
  end if;
  return v_outcome || case when v_reclass = 'reclassified' then '+reclassified' else '' end;
end;
$$ language plpgsql security definer set search_path = public;

-- E.3 THE LEDGER WRITER. Writes the statement's activities to its facility
-- account and returns what it did. Caller holds the statement row lock and
-- has set the internal-write GUC and checked fdh10_internal_ledger_blockers.
create or replace function fdh10_internal_write_statement_ledger(
  p_user uuid, p_statement_id uuid, p_liability_id uuid, p_owner text, p_acknowledge_unclassified boolean
) returns jsonb as $$
declare
  v_st record;
  v_liab record;
  v_account uuid;
  v_account_currency text;
  v_owner_role text;
  v_link_type text;
  v_act record;
  v_cd text;
  v_type text;
  v_header_type text;
  v_fp text;
  v_existing uuid;
  v_txn uuid;
  v_seq int;
  v_link_outcome text;
  v_created uuid[] := array[]::uuid[];
  v_duplicates uuid[] := array[]::uuid[];
  v_allocations int := 0;
  v_links int := 0;
  v_links_completed int := 0;
  v_links_deferred int := 0;
  v_reclassified int := 0;
  v_excluded int := 0;
begin
  select * into v_st from fdh_liability_statements where id = p_statement_id and user_id = p_user;
  if not found then raise exception 'FDH10_LEDGER_STATEMENT_NOT_FOUND'; end if;
  if v_st.ledger_status <> 'not_applied' then
    return jsonb_build_object('skipped', 'ledger_already_' || v_st.ledger_status);
  end if;
  select * into v_liab from liabilities where id = p_liability_id and user_id = p_user;
  if not found then raise exception 'FDH10_LEDGER_LIABILITY_NOT_FOUND'; end if;

  v_owner_role := coalesce(p_owner, case when v_liab.owner in ('self', 'spouse', 'joint', 'smsf') then v_liab.owner else null end);
  v_link_type := case when v_st.statement_type = 'credit_card' then 'credit_card_settlement' else 'loan_payment' end;

  -- Facility account: one per liability (0207 unique index), locked so two
  -- statements of the same facility cannot race the fingerprint check.
  select id, currency_code into v_account, v_account_currency
    from fdh_financial_accounts where user_id = p_user and liability_id = p_liability_id for update;
  if v_account is null then
    select id, currency_code into v_account, v_account_currency
      from fdh_financial_accounts where user_id = p_user and account_fingerprint = 'fdh10:liability:' || p_liability_id::text for update;
    if v_account is not null then
      update fdh_financial_accounts set liability_id = p_liability_id, updated_at = now() where id = v_account;
    end if;
  end if;
  if v_account is null then
    insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name, masked_identifier,
                                        account_fingerprint, status, last_statement_date, owner_role, liability_id)
    values (p_user, v_st.facility_type, coalesce(v_st.country_code, v_liab.country_code, case when v_st.currency_code = 'INR' then 'IN' else 'AU' end),
            v_st.currency_code, coalesce(nullif(trim(v_liab.liability_name), ''), 'Imported facility'), v_st.masked_identifier,
            'fdh10:liability:' || p_liability_id::text, 'active', coalesce(v_st.statement_period_end, v_st.statement_date), v_owner_role, p_liability_id)
    returning id, currency_code into v_account, v_account_currency;
  else
    update fdh_financial_accounts
       set owner_role = coalesce(v_owner_role, owner_role),
           last_statement_date = greatest(last_statement_date, coalesce(v_st.statement_period_end, v_st.statement_date)),
           updated_at = now()
     where id = v_account;
  end if;
  if v_account_currency <> v_st.currency_code then
    raise exception 'CURRENCY_MISMATCH';
  end if;

  -- One row per activity, oldest line first. `occurrence` separates two
  -- genuinely identical lines on the same statement (two $5 coffees) while
  -- still matching the same two lines on an overlapping statement.
  for v_act in
    select a.*,
           row_number() over (
             partition by a.activity_date, a.amount, a.activity_type, lower(btrim(regexp_replace(coalesce(a.description_raw, ''), '\s+', ' ', 'g')))
             order by a.source_row_number nulls last, a.id) as occurrence
      from fdh_liability_statement_activities a
     where a.user_id = p_user and a.statement_id = p_statement_id
     order by a.source_row_number nulls last, a.id
  loop
    if v_act.ledger_transaction_id is not null or v_act.ledger_disposition is not null then
      continue;
    end if;
    if v_act.activity_type in ('ADJUSTMENT', 'OTHER') then
      -- Only reached when the caller acknowledged them (blockers otherwise):
      -- recorded as explicitly NOT counted (disposition E), never guessed.
      update fdh_liability_statement_activities set ledger_disposition = 'excluded_unclassified', updated_at = now() where id = v_act.id;
      v_excluded := v_excluded + 1;
      continue;
    end if;

    -- LEDGER_MAPPING_BEGIN (mirrored by LIABILITY_LEDGER_MAPPING in
    -- lib/financial-data-hub/liability/creditCardEconomics.ts; parity test
    -- tests/unit/fdh10ApplyLedgerMapping.test.ts). Direction is the effect on
    -- the FACILITY balance: debit raises what is owed, credit lowers it.
    v_cd := case v_act.activity_type
      when 'PURCHASE' then 'debit'
      when 'REFUND' then 'credit'
      when 'PAYMENT' then 'credit'
      when 'CASH_ADVANCE' then 'debit'
      when 'INTEREST' then 'debit'
      when 'FEE' then 'debit'
      when 'PRINCIPAL' then 'credit'
      when 'LOAN_ADVANCE' then 'debit'
    end;
    v_type := case v_act.activity_type
      when 'PURCHASE' then 'expense'
      when 'REFUND' then 'refund'
      when 'PAYMENT' then 'transfer'
      when 'CASH_ADVANCE' then 'cash_withdrawal'
      when 'INTEREST' then 'debt_interest'
      when 'FEE' then 'fee'
      when 'PRINCIPAL' then 'debt_principal'
      when 'LOAN_ADVANCE' then 'transfer'
    end;
    -- LEDGER_MAPPING_END

    -- A PAYMENT with disclosed components (decomposeLoanPayment 'decomposed';
    -- the blockers refused 'component_mismatch'): header + allocations.
    v_header_type := v_type;
    if v_act.activity_type = 'PAYMENT'
       and (v_act.principal_component is not null or v_act.interest_component is not null or v_act.fee_component is not null) then
      v_header_type := case when coalesce(v_act.principal_component, 0) > 0 then 'debt_principal' else 'transfer' end;
    end if;

    v_fp := 'fdh10v1:' || md5(concat_ws('|', v_account::text, v_act.activity_date::text, to_char(v_act.amount, 'FM9999999999999990.0000'),
                                        v_act.currency_code, v_act.activity_type,
                                        lower(btrim(regexp_replace(coalesce(v_act.description_raw, ''), '\s+', ' ', 'g'))),
                                        v_act.occurrence::text));
    select id into v_existing from fdh_transactions
     where financial_account_id = v_account and economic_fingerprint = v_fp and user_id = p_user
     limit 1;
    if v_existing is not null then
      -- The same line on an overlapping statement of this facility: recorded,
      -- never inserted twice.
      update fdh_liability_statement_activities
         set ledger_disposition = 'duplicate_of_existing', ledger_duplicate_of_transaction_id = v_existing, updated_at = now()
       where id = v_act.id;
      v_duplicates := v_duplicates || v_act.id;
      continue;
    end if;

    insert into fdh_transactions (
      user_id, financial_account_id, statement_upload_id, transaction_date,
      description_raw, merchant_raw, amount_original, currency_original,
      credit_debit, economic_transaction_type, classification_method, classification_confidence,
      source_row, source_row_hash, economic_fingerprint, economic_fingerprint_version,
      review_status, approval_status, approved_at, approved_by
    ) values (
      p_user, v_account, v_st.statement_upload_id, v_act.activity_date,
      v_act.description_raw, v_act.merchant_raw, v_act.amount, v_act.currency_code,
      v_cd, v_header_type, 'source', 1,
      v_act.source_row_number, 'fdh10:act:' || v_act.id::text, v_fp, 'fdh10-ledger-v1',
      'not_required', 'approved', now(), p_user
    ) returning id into v_txn;
    v_created := v_created || v_txn;

    if v_header_type <> v_type or (v_act.activity_type = 'PAYMENT' and (v_act.principal_component is not null or v_act.interest_component is not null or v_act.fee_component is not null)) then
      v_seq := 0;
      if coalesce(v_act.principal_component, 0) > 0 then
        v_seq := v_seq + 1;
        insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code, note)
        values (p_user, v_txn, v_seq, 'debt_principal', v_act.principal_component, v_act.currency_code, 'statement-disclosed principal');
      end if;
      if coalesce(v_act.interest_component, 0) > 0 then
        v_seq := v_seq + 1;
        insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code, note)
        values (p_user, v_txn, v_seq, 'debt_interest', v_act.interest_component, v_act.currency_code, 'statement-disclosed interest');
      end if;
      if coalesce(v_act.fee_component, 0) > 0 then
        v_seq := v_seq + 1;
        insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code, note)
        values (p_user, v_txn, v_seq, 'fee', v_act.fee_component, v_act.currency_code, 'statement-disclosed fee');
      end if;
      v_allocations := v_allocations + v_seq;
    end if;

    update fdh_liability_statement_activities
       set ledger_transaction_id = v_txn, ledger_disposition = 'ledger_row', updated_at = now()
     where id = v_act.id;

    if v_act.activity_type in ('PAYMENT', 'PRINCIPAL') and v_act.bank_match_status = 'matched' and v_act.linked_transaction_id is not null then
      v_link_outcome := fdh10_internal_link_payment_leg(p_user, v_act.id, v_act.linked_transaction_id, v_txn, v_link_type);
      if v_link_outcome like 'linked%' then v_links := v_links + 1;
      elsif v_link_outcome like 'link_completed%' then v_links_completed := v_links_completed + 1;
      elsif v_link_outcome = 'deferred' then v_links_deferred := v_links_deferred + 1;
      end if;
      if v_link_outcome like '%+reclassified' then v_reclassified := v_reclassified + 1; end if;
    end if;
  end loop;

  update fdh_liability_statements
     set liability_id = p_liability_id, financial_account_id = v_account,
         ledger_status = 'applied', ledger_applied_at = now(), updated_at = now()
   where id = p_statement_id;

  return jsonb_build_object(
    'financial_account_id', v_account,
    'transactions_created', coalesce(array_length(v_created, 1), 0),
    'transaction_ids', to_jsonb(v_created),
    'duplicates_skipped', coalesce(array_length(v_duplicates, 1), 0),
    'duplicate_activity_ids', to_jsonb(v_duplicates),
    'allocations_created', v_allocations,
    'links_created', v_links,
    'links_completed', v_links_completed,
    'links_deferred', v_links_deferred,
    'bank_legs_reclassified', v_reclassified,
    'excluded_unclassified', v_excluded
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_internal_ledger_blockers(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function fdh10_internal_link_payment_leg(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function fdh10_internal_write_statement_ledger(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function fdh10_internal_ledger_blockers(uuid, uuid, boolean) to service_role;
grant execute on function fdh10_internal_link_payment_leg(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function fdh10_internal_write_statement_ledger(uuid, uuid, uuid, text, boolean) to service_role;

-- ============================================================================
-- F. THE APPLY RPC. Same name and the same three leading parameters, so every
--    existing caller keeps working; two DEFAULTED parameters are added (a
--    single function, not an overload, so PostgREST never sees two candidates).
--    Predecessor: 0096:766-976 (no later redefinition).
-- ============================================================================
drop function if exists fdh10_apply_liability_proposal(uuid, text, text[]);

create or replace function fdh10_apply_liability_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null,
  p_owner text default null,
  p_acknowledge_unclassified boolean default false
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_statement record;
  v_liability record;
  v_allowed constant text[] := array[
    'liability_name','debt_type','lender','currency_code','country_code',
    'balance','interest_rate','monthly_repayment','credit_limit',
    'masked_identifier','minimum_payment','due_date'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'liability_name','text','debt_type','enum','lender','text','currency_code','enum',
    'country_code','enum','balance','money','interest_rate','money',
    'monthly_repayment','money','credit_limit','money','masked_identifier','text',
    'minimum_payment','money','due_date','text'
  );
  -- The liability register's currency vocabulary (lib/validation/liability.ts
  -- currency_code enum). A statement in any other currency is refused (G13).
  v_liability_currencies constant text[] := array['AUD', 'INR'];
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_kind text;
  v_blockers jsonb;
  v_effects jsonb := null;
  v_run_ledger boolean;
  v_target_currency text;
  v_account_currency text;
  v_rejected int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh10_apply_liability_proposal: authentication required';
  end if;
  if p_decision is null or p_decision not in ('add_new','update_existing','apply_selected_fields','keep_existing','reject_statement') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;
  if p_owner is not null and p_owner not in ('self', 'spouse', 'joint', 'smsf') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_OWNER', 'error', 'Choose whose card or loan this is: you, your spouse, joint, or your SMSF.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'liability' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is for a part of your data this function does not handle.');
  end if;
  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied'
        then 'This proposal has already been applied to your liabilities.'
        else 'That proposal is no longer open.' end
    );
  end if;

  select * into v_statement from fdh_liability_statements
   where id = v_proposal.source_liability_statement_id and user_id = v_uid
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'The statement behind this proposal could not be found.');
  end if;
  if v_statement.approval_status <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Approve the statement details before applying them.');
  end if;

  -- ---------------------------------------------------------------- reject
  if p_decision = 'reject_statement' then
    if v_statement.ledger_status = 'applied' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'This statement''s activity has already been recorded.');
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id and status = 'ready';
    update fdh_liability_statements
       set ledger_status = 'rejected', ledger_rejected_reason = 'rejected_by_user', updated_at = now()
     where id = v_statement.id;
    update fdh_liability_statement_activities
       set ledger_disposition = 'rejected', updated_at = now()
     where statement_id = v_statement.id and user_id = v_uid and ledger_disposition is null and ledger_transaction_id is null;
    get diagnostics v_rejected = row_count;
    insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
    values (v_uid, v_statement.statement_upload_id, 'liability_statement_rejected', 'user', v_uid,
            jsonb_build_object('proposal_id', p_proposal_id, 'statement_id', v_statement.id, 'activities_rejected', v_rejected));
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'rejected_statement', 'activities_rejected', v_rejected);
  end if;

  if not (v_statement.currency_code = any (v_liability_currencies)) then
    return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_CURRENCY',
      'error', format('Statements in %s can''t be added to your liabilities yet. Only AUD and INR are supported, and amounts are never added across currencies.', v_statement.currency_code));
  end if;

  -- ------------------------------------------------------ keep existing
  if p_decision = 'keep_existing' then
    if v_proposal.target_entity_id is null then
      return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE',
        'error', 'There is no existing liability to keep. Add it as a new liability, or reject the statement.');
    end if;
    select * into v_liability from liabilities where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The liability this proposal refers to could not be found.');
    end if;
    v_target_id := v_liability.id;
    v_target_currency := v_liability.currency_code;
  else
    if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
      return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing liability to update.');
    end if;

    -- X-01: "update existing" with nothing ticked means the proposal's
    -- RECOMMENDED changes -- never a field that needs the user's explicit
    -- confirmation (a card's minimum payment is not its monthly repayment).
    if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
      select array_agg(field_name) into v_selected from fhip_import_proposal_fields
       where proposal_id = p_proposal_id and is_recommended and not requires_confirmation
         and proposed_value is distinct from existing_value;
    else
      v_selected := coalesce(p_selected_fields, array[]::text[]);
    end if;
    if v_selected is null then v_selected := array[]::text[]; end if;

    select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_allowed));
    if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
      return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields cannot be changed by an import.', 'fields', to_jsonb(v_forbidden));
    end if;

    select array_agg(field_name) into v_known from fhip_import_proposal_fields where proposal_id = p_proposal_id;
    if v_known is null then v_known := array[]::text[]; end if;
    select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_known));
    if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
      return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this proposal.', 'fields', to_jsonb(v_forbidden));
    end if;
    if array_length(v_selected, 1) is null or array_length(v_selected, 1) = 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one detail to apply.');
    end if;

    if p_decision = 'add_new' then
      if not ('liability_name' = any(v_selected)) or not ('debt_type' = any(v_selected))
         or not ('balance' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
        return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new liability needs a name, a type, a balance and a currency.');
      end if;
      select proposed_value into v_target_currency from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'currency_code';
    end if;

    if p_decision <> 'add_new' then
      select * into v_liability from liabilities where id = v_proposal.target_entity_id and user_id = v_uid for update;
      if not found then
        return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The liability this proposal refers to could not be found.');
      end if;
      v_target_currency := v_liability.currency_code;
      if 'currency_code' = any(v_selected) then
        select proposed_value into v_target_currency from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'currency_code';
      end if;

      for v_field in
        select pf.field_name, pf.value_kind, pf.existing_value
        from fhip_import_proposal_fields pf
        where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
      loop
        v_live_text := case v_field.field_name
          when 'liability_name'     then v_liability.liability_name
          when 'debt_type'          then v_liability.debt_type
          when 'lender'             then v_liability.lender
          when 'currency_code'      then v_liability.currency_code
          when 'country_code'       then v_liability.country_code
          when 'masked_identifier'  then v_liability.masked_identifier
          when 'due_date'           then case when v_liability.due_date is null then null else v_liability.due_date::text end
          when 'balance'            then case when v_liability.balance is null then null else round(v_liability.balance, 2)::text end
          when 'interest_rate'      then case when v_liability.interest_rate is null then null else round(v_liability.interest_rate, 2)::text end
          when 'monthly_repayment'  then case when v_liability.monthly_repayment is null then null else round(v_liability.monthly_repayment, 2)::text end
          when 'credit_limit'       then case when v_liability.credit_limit is null then null else round(v_liability.credit_limit, 2)::text end
          when 'minimum_payment'    then case when v_liability.minimum_payment is null then null else round(v_liability.minimum_payment, 2)::text end
          else null
        end;
        if v_field.value_kind in ('text', 'enum') then
          v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
        end if;
        if v_live_text is distinct from v_field.existing_value then
          return jsonb_build_object(
            'ok', false, 'code', 'STALE_PROPOSAL',
            'error', 'Your liability details changed after this proposal was prepared, so it was not applied.',
            'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text
          );
        end if;
        v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
      end loop;
    end if;
  end if;

  -- ------------------------------------------ every blocker, before any write
  v_run_ledger := v_statement.ledger_status = 'not_applied';
  if v_run_ledger then
    if v_target_currency is distinct from v_statement.currency_code then
      return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH',
        'error', format('This statement is in %s but the liability is in %s. Amounts are never added across currencies.', v_statement.currency_code, coalesce(v_target_currency, 'no currency')));
    end if;
    if v_target_id is not null or v_proposal.target_entity_id is not null then
      select currency_code into v_account_currency from fdh_financial_accounts
       where user_id = v_uid and liability_id = coalesce(v_target_id, v_proposal.target_entity_id);
      if v_account_currency is not null and v_account_currency <> v_statement.currency_code then
        return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH',
          'error', 'This card or loan already has statement activity in a different currency.');
      end if;
    end if;
    v_blockers := fdh10_internal_ledger_blockers(v_uid, v_statement.id, p_acknowledge_unclassified);
    if jsonb_array_length(v_blockers) > 0 then
      if exists (select 1 from jsonb_array_elements(v_blockers) b where b ->> 'reason' = 'foreign_transaction') then
        return jsonb_build_object('ok', false, 'code', 'FOREIGN_TRANSACTION',
          'error', 'A repayment on this statement is matched to a bank transaction that is not yours.', 'blockers', v_blockers);
      end if;
      return jsonb_build_object('ok', false, 'code', 'BLOCKING_REVIEW',
        'error', 'Some statement lines need your decision before this statement can be recorded.', 'blockers', v_blockers);
    end if;
  end if;

  -- ------------------------------------------------------------- writes
  perform set_config('fhip.import_bridge_internal_write', 'true', true);

  if p_decision = 'keep_existing' then
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id and status = 'ready';
    if not found then
      perform set_config('fhip.import_bridge_internal_write', 'false', true);
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is no longer open.');
    end if;
  else
    for v_field in
      select pf.field_name, pf.value_kind, pf.proposed_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_kind := v_kinds ->> v_field.field_name;
      if v_field.proposed_value is null then
        v_set_parts := array_append(v_set_parts, format('%I = NULL', v_field.field_name));
        v_cols := array_append(v_cols, v_field.field_name);
        v_vals := array_append(v_vals, 'NULL');
      elsif v_kind = 'money' then
        v_set_parts := array_append(v_set_parts, format('%I = %L::numeric', v_field.field_name, v_field.proposed_value));
        v_cols := array_append(v_cols, v_field.field_name);
        v_vals := array_append(v_vals, format('%L::numeric', v_field.proposed_value));
      elsif v_field.field_name = 'due_date' then
        v_set_parts := array_append(v_set_parts, format('%I = %L::date', v_field.field_name, v_field.proposed_value));
        v_cols := array_append(v_cols, v_field.field_name);
        v_vals := array_append(v_vals, format('%L::date', v_field.proposed_value));
      else
        v_set_parts := array_append(v_set_parts, format('%I = %L', v_field.field_name, v_field.proposed_value));
        v_cols := array_append(v_cols, v_field.field_name);
        v_vals := array_append(v_vals, format('%L', v_field.proposed_value));
      end if;
      v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
      v_applied_fields := array_append(v_applied_fields, v_field.field_name);
      if p_decision = 'add_new' then
        v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
      end if;
    end loop;

    update fhip_import_proposals set status = 'applied', applied_at = now()
      where id = p_proposal_id and status = 'ready';
    if not found then
      perform set_config('fhip.import_bridge_internal_write', 'false', true);
      return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your liabilities.');
    end if;

    if p_decision = 'add_new' then
      -- G8: the owner the user chose, never a hard-coded 'self'.
      v_cols := array_prepend('last_imported_at', array_prepend('source_type', array_prepend('is_active', array_prepend('owner', array_prepend('user_id', v_cols)))));
      v_vals := array_prepend('now()', array_prepend(format('%L', 'liability_statement_import'), array_prepend('true', array_prepend(format('%L', coalesce(p_owner, 'self')), array_prepend(format('%L::uuid', v_uid), v_vals)))));
      execute format('insert into liabilities (%s) values (%s) returning id', array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
    else
      v_target_id := v_proposal.target_entity_id;
      execute format('update liabilities set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid', array_to_string(v_set_parts, ', '), v_target_id, v_uid);
    end if;
  end if;

  -- The statement's activities become canonical events, in this transaction.
  if v_run_ledger then
    v_effects := fdh10_internal_write_statement_ledger(v_uid, v_statement.id, v_target_id, p_owner, p_acknowledge_unclassified);
  else
    v_effects := jsonb_build_object('skipped', 'ledger_already_' || v_statement.ledger_status);
  end if;

  if p_decision <> 'keep_existing' then
    insert into fhip_import_applications (
      user_id, proposal_id, target_domain, target_entity_id, apply_mode,
      applied_fields, previous_values, new_values, source_liability_statement_id, applied_by, ledger_effects
    ) values (
      v_uid, p_proposal_id, 'liability', v_target_id, p_decision,
      to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_liability_statement_id, v_uid, v_effects
    ) returning id into v_application_id;

    update liabilities
      set source_type = 'liability_statement_import', last_import_application_id = v_application_id, last_imported_at = now()
      where id = v_target_id and user_id = v_uid;
  end if;

  -- G12: provenance inside the transaction, tied to the document.
  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (v_uid, v_statement.statement_upload_id,
          case when p_decision = 'keep_existing' then 'liability_proposal_dismissed' else 'liability_proposal_applied' end,
          'user', v_uid,
          jsonb_build_object('proposal_id', p_proposal_id, 'decision', p_decision, 'statement_id', v_statement.id,
                             'target_entity_id', v_target_id, 'application_id', v_application_id));
  if v_run_ledger then
    insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
    values (v_uid, v_statement.statement_upload_id, 'liability_ledger_applied', 'user', v_uid,
            jsonb_build_object('statement_id', v_statement.id, 'liability_id', v_target_id,
                               'financial_account_id', v_effects -> 'financial_account_id',
                               'transactions_created', v_effects -> 'transactions_created',
                               'duplicates_skipped', v_effects -> 'duplicates_skipped',
                               'allocations_created', v_effects -> 'allocations_created',
                               'links_created', v_effects -> 'links_created',
                               'links_completed', v_effects -> 'links_completed',
                               'links_deferred', v_effects -> 'links_deferred',
                               'bank_legs_reclassified', v_effects -> 'bank_legs_reclassified',
                               'excluded_unclassified', v_effects -> 'excluded_unclassified'));
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  if p_decision = 'keep_existing' then
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing', 'target_entity_id', v_target_id, 'ledger', v_effects);
  end if;
  return jsonb_build_object(
    'ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id,
    'applied_fields', to_jsonb(v_applied_fields), 'ledger', v_effects
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_apply_liability_proposal(uuid, text, text[], text, boolean) from public;
revoke all on function fdh10_apply_liability_proposal(uuid, text, text[], text, boolean) from anon;
grant execute on function fdh10_apply_liability_proposal(uuid, text, text[], text, boolean) to authenticated, service_role;

-- ============================================================================
-- G. Record the ledger for a statement whose proposal was applied (or kept
--    against a liability) BEFORE this migration. Those statements' activities
--    reached no canonical figure; this is the user-visible way to record them
--    once ("Record this statement's activity" in Statement history). It does
--    not touch the liability's figures.
-- ============================================================================
create or replace function fdh10_record_liability_statement_ledger(
  p_statement_id uuid,
  p_owner text default null,
  p_acknowledge_unclassified boolean default false
) returns jsonb as $$
declare
  v_uid uuid := auth.uid();
  v_statement record;
  v_liability_id uuid;
  v_liability_currency text;
  v_blockers jsonb;
  v_effects jsonb;
begin
  if v_uid is null then
    raise exception 'fdh10_record_liability_statement_ledger: authentication required';
  end if;
  if p_owner is not null and p_owner not in ('self', 'spouse', 'joint', 'smsf') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_OWNER', 'error', 'Choose whose card or loan this is: you, your spouse, joint, or your SMSF.');
  end if;
  select * into v_statement from fdh_liability_statements where id = p_statement_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STATEMENT_NOT_FOUND', 'error', 'That statement could not be found.');
  end if;
  if v_statement.ledger_status <> 'not_applied' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This statement''s activity has already been recorded or rejected.');
  end if;
  if v_statement.approval_status <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Approve the statement details first.');
  end if;
  if not (v_statement.currency_code = any (array['AUD', 'INR'])) then
    return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_CURRENCY', 'error', 'Only AUD and INR statements can be recorded.');
  end if;
  -- The liability this statement was applied to (or kept against).
  select a.target_entity_id into v_liability_id
    from fhip_import_applications a
   where a.user_id = v_uid and a.source_liability_statement_id = v_statement.id
   order by a.applied_at desc nulls last limit 1;
  if v_liability_id is null then
    select p.target_entity_id into v_liability_id
      from fhip_import_proposals p
     where p.user_id = v_uid and p.source_liability_statement_id = v_statement.id and p.status = 'dismissed'
       and p.target_entity_id is not null and p.dismissed_at is not null
     order by p.dismissed_at desc limit 1;
  end if;
  if v_liability_id is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Apply this statement to a liability first.');
  end if;
  select currency_code into v_liability_currency from liabilities where id = v_liability_id and user_id = v_uid for update;
  if v_liability_currency is null then
    return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The liability this statement was applied to no longer exists.');
  end if;
  if v_liability_currency <> v_statement.currency_code then
    return jsonb_build_object('ok', false, 'code', 'CURRENCY_MISMATCH', 'error', 'The statement and the liability are in different currencies.');
  end if;
  v_blockers := fdh10_internal_ledger_blockers(v_uid, v_statement.id, p_acknowledge_unclassified);
  if jsonb_array_length(v_blockers) > 0 then
    return jsonb_build_object('ok', false,
      'code', case when exists (select 1 from jsonb_array_elements(v_blockers) b where b ->> 'reason' = 'foreign_transaction') then 'FOREIGN_TRANSACTION' else 'BLOCKING_REVIEW' end,
      'error', 'Some statement lines need your decision before this statement can be recorded.', 'blockers', v_blockers);
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  v_effects := fdh10_internal_write_statement_ledger(v_uid, v_statement.id, v_liability_id, p_owner, p_acknowledge_unclassified);
  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (v_uid, v_statement.statement_upload_id, 'liability_ledger_applied', 'user', v_uid,
          jsonb_build_object('statement_id', v_statement.id, 'liability_id', v_liability_id, 'recorded_after_apply', true,
                             'transactions_created', v_effects -> 'transactions_created',
                             'duplicates_skipped', v_effects -> 'duplicates_skipped',
                             'allocations_created', v_effects -> 'allocations_created',
                             'links_created', v_effects -> 'links_created'));
  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'recorded', 'target_entity_id', v_liability_id, 'ledger', v_effects);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_record_liability_statement_ledger(uuid, text, boolean) from public;
revoke all on function fdh10_record_liability_statement_ledger(uuid, text, boolean) from anon;
grant execute on function fdh10_record_liability_statement_ledger(uuid, text, boolean) to authenticated, service_role;

-- ============================================================================
-- H. Choose (or confirm) the bank debit that paid a statement repayment.
--    'user_pick'        -- the review picker for 'multiple_candidates' (G4):
--                          the debit must be one of the persisted candidates;
--                          null means "none of these".
--    'bank_back_match'  -- the post-bank-approval matcher (G4): a repayment
--                          with no bank evidence at extraction time, now that
--                          the bank statement is approved.
--    Either way the debit is re-verified (yours, a debit, same currency, same
--    amount, approved, not a duplicate, within 7 days, not already settling
--    another activity). If the activity is already in the ledger the
--    settlement link is written at once; otherwise the Apply writes it.
-- ============================================================================
create or replace function fdh10_match_liability_payment(
  p_activity_id uuid,
  p_bank_transaction_id uuid,
  p_method text
) returns jsonb as $$
declare
  v_uid uuid := auth.uid();
  v_act record;
  v_statement record;
  v_bank record;
  v_link_outcome text := null;
begin
  if v_uid is null then
    raise exception 'fdh10_match_liability_payment: authentication required';
  end if;
  if p_method is null or p_method not in ('user_pick', 'bank_back_match') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'error', 'Unrecognised match method.');
  end if;
  select * into v_act from fdh_liability_statement_activities where id = p_activity_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_NOT_FOUND', 'error', 'That statement line could not be found.');
  end if;
  if v_act.activity_type not in ('PAYMENT', 'PRINCIPAL') then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_REPAYMENT', 'error', 'Only a repayment line can be matched to a bank debit.');
  end if;
  if v_act.ledger_disposition in ('rejected', 'duplicate_of_existing', 'excluded_unclassified') then
    return jsonb_build_object('ok', false, 'code', 'NOT_ACTIONABLE', 'error', 'This statement line is not recorded, so it cannot be matched.');
  end if;
  select * into v_statement from fdh_liability_statements where id = v_act.statement_id and user_id = v_uid;

  if p_method = 'user_pick' then
    if v_act.bank_match_status <> 'multiple_candidates' then
      return jsonb_build_object('ok', false, 'code', 'NOT_ACTIONABLE', 'error', 'This repayment is not waiting for a choice.');
    end if;
    if p_bank_transaction_id is null then
      perform set_config('fhip.import_bridge_internal_write', 'true', true);
      update fdh_liability_statement_activities set bank_match_status = 'no_match', review_status = 'resolved', updated_at = now() where id = v_act.id;
      insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
      values (v_uid, v_statement.statement_upload_id, 'liability_bank_match_completed', 'user', v_uid,
              jsonb_build_object('activity_id', v_act.id, 'method', p_method, 'outcome', 'none_of_these'));
      perform set_config('fhip.import_bridge_internal_write', 'false', true);
      return jsonb_build_object('ok', true, 'outcome', 'none_of_these');
    end if;
    if v_act.bank_match_candidate_ids is null or not (p_bank_transaction_id = any (v_act.bank_match_candidate_ids)) then
      return jsonb_build_object('ok', false, 'code', 'NOT_A_CANDIDATE', 'error', 'That bank transaction was not one of the possible matches.');
    end if;
  else
    if v_act.bank_match_status = 'matched' or v_act.bank_match_status = 'multiple_candidates' then
      return jsonb_build_object('ok', false, 'code', 'NOT_ACTIONABLE', 'error', 'This repayment already has a bank match or is waiting for a choice.');
    end if;
  end if;

  select id, user_id, credit_debit, currency_original, amount_original, approval_status, dedup_status, transaction_date
    into v_bank from fdh_transactions where id = p_bank_transaction_id for update;
  if not found or v_bank.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'FOREIGN_TRANSACTION', 'error', 'That bank transaction could not be found.');
  end if;
  if v_bank.credit_debit <> 'debit' or v_bank.currency_original <> v_act.currency_code or v_bank.amount_original <> v_act.amount
     or v_bank.approval_status <> 'approved' or v_bank.dedup_status in ('duplicate_confirmed', 'user_confirmed_duplicate')
     or abs(v_bank.transaction_date - v_act.activity_date) > 7 then
    return jsonb_build_object('ok', false, 'code', 'BANK_MATCH_INVALID', 'error', 'That bank transaction does not match this repayment.');
  end if;
  if exists (select 1 from fdh_liability_statement_activities o
              where o.linked_transaction_id = p_bank_transaction_id and o.bank_match_status = 'matched' and o.id <> v_act.id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_MATCHED', 'error', 'That bank transaction already pays another statement line.');
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_liability_statement_activities
     set linked_transaction_id = p_bank_transaction_id, bank_match_status = 'matched',
         review_status = case when review_status in ('pending', 'in_review') then 'resolved' else review_status end,
         updated_at = now()
   where id = v_act.id;
  if v_act.ledger_transaction_id is not null then
    v_link_outcome := fdh10_internal_link_payment_leg(v_uid, v_act.id, p_bank_transaction_id, v_act.ledger_transaction_id,
      case when v_statement.statement_type = 'credit_card' then 'credit_card_settlement' else 'loan_payment' end);
  end if;
  insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, actor_id, metadata)
  values (v_uid, v_statement.statement_upload_id, 'liability_bank_match_completed',
          case when p_method = 'user_pick' then 'user' else 'system' end, case when p_method = 'user_pick' then v_uid else null end,
          jsonb_build_object('activity_id', v_act.id, 'bank_transaction_id', p_bank_transaction_id, 'method', p_method,
                             'link', v_link_outcome));
  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'matched', 'link', v_link_outcome);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh10_match_liability_payment(uuid, uuid, text) from public;
revoke all on function fdh10_match_liability_payment(uuid, uuid, text) from anon;
grant execute on function fdh10_match_liability_payment(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
