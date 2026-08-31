-- =============================================================================
-- FDH-12 — HOTFIX: fdh12_approve_retirement_statement() could never succeed.
--
-- FOUND BY LIVE-DEV CERTIFICATION, 2026-08-30, against real hosted DEV Postgres
-- after migration 0112 was applied. Not reachable in the PGlite harness, which
-- had set `approval_status = 'approved'` directly as the service role rather
-- than invoking the RPC — so the RPC's own write path had never actually run.
--
-- -----------------------------------------------------------------------------
-- THE DEFECT
-- -----------------------------------------------------------------------------
-- 0112 PART F guards `fdh_retirement_statements`' system-authoritative columns
-- with the FDH-11 mechanism:
--
--     if auth.role() <> 'authenticated' then return new; end if;
--     ... raise on approval_status / approved_at / approved_by / ...
--
-- That mechanism is correct when the legitimate writer is a service-role
-- client, which is how the processing service writes every other authoritative
-- column on this table.
--
-- But ONE legitimate writer of this table is not a service-role client: it is
-- `fdh12_approve_retirement_statement()`, a SECURITY DEFINER function that the
-- END USER invokes. `security definer` changes the EXECUTING ROLE; it does NOT
-- change `auth.role()`, which reads the request's JWT claims and still reports
-- `'authenticated'`. So the trigger fired on the RPC's own UPDATE and refused
-- it:
--
--     fdh_retirement_statements: this field is system-authoritative and may
--     not be written directly by the authenticated role
--
-- The function also refuses the service role outright (`auth.uid() is null` ->
-- 'authentication required'), so there was NO caller at all that could approve
-- a retirement statement. Reproduced live on DEV:
--
--     RPC as the row's owner  -> 400 P0001 (message above); approval_status
--                                remained 'pending'
--     RPC as the service role -> 400 'authentication required'
--
-- Consequence: approval_status could never leave 'pending'; `/proposal`
-- therefore always returned 409 "Approve the statement evidence before
-- comparing it with your retirement accounts"; no proposal could be generated;
-- `fdh12_apply_retirement_proposal()` could never be reached. The entire
-- FDH-12 user journey terminated at Approve, and canonical Retirement could
-- never be updated from a retirement statement.
--
-- -----------------------------------------------------------------------------
-- THE FIX — the project's OWN established mechanism, applied where 0112's
-- header already said it belonged
-- -----------------------------------------------------------------------------
-- 0112's own header documents the two guards and when each is correct:
--
--   * FDH-11 style (`auth.role()`)  — for a service-role writer.
--   * FDH-9/FDH-10 style (the transaction-local GUC
--     `fhip.import_bridge_internal_write`) — for a SECURITY DEFINER function
--     that can set the GUC.
--
-- It then applied only the first style to this table, while giving the table a
-- definer-RPC writer. This migration adds the second style alongside the
-- first — exactly as `fdh10_liability_statements_assert_authoritative_write()`
-- (0096) and FDH-9's guards (0091) already do — and has the approve RPC set
-- the GUC around its single UPDATE.
--
-- WHY THIS DOES NOT WEAKEN SPEC SECTION 96. `set_config(..., true)` is
-- TRANSACTION-LOCAL. PostgREST runs one statement per request in its own
-- transaction, and exposes no way for a client to set an arbitrary `fhip.*`
-- GUC: the only writers are these SECURITY DEFINER functions, each of which
-- sets it true, performs its own specific write, and sets it false again
-- before returning. A direct REST PATCH of `approval_status`,
-- `reconciliation_status`, `account_match_status` or any other authoritative
-- column by the row's own owner is refused exactly as before — verified live
-- both before and after this migration.
--
-- IDEMPOTENT. `create or replace function` throughout; no schema change, no
-- data change, no new object. Safe to re-run.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. The guard now recognises BOTH legitimate writers.
-- ---------------------------------------------------------------------------
create or replace function fdh12_retirement_statements_assert_authoritative_write() returns trigger as $$
begin
  -- A SECURITY DEFINER FDH-12 function performing its own sanctioned write
  -- (currently only fdh12_approve_retirement_statement()). Transaction-local
  -- and set/cleared by that function itself — see the header.
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true' then
    return new;
  end if;
  -- The service-role processing service, which bypasses RLS by construction.
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.canonical_account_id is distinct from old.canonical_account_id
     or new.retirement_member_id is distinct from old.retirement_member_id
     or new.statement_type is distinct from old.statement_type
     or new.retirement_jurisdiction is distinct from old.retirement_jurisdiction
     or new.account_type is distinct from old.account_type
     or new.currency_code is distinct from old.currency_code
     or new.opening_balance is distinct from old.opening_balance
     or new.closing_balance is distinct from old.closing_balance
     or new.employer_contributions is distinct from old.employer_contributions
     or new.personal_contributions is distinct from old.personal_contributions
     or new.salary_sacrifice is distinct from old.salary_sacrifice
     or new.government_contributions is distinct from old.government_contributions
     or new.rollovers_in is distinct from old.rollovers_in
     or new.rollovers_out is distinct from old.rollovers_out
     or new.withdrawals is distinct from old.withdrawals
     or new.pension_payments is distinct from old.pension_payments
     or new.investment_earnings is distinct from old.investment_earnings
     or new.fees is distinct from old.fees
     or new.insurance_premiums is distinct from old.insurance_premiums
     or new.tax is distinct from old.tax
     or new.ytd_employer_contributions is distinct from old.ytd_employer_contributions
     or new.ytd_personal_contributions is distinct from old.ytd_personal_contributions
     or new.parser is distinct from old.parser
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.extraction_status is distinct from old.extraction_status
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.account_match_status is distinct from old.account_match_status
     or new.account_match_candidates is distinct from old.account_match_candidates
     or new.smsf_classification is distinct from old.smsf_classification
     or new.smsf_evidence is distinct from old.smsf_evidence
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
  then
    raise exception 'fdh_retirement_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ---------------------------------------------------------------------------
-- 2. The approve RPC declares its sanctioned write.
--
-- Body identical to 0112 PART H apart from the two set_config() calls that
-- bracket the single UPDATE, and the matching clear on the not-found path.
-- Every refusal it already made — SMSF routed, SMSF review required, not
-- extracted, unresolved review items, cross-tenant, unauthenticated — is
-- unchanged and still evaluated BEFORE the GUC is ever set.
-- ---------------------------------------------------------------------------
create or replace function fdh12_approve_retirement_statement(p_statement_id uuid)
returns jsonb as $$
declare
  v_uid uuid;
  v_stmt record;
  v_unresolved int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh12_approve_retirement_statement: authentication required';
  end if;

  select * into v_stmt from fdh_retirement_statements
    where id = p_statement_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'That retirement statement could not be found.');
  end if;

  if v_stmt.approval_status = 'approved' then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_APPROVED');
  end if;

  -- spec 11: an SMSF-routed statement is terminal for FDH-12.
  if v_stmt.smsf_classification = 'routed_to_smsf' then
    return jsonb_build_object('ok', false, 'code', 'ROUTED_TO_SMSF',
      'error', 'This looks like a self-managed super fund statement. Manage it in the SMSF section instead.');
  end if;
  if v_stmt.smsf_classification = 'possible_smsf' then
    return jsonb_build_object('ok', false, 'code', 'SMSF_REVIEW_REQUIRED',
      'error', 'We could not tell whether this is a self-managed super fund statement. Confirm before continuing.');
  end if;

  if v_stmt.extraction_status <> 'extracted' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EXTRACTED',
      'error', 'This statement has not been read successfully yet.');
  end if;

  -- Unresolved review items block approval (spec 27, 66, 80).
  select count(*) into v_unresolved from fdh_retirement_statement_activities
    where statement_id = p_statement_id
      and (payslip_match_status in ('multiple_candidates', 'variance_review_required')
           or bank_match_status = 'multiple_candidates'
           or review_status in ('pending', 'in_review'));
  if v_unresolved > 0 then
    return jsonb_build_object('ok', false, 'code', 'REVIEW_REQUIRED',
      'error', format('%s item(s) still need your review before this statement can be approved.', v_unresolved));
  end if;

  -- THE ONE SANCTIONED AUTHORITATIVE WRITE. Scoped as tightly as the FDH-9 and
  -- FDH-10 equivalents: set immediately before, cleared immediately after, and
  -- transaction-local either way.
  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_retirement_statements
    set approval_status = 'approved', approved_at = now(), approved_by = v_uid,
        review_status = case when review_status in ('pending', 'in_review') then 'resolved' else review_status end,
        updated_at = now()
    where id = p_statement_id and user_id = v_uid and approval_status = 'pending';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPROVED', 'error', 'This statement was already approved.');
  end if;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object('ok', true, 'code', 'APPROVED');
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh12_approve_retirement_statement(uuid) from public;
grant execute on function fdh12_approve_retirement_statement(uuid) to authenticated, service_role;

comment on function fdh12_approve_retirement_statement(uuid) is
  'FDH-12: the ONE legitimate way to move a retirement statement to approval_status = approved (spec section 56). Canonical Retirement is untouched. Sets fhip.import_bridge_internal_write around its single UPDATE so migration 0112 PART F''s authoritative-write guard recognises it as a sanctioned definer write rather than a direct client PATCH (fixed in migration 0113).';
