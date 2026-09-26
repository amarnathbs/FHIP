-- =============================================================================
-- 0212 -- Approved Upload -> Canonical User Data programme, WP-08: bank
-- statement approval integrity.
-- =============================================================================
-- Four things, each closing a defect the programme's stage-1 map proved on
-- origin/main (APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md, gap register):
--
--   A. EXP-G4 -- a resolved duplicate ('removed_b' leaves side b as
--      dedup_status = 'user_confirmed_duplicate') kept blocking its statement
--      forever when it was still 'unknown', and was cascade-APPROVED when it
--      was classified, so the purchase counted twice on every reader that
--      does not filter dedup_status. The statement-level blocking check now
--      ignores excluded duplicates, and so does the transaction-level one:
--      an excluded duplicate carries no financial meaning, so nothing about
--      it can block anything. (Approving it is still refused by the
--      application -- see fdh7_bulk_approve_transactions below, which never
--      approves one.)
--      PREDECESSORS (derived from the ledger, not assumed): both functions
--      were created by 0076; fdh7_transaction_has_blocking_issue was replaced
--      by 0085 and by nothing since; fdh7_statement_has_blocking_issue has
--      never been replaced. The bodies below repeat those predecessors
--      verbatim and add ONLY the duplicate predicate.
--
--   B. EXP-G5 -- splitting a transaction deleted its allocations and then
--      inserted the new ones one request at a time: two concurrent saves
--      interleaved into a mixed set, a failure half-way left a partial split,
--      an APPROVED transaction could be re-split without reopening its
--      statement, and an allocation typed 'unknown' was accepted.
--      fdh8_replace_transaction_allocations does the whole replace in ONE
--      transaction, holding the parent row lock (FOR UPDATE) so concurrent
--      replaces serialise, and refuses an approved parent and 'unknown' lines.
--      A BEFORE trigger on fdh_transaction_allocations is the un-bypassable
--      gate behind it: no insert/update/delete of an allocation while its
--      parent is approved (a forged direct PostgREST request included),
--      except inside a server-side import-bridge write that has set the
--      0207 internal-write GUC (the WP-11 ledger Apply seam).
--
--   C. EXP-G8 -- approving a statement ran ~3 sequential round trips per
--      line and read the lines with an unpaged select capped at 1,000 rows,
--      so line 1,001 of a 1,001-line statement was never approved while the
--      statement was. fdh7_bulk_approve_transactions approves a list of the
--      caller's lines in ONE set-based UPDATE (the per-row approval guard
--      trigger still fires for every row) and reports exactly which ids were
--      approved, blocked, already approved, skipped as excluded duplicates
--      or not found.
--
-- NOT TOUCHED: every shared CHECK constraint (no error_code, event_type,
-- review_type or check_code value is added -- 0207 owns those widenings), the
-- approval guard triggers (0076), the transition table, RLS policies.
--
-- SECURITY. Both new functions are SECURITY INVOKER: they run as the calling
-- user, under that user's RLS, and additionally scope every statement to
-- auth.uid(). A call without an authenticated user id raises. Execute is
-- granted to authenticated and service_role only.
--
-- IDEMPOTENT. create or replace / drop trigger if exists + create; a second
-- apply is a no-op (proven by scripts/fdh_0212_pglite_verification.mjs).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- A. Blocking-issue policy: excluded duplicates never block.
-- ---------------------------------------------------------------------------
create or replace function fdh7_transaction_has_blocking_issue(p_user_id uuid, p_transaction_id uuid)
returns boolean
language sql
stable
as $$
  select
    -- 0212: an excluded duplicate (the removed side of a resolved pair, or a
    -- row the engine confirmed as a copy of an earlier import) counts
    -- nowhere, so nothing about it blocks. Every clause below is 0085's,
    -- unchanged, and applies only when this is false.
    not exists (
      select 1 from fdh_transactions d
      where d.id = p_transaction_id and d.user_id = p_user_id
        and d.dedup_status in ('duplicate_confirmed', 'user_confirmed_duplicate')
    )
    and (
      exists (
        select 1 from fdh_transactions t
        where t.id = p_transaction_id and t.user_id = p_user_id
          and t.economic_transaction_type = 'unknown'
          and (
            select sum(a.amount) from fdh_transaction_allocations a
            where a.transaction_id = t.id and a.user_id = p_user_id
          ) is distinct from t.amount_original
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
      )
    );
$$;

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
        -- 0212: excluded duplicates are skipped here explicitly as well, so
        -- the statement check never depends on the transaction check's
        -- first clause alone.
        and t.dedup_status not in ('duplicate_confirmed', 'user_confirmed_duplicate')
        and fdh7_transaction_has_blocking_issue(p_user_id, t.id)
    );
$$;

grant execute on function fdh7_transaction_has_blocking_issue(uuid, uuid) to authenticated;
grant execute on function fdh7_statement_has_blocking_issue(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- B. Allocations: DB-level gate + atomic replace.
-- ---------------------------------------------------------------------------
create or replace function fdh8_guard_allocation_parent_not_approved()
returns trigger
language plpgsql
as $$
declare
  v_txn uuid := coalesce(new.transaction_id, old.transaction_id);
  v_status text;
begin
  -- The server-side import-bridge write seam (0207): the WP-11 ledger Apply
  -- writes allocations for rows it creates in the same transaction.
  if coalesce(current_setting('fhip.import_bridge_internal_write', true), '') = 'true' then
    return coalesce(new, old);
  end if;
  select approval_status into v_status from fdh_transactions where id = v_txn;
  -- No parent row: the parent is being deleted (ON DELETE CASCADE) -- allow.
  if v_status = 'approved' then
    raise exception 'fdh_transaction_allocations: the transaction is approved; reopen its statement before changing its split'
      using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.transaction_id is distinct from old.transaction_id then
    select approval_status into v_status from fdh_transactions where id = old.transaction_id;
    if v_status = 'approved' then
      raise exception 'fdh_transaction_allocations: the transaction is approved; reopen its statement before changing its split'
        using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_fdh8_guard_allocation_parent_not_approved on fdh_transaction_allocations;
create trigger trg_fdh8_guard_allocation_parent_not_approved
  before insert or update or delete on fdh_transaction_allocations
  for each row execute function fdh8_guard_allocation_parent_not_approved();

-- Replaces the WHOLE allocation set of one of the caller's transactions.
--   p_allocations: a JSON array of {economic_transaction_type, amount,
--     category_id?, subcategory_id?, note?}; 1..50 lines, in display order.
--   p_finalize: true requires the lines to add up to the parent EXACTLY
--     (numeric(20,4), no floating point); false saves a draft that may be
--     short but never over-allocated.
-- Refusals carry a stable SQLSTATE the service maps to a user message:
--   FH404 not found (or not the caller's)   FH409 parent approved
--   FH422 invalid lines (unknown type, count, amount, over/under allocated)
create or replace function fdh8_replace_transaction_allocations(
  p_transaction_id uuid,
  p_allocations jsonb,
  p_finalize boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_txn fdh_transactions%rowtype;
  v_count int;
  v_sum numeric(20,4);
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'fdh8_replace_transaction_allocations: an authenticated user is required' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be a list' using errcode = 'FH422';
  end if;
  v_count := jsonb_array_length(p_allocations);
  if v_count < 1 or v_count > 50 then
    raise exception 'a split needs between 1 and 50 lines' using errcode = 'FH422';
  end if;

  -- The row lock is what makes two concurrent replaces serialise: the second
  -- waits here until the first commits, then replaces the first's set whole.
  select * into v_txn from fdh_transactions
  where id = p_transaction_id and user_id = v_uid
  for update;
  if not found then
    raise exception 'transaction not found' using errcode = 'FH404';
  end if;
  if v_txn.approval_status = 'approved' then
    raise exception 'this transaction is approved; reopen its statement before changing its split' using errcode = 'FH409';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_allocations) e
    where coalesce(e->>'economic_transaction_type', '') not in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal', 'debt_interest',
      'refund', 'asset_purchase', 'asset_sale', 'tax', 'fee', 'cash_withdrawal'
    )
  ) then
    raise exception 'every split line needs a type; "unknown" is not allowed' using errcode = 'FH422';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_allocations) e
    where (e->>'amount') is null or (e->>'amount')::numeric <= 0
  ) then
    raise exception 'every split line needs an amount greater than zero' using errcode = 'FH422';
  end if;

  select sum(round((e->>'amount')::numeric, 4)) into v_sum from jsonb_array_elements(p_allocations) e;
  if p_finalize and v_sum <> v_txn.amount_original then
    raise exception 'the split lines add up to % but the transaction is %', v_sum, v_txn.amount_original using errcode = 'FH422';
  end if;
  if not p_finalize and v_sum > v_txn.amount_original then
    raise exception 'the split lines add up to more than the transaction (% > %)', v_sum, v_txn.amount_original using errcode = 'FH422';
  end if;

  delete from fdh_transaction_allocations where transaction_id = v_txn.id and user_id = v_uid;

  insert into fdh_transaction_allocations (
    user_id, transaction_id, allocation_sequence, economic_transaction_type,
    category_id, subcategory_id, amount, currency_code, percentage, note
  )
  select
    v_uid, v_txn.id, e.ord::int, e.value->>'economic_transaction_type',
    nullif(e.value->>'category_id', '')::uuid, nullif(e.value->>'subcategory_id', '')::uuid,
    round((e.value->>'amount')::numeric, 4), v_txn.currency_original, null, nullif(e.value->>'note', '')
  from jsonb_array_elements(p_allocations) with ordinality as e(value, ord);

  select coalesce(jsonb_agg(to_jsonb(a) order by a.allocation_sequence), '[]'::jsonb) into v_rows
  from fdh_transaction_allocations a
  where a.transaction_id = v_txn.id and a.user_id = v_uid;
  return v_rows;
end;
$$;

revoke all on function fdh8_replace_transaction_allocations(uuid, jsonb, boolean) from public;
revoke all on function fdh8_replace_transaction_allocations(uuid, jsonb, boolean) from anon;
grant execute on function fdh8_replace_transaction_allocations(uuid, jsonb, boolean) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- C. Set-based approval.
-- ---------------------------------------------------------------------------
-- Approves every listed line of the caller's that is pending, not an excluded
-- duplicate and not blocked -- in one UPDATE. The per-row approval guard
-- trigger (0076) still fires for each row and re-validates it; it stamps
-- approved_at. Returns
--   {approved: [ids], blocked: [ids], already_approved: [ids],
--    skipped_duplicates: [ids], not_found: [ids]}
-- Refuses more than 5,000 ids per call (the service sends 500 per chunk).
create or replace function fdh7_bulk_approve_transactions(p_transaction_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_approved uuid[];
  v_blocked uuid[];
  v_already uuid[];
  v_dups uuid[];
  v_missing uuid[];
begin
  if v_uid is null then
    raise exception 'fdh7_bulk_approve_transactions: an authenticated user is required' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct req.xid), '{}') into v_ids
  from unnest(coalesce(p_transaction_ids, '{}'::uuid[])) as req(xid)
  where req.xid is not null;
  if cardinality(v_ids) > 5000 then
    raise exception 'at most 5000 transactions per call' using errcode = 'FH422';
  end if;

  select coalesce(array_agg(req.xid), '{}') into v_missing
  from unnest(v_ids) as req(xid)
  where not exists (select 1 from fdh_transactions t where t.id = req.xid and t.user_id = v_uid);

  select coalesce(array_agg(t.id), '{}') into v_already
  from fdh_transactions t
  where t.user_id = v_uid and t.id = any (v_ids) and t.approval_status = 'approved';

  select coalesce(array_agg(t.id), '{}') into v_dups
  from fdh_transactions t
  where t.user_id = v_uid and t.id = any (v_ids) and t.approval_status <> 'approved'
    and t.dedup_status in ('duplicate_confirmed', 'user_confirmed_duplicate');

  select coalesce(array_agg(t.id), '{}') into v_blocked
  from fdh_transactions t
  where t.user_id = v_uid and t.id = any (v_ids) and t.approval_status = 'pending'
    and t.dedup_status not in ('duplicate_confirmed', 'user_confirmed_duplicate')
    and fdh7_transaction_has_blocking_issue(v_uid, t.id);

  with upd as (
    update fdh_transactions t
    set approval_status = 'approved', approved_by = v_uid, updated_at = now()
    where t.user_id = v_uid
      and t.id = any (v_ids)
      and t.approval_status = 'pending'
      and t.dedup_status not in ('duplicate_confirmed', 'user_confirmed_duplicate')
      and not (t.id = any (v_blocked))
    returning t.id as approved_id
  )
  select coalesce(array_agg(upd.approved_id), '{}') into v_approved from upd;

  return jsonb_build_object(
    'approved', to_jsonb(v_approved),
    'blocked', to_jsonb(v_blocked),
    'already_approved', to_jsonb(v_already),
    'skipped_duplicates', to_jsonb(v_dups),
    'not_found', to_jsonb(v_missing)
  );
end;
$$;

revoke all on function fdh7_bulk_approve_transactions(uuid[]) from public;
revoke all on function fdh7_bulk_approve_transactions(uuid[]) from anon;
grant execute on function fdh7_bulk_approve_transactions(uuid[]) to authenticated, service_role;
