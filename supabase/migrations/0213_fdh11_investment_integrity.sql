-- 0213 -- FDH-11 AU investment statements: integrity for the path into
-- Investment Intelligence (canonical-upload programme, work package WP-12).
--
-- WHY. The stage-1 audit (INV-G2, INV-G5, INV-G7) found:
--   * INV-G2: every position row was created with apply_status
--     'not_applicable' (the 0106 column default) while Apply only ever claims
--     'pending' rows -- no statement position has ever been applied. The code
--     now inserts 'pending'; this file makes 'pending' the default and moves
--     the existing never-applied rows to 'pending' (section D).
--   * INV-G5 (PLAUSIBLE cross-tenant write): the 0106 "insert own" policies
--     accept ANY column value on INSERT, and the 0106 authoritative-write
--     triggers are BEFORE UPDATE only. A user could INSERT their own statement
--     already 'approved' with canonical_account_id = someone else's
--     ii_accounts.id, add a 'pending' position and call /apply; the
--     service-role bridge then wrote ii_holding_snapshots into the victim's
--     account. Nothing on ii_holding_snapshots / ii_transactions checks that
--     the account belongs to the row's user. Sections B and C close it in the
--     database, for every role (the bridge now also checks, in code).
--   * INV-G7: a position skipped at Apply (e.g. no market value -- never
--     recorded as $0) needs a place for its user-visible reason (section A).
--
-- WHAT. All additive; nothing dropped; no shared CHECK touched (this file
-- widens neither fdh_statement_uploads.error_code nor
-- fdh_document_audit_events.event_type -- the audit event WP-12 needs,
-- 'investment_positions_published', is already in 0207).
--   A. fdh_investment_statement_positions.apply_rejected_reason (nullable);
--      positions.apply_status default 'not_applicable' -> 'pending'.
--   B. BEFORE INSERT authoritative triggers on the three FDH-11 evidence
--      tables: an AUTHENTICATED insert may not set any system-owned column
--      (approval, account/security match, bank match, apply state, canonical
--      ids). The 0106 BEFORE UPDATE positions trigger is re-created with the
--      new apply_rejected_reason column in its guarded list.
--   C. Same-tenant triggers (every role, service_role included):
--        ii_holding_snapshots.account_id / ii_transactions.account_id must be
--        an ii_accounts row of the SAME user; and
--        fdh_investment_statements.canonical_account_id likewise.
--      No foreign key is added (0106's rule: an FDH-11 evidence table carries
--      no DB-level FK to an ii_ table); the check is a trigger lookup.
--   D. Idempotent backfill: positions still 'not_applicable' -> 'pending'
--      (all statements -- a pending statement's positions must also be
--      applicable once approved). Runs as service_role inside this
--      transaction so the 0106 update trigger (which refuses a NULL request
--      role, i.e. the SQL editor) lets it through; the claim is reset after.
--
-- IDEMPOTENT: add column if not exists, create or replace, drop trigger if
-- exists + create, and a backfill whose second run updates 0 rows. Proven by
-- scripts/fdh11_0213_pglite_verification.mjs (before/after/re-apply).

-- ============================================================================
-- A. positions: skip reason + 'pending' default
-- ============================================================================
alter table fdh_investment_statement_positions
  add column if not exists apply_rejected_reason text;

alter table fdh_investment_statement_positions
  alter column apply_status set default 'pending';

-- ============================================================================
-- B. Authoritative INSERT (authenticated role only)
-- ============================================================================
create or replace function fdh0213_investment_statements_assert_authoritative_insert() returns trigger as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if new.canonical_account_id is not null
     or new.approval_status is distinct from 'pending'
     or new.approved_at is not null
     or new.approved_by is not null
     or new.reconciliation_status is distinct from 'insufficient_data'
     or new.duplicate_of_statement_id is not null
     or new.supersedes_statement_id is not null
  then
    raise exception 'fdh_investment_statements: approval, account match and reconciliation are system-authoritative and may not be set on insert by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_investment_statements_authoritative_insert_0213 on fdh_investment_statements;
create trigger trg_fdh_investment_statements_authoritative_insert_0213
  before insert on fdh_investment_statements
  for each row execute function fdh0213_investment_statements_assert_authoritative_insert();

create or replace function fdh0213_investment_positions_assert_authoritative_insert() returns trigger as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if new.security_match_status is distinct from 'not_attempted'
     or new.matched_instrument_id is not null
     or new.apply_status not in ('pending', 'not_applicable')
     or new.canonical_holding_snapshot_id is not null
     or new.applied_at is not null
     or new.applied_by is not null
     or new.apply_rejected_reason is not null
  then
    raise exception 'fdh_investment_statement_positions: security match and apply state are system-authoritative and may not be set on insert by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_investment_positions_authoritative_insert_0213 on fdh_investment_statement_positions;
create trigger trg_fdh_investment_positions_authoritative_insert_0213
  before insert on fdh_investment_statement_positions
  for each row execute function fdh0213_investment_positions_assert_authoritative_insert();

create or replace function fdh0213_investment_activities_assert_authoritative_insert() returns trigger as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if new.security_match_status is distinct from 'not_attempted'
     or new.matched_instrument_id is not null
     or new.linked_transaction_id is not null
     or new.bank_match_status is distinct from 'not_attempted'
     or new.bank_match_candidates is not null
     or new.apply_status is distinct from 'pending'
     or new.canonical_transaction_id is not null
     or new.applied_at is not null
     or new.applied_by is not null
     or new.apply_rejected_reason is not null
  then
    raise exception 'fdh_investment_statement_activities: security match, bank match and apply state are system-authoritative and may not be set on insert by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_investment_activities_authoritative_insert_0213 on fdh_investment_statement_activities;
create trigger trg_fdh_investment_activities_authoritative_insert_0213
  before insert on fdh_investment_statement_activities
  for each row execute function fdh0213_investment_activities_assert_authoritative_insert();

-- The 0106 BEFORE UPDATE guard on positions, repeated verbatim (0106:486-506)
-- with the one new system-owned column (apply_rejected_reason) added. No other
-- migration redefines this function (derived from the ledger: only 0106).
create or replace function fdh11_investment_positions_assert_authoritative_write() returns trigger as $$
begin
  -- Established pattern (0064/0065/0068/0069/0071/0087): distinguishes an
  -- authenticated user's own PostgREST request from the service-role admin
  -- client (`lib/investment-import-bridge/`), which bypasses RLS AND this
  -- trigger check by construction (auth.role() = 'service_role') -- no
  -- transaction-local GUC or RPC wrapper required.
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.quantity is distinct from old.quantity
     or new.unit_price is distinct from old.unit_price
     or new.market_value is distinct from old.market_value
     or new.security_match_status is distinct from old.security_match_status
     or new.matched_instrument_id is distinct from old.matched_instrument_id
     or new.apply_status is distinct from old.apply_status
     or new.canonical_holding_snapshot_id is distinct from old.canonical_holding_snapshot_id
     or new.applied_at is distinct from old.applied_at
     or new.applied_by is distinct from old.applied_by
     -- 0213 addition.
     or new.apply_rejected_reason is distinct from old.apply_rejected_reason
  then
    raise exception 'fdh_investment_statement_positions: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- C. Same-tenant guards (every role)
-- ============================================================================
create or replace function fdh0213_assert_ii_account_same_tenant() returns trigger as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from ii_accounts where id = new.account_id;
  if v_owner is null then
    raise exception '%: account_id % does not exist', tg_table_name, new.account_id;
  end if;
  if v_owner <> new.user_id then
    raise exception '%: cross-tenant reference -- investment account % belongs to a different user', tg_table_name, new.account_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_ii_holding_snapshots_same_tenant_0213 on ii_holding_snapshots;
create trigger trg_ii_holding_snapshots_same_tenant_0213
  before insert or update of user_id, account_id on ii_holding_snapshots
  for each row execute function fdh0213_assert_ii_account_same_tenant();

drop trigger if exists trg_ii_transactions_same_tenant_0213 on ii_transactions;
create trigger trg_ii_transactions_same_tenant_0213
  before insert or update of user_id, account_id on ii_transactions
  for each row execute function fdh0213_assert_ii_account_same_tenant();

create or replace function fdh0213_assert_statement_account_same_tenant() returns trigger as $$
declare
  v_owner uuid;
begin
  if new.canonical_account_id is null then
    return new;
  end if;
  select user_id into v_owner from ii_accounts where id = new.canonical_account_id;
  if v_owner is null then
    raise exception 'fdh_investment_statements: canonical_account_id % does not exist', new.canonical_account_id;
  end if;
  if v_owner <> new.user_id then
    raise exception 'fdh_investment_statements: cross-tenant reference -- investment account % belongs to a different user', new.canonical_account_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_investment_statements_account_same_tenant_0213 on fdh_investment_statements;
create trigger trg_fdh_investment_statements_account_same_tenant_0213
  before insert or update of user_id, canonical_account_id on fdh_investment_statements
  for each row execute function fdh0213_assert_statement_account_same_tenant();

-- ============================================================================
-- D. Backfill: never-applicable positions become applicable (idempotent)
-- ============================================================================
do $$
declare
  v_rows integer;
begin
  -- The 0106 update guard refuses any caller whose request role is not
  -- exactly 'service_role'-like (a NULL role, i.e. the SQL editor, falls
  -- through to its column checks). This backfill IS the system; say so for
  -- this transaction only, and clear it afterwards.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  update fdh_investment_statement_positions
     set apply_status = 'pending',
         updated_at = now()
   where apply_status = 'not_applicable';
  get diagnostics v_rows = row_count;
  raise notice '0213: % position row(s) moved from not_applicable to pending', v_rows;

  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
