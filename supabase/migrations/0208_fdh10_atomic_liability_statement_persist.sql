-- 0208 -- FDH-10 liability EVIDENCE persistence: one atomic persist, one
-- statement per document, one bank debit per repayment, and the evidence the
-- old path dropped (work package WP-10 of the Approved Upload -> Canonical
-- programme; gaps G3, G4, G5, G6).
--
-- PROVENANCE OF THIS FILE. Sections 1-3 are a FORWARD PORT of migration 0198
-- on the unmerged branch `fix/fdh10-liability-zero-amount-atomic` (commit
-- 24281b8, 2026-09-25), renumbered because 0198 sorts before 0206 on main and
-- would be applied out of order. THAT BRANCH MUST NOT BE MERGED AS-IS: it
-- would add a second, older definition of the same function under 0198.
-- Every statement here is `create or replace` / `if not exists`, so this file
-- is correct whether or not 0198 was ever applied somewhere (DEV was checked
-- read-only on 2026-09-27: `fdh10_persist_liability_statement` is absent
-- there, and so are the 0207 columns this file writes).
--
-- DEPENDS ON 0207 (fdh_liability_statement_activities.gst_amount_raw and
-- .ledger_transaction_id, fdh_liability_statements.extraction_warnings).
--
-- ---------------------------------------------------------------------------
-- WHY (from 0198). `persistLiabilityStatementEvidence` wrote a statement in
-- N+2 separate PostgREST calls: one INSERT into `fdh_liability_statements`,
-- one INSERT per activity, then an UPDATE moving the document to
-- `extracted`. Observed live in DEV on 2026-09-25: a credit-card CSV with a
-- `0.00` line failed the first activity INSERT on 0096's `amount > 0` CHECK,
-- the route returned 500, and the already-committed statement row was left
-- behind with zero activities while the document stayed `queued`. The
-- user-scoped client CANNOT clean that up (0096 grants no DELETE on the
-- statement table, deliberately). A second defect rode along: the final
-- UPDATE jumped `queued -> extracted`, which 0076's
-- `trg_fdh7_guard_document_processing_status` forbids, and its error was
-- ignored -- so every SUCCESSFUL persist also left the document `queued`, and
-- a reload re-ran /process and inserted a SECOND statement for the document
-- (then `maybeSingle()` errored and review/approve answered 404).
--
-- WHAT THIS FILE DOES
--   1. `fdh10_persist_liability_statement` (SECURITY INVOKER): the statement,
--      every activity and the two legal status steps `queued -> processing ->
--      extracted` in ONE transaction, under a per-document advisory lock,
--      refusing with EVIDENCE_EXISTS rather than writing a second statement.
--      Now also persists the 0207 evidence columns (`extraction_warnings`,
--      `gst_amount_raw`), `adjustments_total`, `capitalised_total` and the
--      bank-match candidate ids (G5, G6, G4).
--   2. `bank_match_candidate_ids uuid[]` on the activities: when more than
--      one bank debit could be the repayment, the ids are KEPT so the review
--      screen can offer a picker (WP-11) instead of a dead-end label (G4).
--   3. Two unique indexes, each behind a pre-check that fails LOUDLY:
--        uq_fdh_liability_statements_upload_0208   one statement per document
--        uq_fdh_liability_activities_bank_txn_0208 one bank debit settles at
--                                                  most one activity (G4)
--   4. 0096's F.2 authoritative-write trigger, EXTENDED (strict superset of
--      its only predecessor, 0096:462-487) to protect the new/0207 columns.
--
-- IF A PRE-CHECK FAILS. The migration raises and applies nothing. The data
-- is a PO decision (production writes are run by the PO); these read-only
-- queries list what blocks the index:
--   -- statements sharing a document (keep the one with activities / approved):
--   select statement_upload_id, array_agg(id order by created_at) ids,
--          array_agg(approval_status order by created_at) approvals
--     from fdh_liability_statements where statement_upload_id is not null
--    group by statement_upload_id having count(*) > 1;
--   -- one bank debit matched by several activities:
--   select linked_transaction_id, array_agg(id order by created_at) activity_ids
--     from fdh_liability_statement_activities
--    where bank_match_status = 'matched' and linked_transaction_id is not null
--    group by linked_transaction_id having count(*) > 1;
-- The prepared remedy for the SECOND case (safe: evidence stays, only the
-- ambiguous match is withdrawn back to review), to be run by the PO as the
-- service role, never by an agent:
--   update fdh_liability_statement_activities a set bank_match_status = 'multiple_candidates',
--          bank_match_candidate_ids = array[a.linked_transaction_id], linked_transaction_id = null,
--          review_status = 'pending'
--    where a.bank_match_status = 'matched' and a.linked_transaction_id in (<ids from the query>);
-- The FIRST case has no safe generic remedy (which statement is the true one
-- is a judgement); the orphan left by the 2026-09-25 incident has 0
-- activities and is never approved, so it is the one to remove.
--
-- ADDITIVE ONLY. One nullable column, two unique partial indexes, two
-- replaced functions whose behaviour for every existing caller is a strict
-- superset. No row is rewritten; the `amount > 0` CHECK is not weakened (a
-- zero-amount line is excluded at extraction with a recorded warning).
--
-- MIGRATION NUMBER. Pre-assigned to WP-10 by the programme plan (0207-0214 are
-- reserved per package). Collision scan of every local and remote ref plus
-- every worktree's working directory on 2026-09-27: no other 0208.
--
-- IDEMPOTENT. A second apply is a no-op (scripts/fdh10_0208_pglite_verification.mjs).

-- ============================================================================
-- 2. Candidate ids for a repayment that could match more than one bank debit.
-- ============================================================================
alter table fdh_liability_statement_activities
  add column if not exists bank_match_candidate_ids uuid[];

-- ============================================================================
-- 3. Uniqueness, with loud pre-checks.
-- ============================================================================
do $$
declare
  v_dup_docs int;
  v_dup_txns int;
begin
  select count(*) into v_dup_docs from (
    select statement_upload_id from fdh_liability_statements
     where statement_upload_id is not null
     group by statement_upload_id having count(*) > 1) d;
  if v_dup_docs > 0 then
    raise exception '0208 PRE-CHECK FAILED: % document(s) have more than one fdh_liability_statements row; see this file''s header for the query and the PO remedy. Nothing was applied.', v_dup_docs;
  end if;
  select count(*) into v_dup_txns from (
    select linked_transaction_id from fdh_liability_statement_activities
     where bank_match_status = 'matched' and linked_transaction_id is not null
     group by linked_transaction_id having count(*) > 1) d;
  if v_dup_txns > 0 then
    raise exception '0208 PRE-CHECK FAILED: % bank transaction(s) are matched to more than one liability activity; see this file''s header for the query and the PO remedy. Nothing was applied.', v_dup_txns;
  end if;
end $$;

create unique index if not exists uq_fdh_liability_statements_upload_0208
  on fdh_liability_statements(statement_upload_id) where statement_upload_id is not null;

create unique index if not exists uq_fdh_liability_activities_bank_txn_0208
  on fdh_liability_statement_activities(linked_transaction_id)
  where bank_match_status = 'matched' and linked_transaction_id is not null;

-- ============================================================================
-- 4. F.2 authoritative-write trigger on activities, EXTENDED.
--    Predecessor: 0096:462-487 (the only definition before this file). Every
--    column it protected is still protected; three are added.
-- ============================================================================
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
     -- Added by 0208: the evidence and ledger columns are system-derived too.
     or new.bank_match_candidate_ids is distinct from old.bank_match_candidate_ids
     or new.gst_amount_raw is distinct from old.gst_amount_raw
     or new.ledger_transaction_id is distinct from old.ledger_transaction_id
  then
    raise exception 'fdh_liability_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- 1. The atomic persist (0198, extended).
-- ============================================================================
create or replace function public.fdh10_persist_liability_statement(
  p_statement_upload_id uuid,
  p_statement jsonb,
  p_activities jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
  v_existing uuid;
  v_statement_id uuid;
  v_activity_count int;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED', 'error', 'not authenticated');
  end if;
  if p_statement_upload_id is null or p_statement is null or jsonb_typeof(p_statement) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'statement payload must be an object');
  end if;
  if p_activities is null or jsonb_typeof(p_activities) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'activities payload must be an array');
  end if;
  if p_statement ? 'extraction_warnings' and jsonb_typeof(p_statement -> 'extraction_warnings') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PAYLOAD', 'error', 'extraction_warnings must be an array');
  end if;

  -- Serialise concurrent persists for the same document for the rest of this
  -- transaction, so the existence check below cannot race (the unique index
  -- is the backstop).
  perform pg_advisory_xact_lock(hashtextextended('fdh10_persist_liability_statement:' || p_statement_upload_id::text, 0));

  select processing_status into v_status
  from fdh_statement_uploads
  where id = p_statement_upload_id and user_id = v_user;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DOCUMENT_NOT_FOUND', 'error', 'document not found');
  end if;
  if v_status <> 'queued' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'error', 'cannot persist while the document is ' || v_status);
  end if;

  select id into v_existing
  from fdh_liability_statements
  where statement_upload_id = p_statement_upload_id and user_id = v_user
  limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_EXISTS', 'error', 'statement evidence already exists for this document', 'statement_id', v_existing);
  end if;

  -- Closed column list: approval, review-workflow, ledger, duplicate and
  -- correction-provenance columns cannot be set through this function.
  insert into fdh_liability_statements (
    user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code,
    institution_name, masked_identifier,
    statement_period_start, statement_period_end, statement_date, due_date,
    opening_balance, closing_balance, credit_limit, minimum_payment,
    opening_principal, closing_principal, interest_rate,
    purchases_total, cash_advances_total, interest_total, fees_total, payments_total,
    refunds_total, adjustments_total, drawdowns_total, capitalised_total, principal_repayments_total,
    reconciliation_status, reconciliation_variance,
    parser_name, parser_version, extraction_confidence, review_status,
    extraction_warnings
  )
  select
    v_user, p_statement_upload_id, s.statement_type, s.facility_type, s.country_code, s.currency_code,
    s.institution_name, s.masked_identifier,
    s.statement_period_start, s.statement_period_end, s.statement_date, s.due_date,
    s.opening_balance, s.closing_balance, s.credit_limit, s.minimum_payment,
    s.opening_principal, s.closing_principal, s.interest_rate,
    s.purchases_total, s.cash_advances_total, s.interest_total, s.fees_total, s.payments_total,
    s.refunds_total, s.adjustments_total, s.drawdowns_total, s.capitalised_total, s.principal_repayments_total,
    coalesce(s.reconciliation_status, 'insufficient_data'), s.reconciliation_variance,
    s.parser_name, s.parser_version, s.extraction_confidence, coalesce(s.review_status, 'not_required'),
    coalesce(p_statement -> 'extraction_warnings', '[]'::jsonb)
  from jsonb_populate_record(null::fdh_liability_statements, p_statement) s
  returning id into v_statement_id;

  insert into fdh_liability_statement_activities (
    user_id, statement_id, activity_type, activity_date, amount, currency_code,
    description_raw, merchant_raw, principal_component, interest_component, fee_component,
    linked_transaction_id, bank_match_status, review_status, source_row_number,
    gst_amount_raw, bank_match_candidate_ids
  )
  select
    v_user, v_statement_id, a.activity_type, a.activity_date, a.amount, a.currency_code,
    a.description_raw, a.merchant_raw, a.principal_component, a.interest_component, a.fee_component,
    a.linked_transaction_id, coalesce(a.bank_match_status, 'not_attempted'), coalesce(a.review_status, 'not_required'),
    a.source_row_number,
    a.gst_amount_raw, a.bank_match_candidate_ids
  from jsonb_populate_recordset(null::fdh_liability_statement_activities, p_activities) a;
  get diagnostics v_activity_count = row_count;

  -- Two legal edges of 0076's transition guard, never the illegal direct
  -- `queued -> extracted` jump.
  update fdh_statement_uploads
  set processing_status = 'processing'
  where id = p_statement_upload_id and user_id = v_user;
  update fdh_statement_uploads
  set processing_status = 'extracted', error_code = null, processing_completed_at = now()
  where id = p_statement_upload_id and user_id = v_user;

  return jsonb_build_object('ok', true, 'statement_id', v_statement_id, 'activity_count', v_activity_count);
end;
$$;

revoke all on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) from public;
revoke all on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) from anon;
grant execute on function public.fdh10_persist_liability_statement(uuid, jsonb, jsonb) to authenticated, service_role;
