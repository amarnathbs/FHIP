-- FDH-10 — atomic liability statement persist (2026-09-25).
--
-- WHY THIS MIGRATION EXISTS. `persistLiabilityStatementEvidence`
-- (lib/financial-data-hub/services/liabilityStatementProcessingService.ts)
-- wrote a statement in N+2 separate PostgREST calls: one INSERT into
-- `fdh_liability_statements`, one INSERT per activity into
-- `fdh_liability_statement_activities`, then an UPDATE moving the document to
-- `extracted`. Each call is its own transaction. Observed live in DEV on
-- 2026-09-25: a credit-card CSV with a `0.00` line
-- (tests/fixtures/financial-data-hub/fdh14-smoke-liability-cc.csv) failed
-- the first activity INSERT on 0096's `amount > 0` CHECK, the route returned
-- 500, and the already-committed statement row was left behind with zero
-- activities while the document stayed `queued`. The user-scoped client
-- CANNOT clean that up: 0096 grants SELECT/INSERT/UPDATE on
-- `fdh_liability_statements` but deliberately no DELETE, so a compensating
-- delete from the application silently removes 0 rows. Adding a DELETE policy
-- to make compensation possible would let any user delete their own
-- (including approved) statement evidence; this migration does not do that.
--
-- WHAT THIS MIGRATION ADDS. One function, `fdh10_persist_liability_statement`,
-- that performs all three writes inside the single transaction PostgREST
-- opens for an RPC call. Any failure — a CHECK violation, the 0096 owner
-- triggers, the 0108 country-confirmation trigger, anything — raises and
-- rolls back the statement row together with every activity row and the
-- document status change. There is no intermediate state to leak.
--
-- SECURITY INVOKER, DELIBERATELY. The function runs as the calling
-- `authenticated` user, so every existing RLS policy and every existing
-- BEFORE trigger on all three tables applies exactly as it did to the
-- separate calls it replaces. It grants no privilege the caller did not
-- already have; it only removes the gaps between the writes. `user_id` is
-- taken from `auth.uid()`, never from the payload, and the column lists are
-- closed: approval, review-workflow and duplicate/supersedes columns cannot
-- be set through this function at all.
--
-- SECOND DEFECT FIXED HERE: THE DOCUMENT NEVER REACHED `extracted`. The
-- final UPDATE of the old sequence moved the document straight from `queued`
-- to `extracted`. Migration 0076's `trg_fdh7_guard_document_processing_status`
-- permits `queued -> processing -> extracted` but NOT `queued -> extracted`,
-- and the service never wrote `processing` and ignored the UPDATE's error. So
-- every SUCCESSFUL liability statement persist also left its document
-- `queued` with `processing_completed_at` null. Seen on DEV 2026-09-25:
-- upload 33f47e18-... has a complete statement (2 activities, a
-- `liability_statement_extraction_completed` audit event) and is still
-- `queued`. This function makes both legal steps, `queued -> processing` then
-- `processing -> extracted`, inside the same transaction. No other session
-- can ever observe the intermediate `processing`, and the 0076 guard is
-- honoured, not bypassed. Only a `queued` document is accepted.
-- `uploaded -> processing` is not a legal edge in either 0076 or
-- `documentLifecycle.ts`.
--
-- ONE STATEMENT PER DOCUMENT. 0096 has no unique constraint on
-- `statement_upload_id` (only a plain index), and a retry after the failure
-- above would have added a second row next to the orphan. The function takes
-- a transaction-scoped advisory lock keyed on the document, then refuses with
-- `EVIDENCE_EXISTS` when a statement already exists for it. A unique index is
-- NOT added here: DEV already holds at least one orphan row for a document
-- that may be retried, and an index build that fails on existing duplicates
-- would block this whole migration. The lock + check gives the same guarantee
-- for every write that goes through this function.
--
-- EXISTING DEV ROW NOT REPAIRED BY THIS MIGRATION. The `queued`-with-evidence
-- upload named above is data, not schema. This function refuses to write a
-- second statement for it (`EVIDENCE_EXISTS`), which is correct, but moving
-- that upload to `extracted` is a separate operator decision.
--
-- ADDITIVE ONLY. One new function and its grants. No table, column,
-- constraint, index, policy, trigger or row is changed. In particular the
-- `amount > 0` CHECK on `fdh_liability_statement_activities` is NOT weakened:
-- a zero-amount line is excluded (with a recorded warning) at extraction,
-- and this function lets the CHECK stay the final guard.
--
-- MIGRATION NUMBER. Chosen after scanning every added migration filename
-- reachable from every local and remote-tracking ref
-- (`git log --all --diff-filter=A --name-only -- supabase/migrations`) and the
-- working directory of every registered worktree on this machine. The highest
-- claimed number anywhere is 0197 (`feat/aie1-final-production-completion`
-- holds 0195-0197, unmerged). This file takes **0198**.
--
-- STATUS: DRAFTED, NOT APPLIED to any environment. The application code on
-- this branch calls this function, so it must be applied (DEV first, then
-- production) BEFORE the branch is merged. Until then every liability
-- statement persist fails with a controlled `internal_error`.

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

  -- Serialise concurrent persists for the same document for the rest of this
  -- transaction, so the existence check below cannot race.
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

  insert into fdh_liability_statements (
    user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code,
    institution_name, masked_identifier,
    statement_period_start, statement_period_end, statement_date, due_date,
    opening_balance, closing_balance, credit_limit, minimum_payment,
    opening_principal, closing_principal, interest_rate,
    purchases_total, cash_advances_total, interest_total, fees_total, payments_total,
    refunds_total, drawdowns_total, principal_repayments_total,
    reconciliation_status, reconciliation_variance,
    parser_name, parser_version, extraction_confidence, review_status
  )
  select
    v_user, p_statement_upload_id, s.statement_type, s.facility_type, s.country_code, s.currency_code,
    s.institution_name, s.masked_identifier,
    s.statement_period_start, s.statement_period_end, s.statement_date, s.due_date,
    s.opening_balance, s.closing_balance, s.credit_limit, s.minimum_payment,
    s.opening_principal, s.closing_principal, s.interest_rate,
    s.purchases_total, s.cash_advances_total, s.interest_total, s.fees_total, s.payments_total,
    s.refunds_total, s.drawdowns_total, s.principal_repayments_total,
    coalesce(s.reconciliation_status, 'insufficient_data'), s.reconciliation_variance,
    s.parser_name, s.parser_version, s.extraction_confidence, coalesce(s.review_status, 'not_required')
  from jsonb_populate_record(null::fdh_liability_statements, p_statement) s
  returning id into v_statement_id;

  insert into fdh_liability_statement_activities (
    user_id, statement_id, activity_type, activity_date, amount, currency_code,
    description_raw, merchant_raw, principal_component, interest_component, fee_component,
    linked_transaction_id, bank_match_status, review_status, source_row_number
  )
  select
    v_user, v_statement_id, a.activity_type, a.activity_date, a.amount, a.currency_code,
    a.description_raw, a.merchant_raw, a.principal_component, a.interest_component, a.fee_component,
    a.linked_transaction_id, coalesce(a.bank_match_status, 'not_attempted'), coalesce(a.review_status, 'not_required'),
    a.source_row_number
  from jsonb_populate_recordset(null::fdh_liability_statement_activities, p_activities) a;
  get diagnostics v_activity_count = row_count;

  -- Two legal edges of 0076's transition guard, never the illegal direct
  -- `queued -> extracted` jump (see the header).
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
