-- =============================================================================
-- 0214 -- Approved Upload -> Canonical programme, WP-15: the Input Population
-- Proposal (original FDH scope p.428-457; PO decisions D-02 and D-04).
-- =============================================================================
--
-- WHAT THIS ENABLES (and nothing else):
--   (a) "Update your planned expenses from your actual spending": one
--       fhip_import_proposals row per planned item (target_domain 'expense',
--       source_kind 'bank_statement'), carrying the trailing-3-complete-month
--       average of approved imported spending; applied atomically, as a
--       batch, by fdh15_apply_expense_proposals().
--   (b) "Add your bank balance to Assets": one proposal per ordinary bank
--       account (target_domain 'asset'), carrying the latest approved
--       statement's reported closing balance; applied by
--       fdh15_apply_asset_proposal(), which re-derives the balance from the
--       approved statement itself so the value cannot be forged.
--
-- Both target domains have been permitted by fhip_import_proposals /
-- fhip_import_applications CHECK constraints since 0091 ("reserved
-- deliberately, never used"). NO TRANSACTION IS COPIED ANYWHERE: an expense
-- proposal is one monthly figure per planned item, an asset proposal one
-- balance per account. expense_items stays the PLANNED register; approved
-- fdh_transactions stay the ACTUAL layer (PO D-02).
--
-- PARTS
--   A  expense_items provenance columns (source_type / last_import_*)
--   B  assets provenance columns + the account link, one active asset per
--      bank account (the structural no-double-count guarantee)
--   C  provenance write guards (the authenticated role cannot forge them)
--   D  fhip_import_proposals / fhip_import_applications source columns
--   E  the bridge's three shared guard functions, extended for 'expense' and
--      'asset' -- each behind a REVOCATION GUARD (below)
--   F  fdh15_apply_expense_proposals()  (batch, atomic, idempotent, stale-safe)
--   G  fdh15_apply_asset_proposal()     (atomic, idempotent, stale-safe)
--
-- SHARED-OBJECT DISCIPLINE (the 0185/0207 lesson: a drop-and-recreate of a
-- shared object silently revokes whatever a sibling branch added, with every
-- test green):
--   * assets.source_type's CHECK is WIDENED BY UNION with the live
--     constraint's own value list, read from pg_constraint at apply time --
--     never a hard-coded list -- so a value any other migration added
--     survives whatever order the migrations run in. Same for the new
--     expense_items.source_type CHECK should a sibling have created one.
--   * fdh9_assert_proposal_owner(), fdh9_assert_application_owner() and
--     fdh9_import_proposals_assert_authoritative_write() are function bodies,
--     which cannot be unioned. Before replacing each, a guard reads the LIVE
--     body and REFUSES TO APPLY if it names any target_domain, source column
--     or protected column that this migration's replacement does not. A
--     sibling that extended them (e.g. a new 'investment' branch) therefore
--     makes 0214 fail loudly instead of silently deleting its branch; the
--     integrator merges the bodies and re-runs. Same for the
--     trg_fhip_import_proposals_owner column list.
--
-- IDEMPOTENT: re-applying the whole file is a no-op (PGlite-verified,
-- scripts/canonical_0214_pglite_verification.mjs).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- PART A -- expense_items provenance.
-- ---------------------------------------------------------------------------
alter table expense_items
  add column if not exists source_type text not null default 'manual',
  add column if not exists last_import_application_id uuid references fhip_import_applications(id) on delete set null,
  add column if not exists last_imported_at timestamptz;

-- Widen-by-union helper, used for both registers' source_type CHECK. Reads the
-- live CHECK on (table, column) -- whatever its name -- and recreates it as
-- the union of its own values and `p_required`. No-op when already a superset.
create or replace function pg_temp.fdh15_widen_value_check(p_table regclass, p_column text, p_required text[], p_default_name text)
returns void language plpgsql as $$
declare
  v_attnum smallint;
  v_con record;
  v_existing text[] := array[]::text[];
  v_union text[];
  v_name text := p_default_name;
begin
  select attnum into v_attnum from pg_attribute where attrelid = p_table and attname = p_column and not attisdropped;
  if v_attnum is null then
    raise exception '0214: %.% does not exist', p_table, p_column;
  end if;
  for v_con in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = p_table and contype = 'c' and conkey = array[v_attnum]
  loop
    v_name := v_con.conname;
    select coalesce(array_agg(m[1]), array[]::text[]) into v_existing
      from regexp_matches(v_con.def, '''([^'']+)''', 'g') as m;
  end loop;
  select array_agg(v order by ord) into v_union from (
    select v, min(ord) as ord from (
      select v, ord from unnest(v_existing) with ordinality as e(v, ord)
      union all
      select v, 1000 + ord from unnest(p_required) with ordinality as r(v, ord)
    ) s group by v
  ) u;
  if v_existing @> p_required and array_length(v_existing, 1) > 0 then
    return; -- already a superset: nothing to do
  end if;
  execute format('alter table %s drop constraint if exists %I', p_table, v_name);
  execute format('alter table %s add constraint %I check (%I in (%s))', p_table, v_name, p_column,
    (select string_agg(quote_literal(x), ', ') from unnest(v_union) x));
end $$;

select pg_temp.fdh15_widen_value_check('expense_items'::regclass, 'source_type', array['manual', 'bank_statement_average'], 'expense_items_source_type_check');

comment on column expense_items.source_type is
  'WP-15 (0214): manual = typed by the user; bank_statement_average = amount/frequency last set by applying the "update your planned expenses from your actual spending" proposal. Provenance only: the row is still the PLANNED figure.';


-- ---------------------------------------------------------------------------
-- PART B -- assets provenance + account link.
-- ---------------------------------------------------------------------------
alter table assets
  add column if not exists last_import_application_id uuid references fhip_import_applications(id) on delete set null,
  add column if not exists last_imported_at timestamptz,
  add column if not exists source_financial_account_id uuid references fdh_financial_accounts(id) on delete set null;

select pg_temp.fdh15_widen_value_check('assets'::regclass, 'source_type', array['manual', 'investment_intelligence_published', 'bank_statement_import'], 'assets_source_type_check');

-- One ACTIVE asset per bank account: a statement balance can never become two
-- assets (repeat Apply, concurrent Apply, or Add after an earlier Add).
create unique index if not exists uq_assets_active_source_financial_account
  on assets(source_financial_account_id)
  where source_financial_account_id is not null and is_active is true;

comment on column assets.source_financial_account_id is
  'WP-15 (0214): the bank account whose approved statement closing balance this cash asset carries (PO D-04). Set only by fdh15_apply_asset_proposal(); at most one active asset per account.';

-- Same-tenant guard for the account link (holds even for the service role).
create or replace function fdh15_assets_assert_account_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_financial_account_id is not null then
    select user_id into ref_owner from fdh_financial_accounts where id = new.source_financial_account_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'assets: cross-tenant reference — bank account % belongs to a different user', new.source_financial_account_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_assets_source_account_owner on assets;
create trigger trg_assets_source_account_owner
  before insert or update of source_financial_account_id, user_id on assets
  for each row execute function fdh15_assets_assert_account_owner();


-- ---------------------------------------------------------------------------
-- PART C -- provenance write guards. Mirrors 0096 F.3 (liabilities): every
-- ordinary column stays exactly as user-editable as before; only the import
-- provenance is reserved to the apply functions (transaction-local
-- fhip.import_bridge_internal_write flag).
-- ---------------------------------------------------------------------------
create or replace function fdh15_expense_items_assert_provenance_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.source_type, 'manual') <> 'manual' or new.last_import_application_id is not null or new.last_imported_at is not null then
      raise exception 'expense_items: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role';
    end if;
  elsif new.source_type is distinct from old.source_type
     or new.last_import_application_id is distinct from old.last_import_application_id
     or new.last_imported_at is distinct from old.last_imported_at then
    raise exception 'expense_items: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_expense_items_provenance_write on expense_items;
create trigger trg_expense_items_provenance_write
  before insert or update on expense_items
  for each row execute function fdh15_expense_items_assert_provenance_write();

-- assets: only the WP-15 provenance is reserved. Any other source_type
-- transition (e.g. Investment Intelligence's own) is untouched.
create or replace function fdh15_assets_assert_provenance_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.source_type = 'bank_statement_import' or new.source_financial_account_id is not null
       or new.last_import_application_id is not null or new.last_imported_at is not null then
      raise exception 'assets: bank-statement import provenance (source_type bank_statement_import, source_financial_account_id, last_import_application_id, last_imported_at) may not be written directly by the authenticated role';
    end if;
  elsif (new.source_type is distinct from old.source_type and 'bank_statement_import' in (new.source_type, old.source_type))
     or new.source_financial_account_id is distinct from old.source_financial_account_id
     or new.last_import_application_id is distinct from old.last_import_application_id
     or new.last_imported_at is distinct from old.last_imported_at then
    raise exception 'assets: bank-statement import provenance (source_type bank_statement_import, source_financial_account_id, last_import_application_id, last_imported_at) may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_assets_provenance_write on assets;
create trigger trg_assets_provenance_write
  before insert or update on assets
  for each row execute function fdh15_assets_assert_provenance_write();


-- ---------------------------------------------------------------------------
-- PART D -- proposal / application source columns. A named nullable FK per
-- source (the 0096/0112 precedent), never a polymorphic pair.
-- ---------------------------------------------------------------------------
alter table fhip_import_proposals
  add column if not exists source_statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,
  add column if not exists source_window_from date,
  add column if not exists source_window_to date;
create index if not exists idx_fhip_import_proposals_statement_upload
  on fhip_import_proposals(source_statement_upload_id)
  where source_statement_upload_id is not null;

alter table fhip_import_applications
  add column if not exists source_statement_upload_id uuid references fdh_statement_uploads(id) on delete set null;


-- ---------------------------------------------------------------------------
-- PART E -- the bridge's shared guard functions, extended.
--
-- E.0 REVOCATION GUARD. Refuses to continue if a live body names anything
-- (a target_domain branch, a source column, a protected column, a trigger
-- column) that the replacement below does not. Pure read of pg_proc /
-- pg_trigger; changes nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text;
  v_found text[];
  v_extra text[];
  v_domains constant text[] := array['income', 'liability', 'retirement', 'expense', 'asset'];
  v_source_cols constant text[] := array['source_payroll_event_id', 'source_liability_statement_id', 'source_retirement_statement_id', 'source_statement_upload_id'];
  v_protected constant text[] := array[
    'user_id', 'target_domain', 'source_kind', 'source_payroll_event_id', 'source_liability_statement_id',
    'source_statement_upload_id', 'source_window_from', 'source_window_to',
    'currency_code', 'target_entity_id', 'target_entity_updated_at', 'recommended_apply_mode',
    'duplicate_of_entity_id', 'generated_at', 'applied_at'];
  v_trigger_cols constant text[] := array[
    'user_id', 'source_payroll_event_id', 'source_liability_statement_id', 'source_retirement_statement_id',
    'source_statement_upload_id', 'target_entity_id', 'target_domain', 'duplicate_of_entity_id'];
  v_fn text;
begin
  foreach v_fn in array array['fdh9_assert_proposal_owner', 'fdh9_assert_application_owner'] loop
    select prosrc into v_src from pg_proc where proname = v_fn and pronamespace = 'public'::regnamespace;
    if v_src is null then
      raise exception '0214 revocation guard: %() does not exist -- is 0112 applied?', v_fn;
    end if;
    select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_found
      from regexp_matches(v_src, 'target_domain\s*=\s*''([a-z_]+)''', 'g') as m;
    select coalesce(array_agg(x), array[]::text[]) into v_extra from unnest(v_found) x where not (x = any(v_domains));
    if array_length(v_extra, 1) > 0 then
      raise exception '0214 revocation guard: live %() has target_domain branch(es) % that 0214 would delete. Merge them into 0214 PART E, then re-apply.', v_fn, v_extra;
    end if;
    select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_found
      from regexp_matches(v_src, 'new\.(source_[a-z_]+_id)', 'g') as m;
    select coalesce(array_agg(x), array[]::text[]) into v_extra from unnest(v_found) x where not (x = any(v_source_cols));
    if array_length(v_extra, 1) > 0 then
      raise exception '0214 revocation guard: live %() checks source column(s) % that 0214 would delete. Merge them into 0214 PART E, then re-apply.', v_fn, v_extra;
    end if;
  end loop;

  select prosrc into v_src from pg_proc where proname = 'fdh9_import_proposals_assert_authoritative_write' and pronamespace = 'public'::regnamespace;
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_found
    from regexp_matches(coalesce(v_src, ''), 'new\.([a-z_]+)\s+is\s+distinct\s+from\s+old\.', 'g') as m;
  select coalesce(array_agg(x), array[]::text[]) into v_extra from unnest(v_found) x where not (x = any(v_protected || array['status', 'dismissed_at']));
  if array_length(v_extra, 1) > 0 then
    raise exception '0214 revocation guard: live fdh9_import_proposals_assert_authoritative_write() protects column(s) % that 0214 would unprotect. Merge them into 0214 PART E, then re-apply.', v_extra;
  end if;

  select coalesce(array_agg(a.attname::text), array[]::text[]) into v_found
    from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any(t.tgattr::smallint[])
    where t.tgname = 'trg_fhip_import_proposals_owner' and t.tgrelid = 'fhip_import_proposals'::regclass;
  select coalesce(array_agg(x), array[]::text[]) into v_extra from unnest(v_found) x where not (x = any(v_trigger_cols));
  if array_length(v_extra, 1) > 0 then
    raise exception '0214 revocation guard: trg_fhip_import_proposals_owner fires on column(s) % that 0214 would drop. Merge them into 0214 PART E, then re-apply.', v_extra;
  end if;
end $$;

-- E.1 fdh9_assert_proposal_owner(): the 0112 body, byte-for-byte for the
-- income / liability / retirement branches, plus the statement-upload source
-- and the expense / asset targets.
create or replace function fdh9_assert_proposal_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_payroll_event_id % does not exist', new.source_payroll_event_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_liability_statement_id % does not exist', new.source_liability_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  -- FDH-12 addition.
  if new.source_retirement_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.source_retirement_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_retirement_statement_id % does not exist', new.source_retirement_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — retirement statement % belongs to a different user', new.source_retirement_statement_id;
    end if;
  end if;

  -- WP-15 addition.
  if new.source_statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.source_statement_upload_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_statement_upload_id % does not exist', new.source_statement_upload_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — statement % belongs to a different user', new.source_statement_upload_id;
    end if;
  end if;

  if new.target_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in income_sources', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in liabilities', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
      end if;
    -- FDH-12 addition. This is spec section 98's "Tenant A statement targeting
    -- Tenant B retirement account: BLOCKED" enforced at the bridge as well as
    -- on the statement row itself.
    elsif new.target_domain = 'retirement' then
      select user_id into ref_owner from retirement_accounts where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in retirement_accounts', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — retirement account % belongs to a different user (forged retirement target — spec section 98)', new.target_entity_id;
      end if;
    -- WP-15 additions.
    elsif new.target_domain = 'expense' then
      select user_id into ref_owner from expense_items where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in expense_items', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — expense item % belongs to a different user', new.target_entity_id;
      end if;
    elsif new.target_domain = 'asset' then
      select user_id into ref_owner from assets where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in assets', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — asset % belongs to a different user', new.target_entity_id;
      end if;
    else
      raise exception 'fhip_import_proposals: target_domain % has no implemented target guard', new.target_domain;
    end if;
  end if;

  if new.duplicate_of_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate income entry % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate liability % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'retirement' then
      select user_id into ref_owner from retirement_accounts where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate retirement account % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'expense' then
      select user_id into ref_owner from expense_items where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate expense item % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'asset' then
      select user_id into ref_owner from assets where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate asset % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fhip_import_proposals_owner on fhip_import_proposals;
create trigger trg_fhip_import_proposals_owner
  before insert or update of user_id, source_payroll_event_id, source_liability_statement_id,
                             source_retirement_statement_id, source_statement_upload_id,
                             target_entity_id, target_domain, duplicate_of_entity_id
  on fhip_import_proposals
  for each row execute function fdh9_assert_proposal_owner();


-- E.2 fdh9_assert_application_owner(): the 0112 body plus the statement
-- source and the expense / asset targets.
create or replace function fdh9_assert_application_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_applications: proposal_id % does not exist', new.proposal_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fhip_import_applications: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;

  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  -- FDH-12 addition.
  if new.source_retirement_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.source_retirement_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — retirement statement % belongs to a different user', new.source_retirement_statement_id;
    end if;
  end if;

  -- WP-15 addition.
  if new.source_statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.source_statement_upload_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — statement % belongs to a different user', new.source_statement_upload_id;
    end if;
  end if;

  if new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in income_sources', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
    end if;
  elsif new.target_domain = 'liability' then
    select user_id into ref_owner from liabilities where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in liabilities', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
    end if;
  -- FDH-12 addition.
  elsif new.target_domain = 'retirement' then
    select user_id into ref_owner from retirement_accounts where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in retirement_accounts', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — retirement account % belongs to a different user (forged retirement target — spec section 98)', new.target_entity_id;
    end if;
  -- WP-15 additions.
  elsif new.target_domain = 'expense' then
    select user_id into ref_owner from expense_items where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in expense_items', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — expense item % belongs to a different user', new.target_entity_id;
    end if;
  elsif new.target_domain = 'asset' then
    select user_id into ref_owner from assets where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in assets', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — asset % belongs to a different user', new.target_entity_id;
    end if;
  else
    raise exception 'fhip_import_applications: target_domain % has no implemented target guard', new.target_domain;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- trg_fhip_import_applications_owner (0112) already targets this function by
-- name and fires on every INSERT/UPDATE; no re-creation needed.


-- E.3 fdh9_import_proposals_assert_authoritative_write(): the 0096 body plus
-- the three new source columns (the provenance of a proposal is as
-- authoritative as its payroll-event / liability-statement source).
create or replace function fdh9_import_proposals_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.target_domain is distinct from old.target_domain
     or new.source_kind is distinct from old.source_kind
     or new.source_payroll_event_id is distinct from old.source_payroll_event_id
     or new.source_liability_statement_id is distinct from old.source_liability_statement_id
     or new.source_statement_upload_id is distinct from old.source_statement_upload_id
     or new.source_window_from is distinct from old.source_window_from
     or new.source_window_to is distinct from old.source_window_to
     or new.currency_code is distinct from old.currency_code
     or new.target_entity_id is distinct from old.target_entity_id
     or new.target_entity_updated_at is distinct from old.target_entity_updated_at
     or new.recommended_apply_mode is distinct from old.recommended_apply_mode
     or new.duplicate_of_entity_id is distinct from old.duplicate_of_entity_id
     or new.generated_at is distinct from old.generated_at
     or new.applied_at is distinct from old.applied_at
  then
    raise exception 'fhip_import_proposals: this field is authoritative and may not be written directly by the authenticated role';
  end if;

  if new.status is distinct from old.status then
    if not (old.status = 'ready' and new.status in ('dismissed', 'superseded')) then
      raise exception 'fhip_import_proposals: status may only move from ready to dismissed or superseded via the authenticated role; applied is only ever set by the atomic apply function';
    end if;
  end if;

  if new.dismissed_at is distinct from old.dismissed_at and new.status <> 'dismissed' then
    raise exception 'fhip_import_proposals: dismissed_at may only be set alongside status=dismissed';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ---------------------------------------------------------------------------
-- PART F -- planned expenses from actual averages: the apply functions.
--
-- fdh15_apply_one_expense_proposal() does ONE proposal and returns a jsonb
-- outcome; it is internal (no grant). fdh15_apply_expense_proposals() is the
-- only entry point: it runs every decision of the batch inside ONE
-- subtransaction and, if any decision fails, rolls ALL of them back and
-- returns that decision's refusal -- the user's "Apply selected" is all or
-- nothing. Guarantees per proposal (the fdh10_apply_liability_proposal
-- pattern): row lock, ready->applied compare-and-swap (a second Apply is
-- ALREADY_APPLIED, never a second write), per-field staleness against the
-- snapshot, a typed column allow-list, and the application audit row.
-- ---------------------------------------------------------------------------
create or replace function fdh15_apply_one_expense_proposal(
  p_uid uuid,
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[]
) returns jsonb as $$
declare
  v_proposal record;
  v_row record;
  v_allowed constant text[] := array[
    'expense_name', 'master_item_key', 'expense_category', 'amount', 'frequency',
    'currency_code', 'is_essential', 'is_active', 'superseded_by_bank_import'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'expense_name', 'text', 'master_item_key', 'text', 'expense_category', 'enum', 'amount', 'money',
    'frequency', 'enum', 'currency_code', 'enum', 'is_essential', 'bool', 'is_active', 'bool',
    'superseded_by_bank_import', 'bool'
  );
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_master_key text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_kind text;
  v_lit text;
begin
  if p_decision is null or p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.', 'proposal_id', p_proposal_id);
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> p_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That suggestion could not be found.', 'proposal_id', p_proposal_id);
  end if;
  if v_proposal.target_domain <> 'expense' or v_proposal.source_kind <> 'bank_statement' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is not a planned-expense update.', 'proposal_id', p_proposal_id);
  end if;

  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is no longer open.', 'proposal_id', p_proposal_id);
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing', 'proposal_id', p_proposal_id);
  end if;

  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied' then 'This suggestion has already been applied to your planned expenses.' else 'That suggestion is no longer open.' end,
      'proposal_id', p_proposal_id);
  end if;
  if p_decision = 'add_new' and v_proposal.target_entity_id is not null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'This planned expense already exists; update it instead.', 'proposal_id', p_proposal_id);
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing planned expense to update.', 'proposal_id', p_proposal_id);
  end if;

  if p_selected_fields is null or array_length(p_selected_fields, 1) is null then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := p_selected_fields;
  end if;
  if v_selected is null then v_selected := array[]::text[]; end if;

  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_allowed));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields cannot be changed by an import.', 'fields', to_jsonb(v_forbidden), 'proposal_id', p_proposal_id);
  end if;
  select array_agg(field_name) into v_known from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  if v_known is null then v_known := array[]::text[]; end if;
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_known));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this suggestion.', 'fields', to_jsonb(v_forbidden), 'proposal_id', p_proposal_id);
  end if;
  if array_length(v_selected, 1) is null then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one detail to apply.', 'proposal_id', p_proposal_id);
  end if;

  if p_decision = 'add_new' then
    if not ('expense_name' = any(v_selected)) or not ('master_item_key' = any(v_selected)) or not ('amount' = any(v_selected))
       or not ('frequency' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new planned expense needs a name, an item, an amount, a frequency and a currency.', 'proposal_id', p_proposal_id);
    end if;
    select proposed_value into v_master_key from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'master_item_key';
    -- Stale-safe add: a row for this item appeared since the suggestion was
    -- prepared (typed by the user, or an earlier batch). (user_id,
    -- master_item_key) is unique, inactive rows included.
    if exists (select 1 from expense_items where user_id = p_uid and master_item_key = v_master_key) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'You already have this planned expense now, so the suggestion to add it was not applied. Refresh the suggestions.', 'field', 'master_item_key', 'proposal_id', p_proposal_id);
    end if;
  else
    select * into v_row from expense_items where id = v_proposal.target_entity_id and user_id = p_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The planned expense this suggestion refers to could not be found.', 'proposal_id', p_proposal_id);
    end if;
    if v_row.owner = 'smsf' then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'That planned expense now belongs to your SMSF, so household spending was not applied to it.', 'field', 'owner', 'proposal_id', p_proposal_id);
    end if;
    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'expense_name'              then nullif(trim(both from coalesce(v_row.expense_name, '')), '')
        when 'master_item_key'           then nullif(trim(both from coalesce(v_row.master_item_key, '')), '')
        when 'expense_category'          then nullif(trim(both from coalesce(v_row.expense_category, '')), '')
        when 'amount'                    then case when v_row.amount is null then null else round(v_row.amount, 2)::text end
        when 'frequency'                 then nullif(trim(both from coalesce(v_row.frequency, '')), '')
        when 'currency_code'             then nullif(trim(both from coalesce(v_row.currency_code::text, '')), '')
        when 'is_essential'              then case when v_row.is_essential then 'true' else 'false' end
        when 'is_active'                 then case when v_row.is_active is false then 'false' else 'true' end
        when 'superseded_by_bank_import' then case when coalesce(v_row.superseded_by_bank_import, false) then 'true' else 'false' end
        else null
      end;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your planned expense changed after this suggestion was prepared, so it was not applied. Refresh the suggestions.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text, 'proposal_id', p_proposal_id);
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  for v_field in
    select pf.field_name, pf.proposed_value from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_lit := 'NULL';
    elsif v_kind = 'money' then
      v_lit := format('%L::numeric', v_field.proposed_value);
    elsif v_kind = 'bool' then
      v_lit := format('%L::boolean', v_field.proposed_value);
    else
      v_lit := format('%L', v_field.proposed_value);
    end if;
    v_set_parts := array_append(v_set_parts, format('%I = %s', v_field.field_name, v_lit));
    v_cols := array_append(v_cols, quote_ident(v_field.field_name));
    v_vals := array_append(v_vals, v_lit);
    v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
    v_applied_fields := array_append(v_applied_fields, v_field.field_name);
    if p_decision = 'add_new' then
      v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
    end if;
  end loop;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now() where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This suggestion has already been applied to your planned expenses.', 'proposal_id', p_proposal_id);
  end if;

  if p_decision = 'add_new' then
    execute format('insert into expense_items (user_id, owner, is_active, %s) values (%L::uuid, %L, true, %s) returning id',
      array_to_string(v_cols, ', '), p_uid, 'self', array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update expense_items set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, p_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_statement_upload_id, applied_by
  ) values (
    p_uid, p_proposal_id, 'expense', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_statement_upload_id, p_uid
  ) returning id into v_application_id;

  update expense_items
    set source_type = 'bank_statement_average', last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = p_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'applied', 'apply_mode', p_decision, 'proposal_id', p_proposal_id,
    'target_entity_id', v_target_id, 'application_id', v_application_id, 'applied_fields', to_jsonb(v_applied_fields));
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh15_apply_one_expense_proposal(uuid, uuid, text, text[]) from public;
revoke all on function fdh15_apply_one_expense_proposal(uuid, uuid, text, text[]) from anon, authenticated;

-- p_decisions: [{"proposal_id": "<uuid>", "decision": "add_new|update_existing|apply_selected_fields|keep_existing", "selected_fields": ["amount", ...]?}, ...]
create or replace function fdh15_apply_expense_proposals(p_decisions jsonb) returns jsonb as $$
declare
  v_uid uuid;
  v_item jsonb;
  v_one jsonb;
  v_results jsonb := '[]'::jsonb;
  v_fields text[];
  v_detail text;
  v_n int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh15_apply_expense_proposals: authentication required';
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one planned expense to update.');
  end if;
  v_n := jsonb_array_length(p_decisions);
  if v_n > 200 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Too many suggestions in one request.');
  end if;
  if exists (select 1 from jsonb_array_elements(p_decisions) x
             where jsonb_typeof(x) <> 'object'
                or coalesce(x->>'proposal_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                or (x ? 'selected_fields' and jsonb_typeof(x->'selected_fields') not in ('array', 'null'))) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'The request was not understood.');
  end if;
  if (select count(distinct lower(x->>'proposal_id')) from jsonb_array_elements(p_decisions) x) <> v_n then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'The same suggestion was sent twice.');
  end if;

  begin
    for v_item in select value from jsonb_array_elements(p_decisions) loop
      if jsonb_typeof(v_item->'selected_fields') = 'array' then
        select coalesce(array_agg(e), array[]::text[]) into v_fields from jsonb_array_elements_text(v_item->'selected_fields') e;
      else
        v_fields := null;
      end if;
      v_one := fdh15_apply_one_expense_proposal(v_uid, (v_item->>'proposal_id')::uuid, v_item->>'decision', v_fields);
      if not coalesce((v_one->>'ok')::boolean, false) then
        raise exception 'FDH15_BATCH_ABORT' using detail = v_one::text;
      end if;
      v_results := v_results || jsonb_build_array(v_one);
    end loop;
  exception when raise_exception then
    get stacked diagnostics v_detail = pg_exception_detail;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    if sqlerrm = 'FDH15_BATCH_ABORT' then
      -- Every earlier decision in this batch was rolled back with the block.
      return v_detail::jsonb || jsonb_build_object('ok', false, 'rolled_back', true);
    end if;
    raise;
  end;

  return jsonb_build_object('ok', true, 'results', v_results);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh15_apply_expense_proposals(jsonb) from public;
grant execute on function fdh15_apply_expense_proposals(jsonb) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- PART G -- bank balance -> cash asset (PO D-04).
--
-- UNFORGEABLE VALUE: the proposal's current_value must equal the reported
-- closing balance on the proposal's own source statement, which must be an
-- APPROVED statement of the caller's, on an ordinary (non card/loan) bank
-- account, and still that account's LATEST approved statement with a
-- closing balance. A hand-made proposal with any other number is refused.
-- ONE ASSET PER ACCOUNT: add_new is refused when an active asset already
-- carries the account (and uq_assets_active_source_financial_account holds
-- even against a race).
-- ---------------------------------------------------------------------------
create or replace function fdh15_apply_asset_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_stmt record;
  v_account record;
  v_asset record;
  v_balance numeric;
  v_newer boolean;
  v_allowed constant text[] := array['asset_name', 'asset_class', 'current_value', 'currency_code', 'valuation_date', 'owner'];
  v_kinds constant jsonb := jsonb_build_object(
    'asset_name', 'text', 'asset_class', 'enum', 'current_value', 'money', 'currency_code', 'enum', 'valuation_date', 'date', 'owner', 'enum');
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_proposed_value text;
  v_proposed_class text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_kind text;
  v_lit text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh15_apply_asset_proposal: authentication required';
  end if;
  if p_decision is null or p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That suggestion could not be found.');
  end if;
  if v_proposal.target_domain <> 'asset' or v_proposal.source_kind <> 'bank_statement' or v_proposal.source_statement_upload_id is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is not a bank-balance update.');
  end if;

  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That suggestion is no longer open.');
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing');
  end if;

  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied' then 'This balance has already been added to your assets.' else 'That suggestion is no longer open.' end);
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing asset to update.');
  end if;

  -- The evidence: an approved statement of the caller's, on an ordinary bank account.
  select * into v_stmt from fdh_statement_uploads
    where id = v_proposal.source_statement_upload_id and user_id = v_uid and processing_status = 'approved';
  if not found or v_stmt.financial_account_id is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'The statement behind this balance is no longer approved.');
  end if;
  select * into v_account from fdh_financial_accounts where id = v_stmt.financial_account_id and user_id = v_uid;
  if not found or v_account.account_type in ('credit_card', 'home_loan', 'personal_loan', 'vehicle_loan', 'investment_property_loan', 'other_term_loan', 'line_of_credit', 'overdraft')
     or v_account.liability_id is not null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'Only an ordinary bank account balance can be added as a cash asset.');
  end if;
  select rr.reported_closing_balance into v_balance from fdh_reconciliation_results rr
    where rr.statement_upload_id = v_stmt.id and rr.user_id = v_uid and rr.reported_closing_balance is not null
    order by rr.created_at desc nulls last limit 1;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That statement has no closing balance.');
  end if;
  select exists (
    select 1 from fdh_statement_uploads s
    where s.user_id = v_uid and s.financial_account_id = v_stmt.financial_account_id and s.processing_status = 'approved' and s.id <> v_stmt.id
      and coalesce(s.statement_period_end, s.approved_at::date) > coalesce(v_stmt.statement_period_end, v_stmt.approved_at::date)
      and exists (select 1 from fdh_reconciliation_results r where r.statement_upload_id = s.id and r.user_id = v_uid and r.reported_closing_balance is not null)
  ) into v_newer;
  if v_newer then
    return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'A newer statement for this account has been approved. Refresh the suggestion.', 'field', 'current_value');
  end if;
  select proposed_value into v_proposed_value from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'current_value';
  if v_proposed_value is null or round(v_proposed_value::numeric, 2) <> round(v_balance, 2) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'This balance does not match the approved statement.', 'fields', to_jsonb(array['current_value']));
  end if;
  if v_balance < 0 then
    return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'An overdrawn balance is not an asset.');
  end if;

  if p_selected_fields is null or array_length(p_selected_fields, 1) is null then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := p_selected_fields;
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
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this suggestion.', 'fields', to_jsonb(v_forbidden));
  end if;
  if not ('current_value' = any(v_selected)) then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'The balance itself must be applied.');
  end if;

  if p_decision = 'add_new' then
    if not ('asset_name' = any(v_selected)) or not ('asset_class' = any(v_selected)) or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new cash asset needs a name, the cash class, a balance and a currency.');
    end if;
    select proposed_value into v_proposed_class from fhip_import_proposal_fields where proposal_id = p_proposal_id and field_name = 'asset_class';
    if v_proposed_class is distinct from 'cash' then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A bank balance can only be added as a cash asset.');
    end if;
    if exists (select 1 from assets where user_id = v_uid and source_financial_account_id = v_stmt.financial_account_id and is_active is true) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'This account already has an asset in your Net Worth. Refresh the suggestion to update it instead.', 'field', 'source_financial_account_id');
    end if;
  else
    select * into v_asset from assets where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found or v_asset.is_active is not true then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The asset this suggestion refers to could not be found.');
    end if;
    if v_asset.source_financial_account_id is not null and v_asset.source_financial_account_id <> v_stmt.financial_account_id then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'That asset already carries a different bank account.', 'field', 'source_financial_account_id');
    end if;
    if exists (select 1 from assets where user_id = v_uid and source_financial_account_id = v_stmt.financial_account_id and is_active is true and id <> v_asset.id) then
      return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL', 'error', 'Another asset already carries this account. Refresh the suggestion.', 'field', 'source_financial_account_id');
    end if;
    for v_field in
      select pf.field_name, pf.existing_value from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'asset_name'     then nullif(trim(both from coalesce(v_asset.asset_name, '')), '')
        when 'asset_class'    then nullif(trim(both from coalesce(v_asset.asset_class, '')), '')
        when 'current_value'  then case when v_asset.current_value is null then null else round(v_asset.current_value, 2)::text end
        when 'currency_code'  then nullif(trim(both from coalesce(v_asset.currency_code::text, '')), '')
        when 'valuation_date' then case when v_asset.valuation_date is null then null else v_asset.valuation_date::text end
        when 'owner'          then nullif(trim(both from coalesce(v_asset.owner, '')), '')
        else null
      end;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'This asset changed after the suggestion was prepared, so it was not applied. Refresh the suggestion.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text);
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  for v_field in
    select pf.field_name, pf.proposed_value from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_lit := 'NULL';
    elsif v_kind = 'money' then
      v_lit := format('%L::numeric', v_field.proposed_value);
    elsif v_kind = 'date' then
      v_lit := format('%L::date', v_field.proposed_value);
    else
      v_lit := format('%L', v_field.proposed_value);
    end if;
    v_set_parts := array_append(v_set_parts, format('%I = %s', v_field.field_name, v_lit));
    v_cols := array_append(v_cols, quote_ident(v_field.field_name));
    v_vals := array_append(v_vals, v_lit);
    v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
    v_applied_fields := array_append(v_applied_fields, v_field.field_name);
    if p_decision = 'add_new' then
      v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
    end if;
  end loop;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now() where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This balance has already been added to your assets.');
  end if;

  if p_decision = 'add_new' then
    if not ('owner' = any(v_selected)) then
      v_cols := array_append(v_cols, 'owner');
      v_vals := array_append(v_vals, quote_literal('self'));
    end if;
    execute format('insert into assets (user_id, is_active, %s) values (%L::uuid, true, %s) returning id',
      array_to_string(v_cols, ', '), v_uid, array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update assets set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_statement_upload_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'asset', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_stmt.id, v_uid
  ) returning id into v_application_id;

  update assets
    set source_type = 'bank_statement_import', source_financial_account_id = v_stmt.financial_account_id,
        last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);
  return jsonb_build_object('ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id, 'applied_fields', to_jsonb(v_applied_fields));
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh15_apply_asset_proposal(uuid, text, text[]) from public;
grant execute on function fdh15_apply_asset_proposal(uuid, text, text[]) to authenticated, service_role;
