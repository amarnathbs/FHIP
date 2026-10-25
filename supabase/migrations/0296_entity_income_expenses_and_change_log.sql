-- 0296 -- Entity-level income and expenses (SMSF, Company, Family Trust, HUF) and the append-only entity change log
-- (DOCUMENT2 (4) review, work package C, findings F22, F23 and F23b). Additive only, forward only.
--
-- WHAT THE PO FOUND. An SMSF had no income or expense of its own. Its rent, interest, fees and so on had to be typed in the PERSONAL Income
-- and Expenses pages with the owner set to SMSF, and the rent option on a property asset only pointed at one of those personal records, with no
-- way to state the rent amount. A Company, Family Trust or HUF had no income or expenses at all. The PO asked for the same level of income,
-- expenses, assets and liabilities at ENTITY level for every entity, never mixed in with personal Income and Expenses.
--
-- WHAT THIS ADDS.
--   entity_income_items     one row per income stream of an entity: rent (amount AND frequency, tied to the property asset it comes from),
--                           interest, dividends, distributions, trading revenue, other. Scoped to ONE entity: an SMSF fund or a registered
--                           Company, Family Trust or HUF.
--   entity_expense_items    one row per recurring cost of an entity. There is deliberately NO loan repayment type: the principal of a loan is a
--                           cash flow, never an expense, and it is derived by FHIP out of the entity liabilities, not typed here.
--   entity_change_log       append-only audit trail, who changed which entity row and how. Written only by the triggers below.
--   smsf_entity_move_personal_cash_flow()   preview-first, atomic move of a legacy personal income or expense row tagged SMSF to the fund.
--
-- NOTHING IS COUNTED TWICE.
--   a. These tables are never read by the personal Income, Expenses, DTI or DSR formulas. The separation is structural, a different table.
--   b. One rent record per property asset: a partial unique index refuses a second active rent record for the same asset, and a rent record is
--      refused while the asset still points at a personal income record (the earlier way), so a flow is never in both places.
--   c. A legacy personal row tagged SMSF is moved, not copied: the move retires the personal row in the same transaction.
--
-- TENANCY. Row level security: the owner only, and the parent entity must belong to the caller, so a forged fund or entity id of another
-- household cannot be attached. A trigger repeats the ownership checks and also checks that a Company, Trust or HUF row matches the entity type.
--
-- ROLLBACK: drop the two move triggers and function, then the tables entity_income_items, entity_expense_items, entity_change_log. Safe while the
-- tables are empty, otherwise export them first.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Audit trail: append-only
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_change_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  entity_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert', 'update', 'retire', 'moved_from_personal')),
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

comment on table entity_change_log is
  'Append-only audit trail of changes to entity level rows (migration 0296): who, which entity, which table and row, what it was and what it became. Written only by triggers and the move function, the owner can read it and can neither update nor delete it.';

create index if not exists idx_entity_change_log_entity on entity_change_log(entity_id, created_at desc);
create index if not exists idx_entity_change_log_user on entity_change_log(user_id);

alter table entity_change_log enable row level security;
drop policy if exists own_rows_entity_change_log_read on entity_change_log;
create policy own_rows_entity_change_log_read on entity_change_log for select using (auth.uid() = user_id);

create or replace function entity_change_log_append_only() returns trigger as $fn$
begin
  raise exception 'entity_change_log is append-only' using errcode = '42501';
end;
$fn$ language plpgsql;

drop trigger if exists trg_entity_change_log_no_update on entity_change_log;
create trigger trg_entity_change_log_no_update
  before update on entity_change_log
  for each row execute function entity_change_log_append_only();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Income
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_income_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  smsf_fund_id uuid references smsf_funds(id) on delete cascade,
  business_entity_id uuid references business_entities(id) on delete cascade,
  income_type text not null check (income_type in ('rent', 'interest', 'dividends', 'distributions', 'trading_revenue', 'other')),
  income_name text not null check (length(btrim(income_name)) > 0),
  amount numeric(18, 2) not null check (amount >= 0),
  frequency text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  smsf_holding_id uuid references smsf_holdings(id) on delete set null,
  business_entity_asset_id uuid references business_entity_assets(id) on delete set null,
  source_type text not null default 'manual' check (source_type in ('manual', 'statement_import', 'moved_from_personal')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_entity_income_scope check (
    (entity_kind = 'smsf' and smsf_fund_id is not null and business_entity_id is null)
    or (entity_kind <> 'smsf' and business_entity_id is not null and smsf_fund_id is null)
  ),
  constraint chk_entity_income_rent_needs_amount check (income_type <> 'rent' or amount > 0),
  constraint chk_entity_income_asset_link check (
    (smsf_holding_id is null or (income_type = 'rent' and entity_kind = 'smsf'))
    and (business_entity_asset_id is null or (income_type = 'rent' and entity_kind <> 'smsf'))
  )
);

comment on table entity_income_items is
  'Income of ONE entity (an SMSF fund or a registered Company, Family Trust or HUF), migration 0296. Entity scoped, never read by personal Income, DTI or DSR. Rent needs an amount and a frequency and may be tied to the property asset it comes from, one active rent record per asset.';

create unique index if not exists uq_entity_income_rent_per_smsf_asset
  on entity_income_items(smsf_holding_id) where income_type = 'rent' and is_active and smsf_holding_id is not null;
create unique index if not exists uq_entity_income_rent_per_entity_asset
  on entity_income_items(business_entity_asset_id) where income_type = 'rent' and is_active and business_entity_asset_id is not null;
create index if not exists idx_entity_income_smsf on entity_income_items(smsf_fund_id) where is_active and smsf_fund_id is not null;
create index if not exists idx_entity_income_business on entity_income_items(business_entity_id) where is_active and business_entity_id is not null;
create index if not exists idx_entity_income_user on entity_income_items(user_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Expenses
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_expense_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  smsf_fund_id uuid references smsf_funds(id) on delete cascade,
  business_entity_id uuid references business_entities(id) on delete cascade,
  expense_type text not null check (expense_type in ('property_costs', 'insurance', 'accounting_audit', 'admin_fees', 'investment_fees', 'taxes_levies', 'bank_fees', 'other')),
  expense_name text not null check (length(btrim(expense_name)) > 0),
  amount numeric(18, 2) not null check (amount >= 0),
  frequency text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  source_type text not null default 'manual' check (source_type in ('manual', 'statement_import', 'moved_from_personal')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_entity_expense_scope check (
    (entity_kind = 'smsf' and smsf_fund_id is not null and business_entity_id is null)
    or (entity_kind <> 'smsf' and business_entity_id is not null and smsf_fund_id is null)
  )
);

comment on table entity_expense_items is
  'Recurring costs of ONE entity, migration 0296. There is no loan repayment type: principal is a cash flow derived out of the entity liabilities, never an expense row. Entity scoped, never read by personal Expenses, DTI or DSR.';

create index if not exists idx_entity_expense_smsf on entity_expense_items(smsf_fund_id) where is_active and smsf_fund_id is not null;
create index if not exists idx_entity_expense_business on entity_expense_items(business_entity_id) where is_active and business_entity_id is not null;
create index if not exists idx_entity_expense_user on entity_expense_items(user_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Row level security, the same shape on both tables
-- ---------------------------------------------------------------------------------------------------------------------
alter table entity_income_items enable row level security;
drop policy if exists own_rows_entity_income_items on entity_income_items;
create policy own_rows_entity_income_items on entity_income_items
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      (entity_kind = 'smsf' and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid()))
      or (entity_kind <> 'smsf' and business_entity_id in (select id from business_entities where user_id = auth.uid()))
    )
  );

alter table entity_expense_items enable row level security;
drop policy if exists own_rows_entity_expense_items on entity_expense_items;
create policy own_rows_entity_expense_items on entity_expense_items
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      (entity_kind = 'smsf' and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid()))
      or (entity_kind <> 'smsf' and business_entity_id in (select id from business_entities where user_id = auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Scope rule. The entity belongs to the caller, a Company Trust or HUF row matches the entity type, a rent record ties only to a property
--    asset of the same entity and never while the asset still points at a personal income record
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_income_rent_rule(r entity_income_items) returns void as $fn$
declare
  v_legacy uuid;
begin
  if r.income_type = 'rent' and r.is_active then
    if r.smsf_holding_id is not null then
      if not exists (
        select 1 from smsf_holdings h
        where h.id = r.smsf_holding_id and h.smsf_fund_id = r.smsf_fund_id and h.user_id = r.user_id and h.holding_class = 'property'
      ) then
        raise exception 'ENTITY_RENT_ASSET: rent can only be tied to a property asset of the same fund' using errcode = '23514';
      end if;
      select h.linked_income_source_id into v_legacy from smsf_holdings h where h.id = r.smsf_holding_id;
      if v_legacy is not null and exists (select 1 from income_sources s where s.id = v_legacy and s.is_active) then
        raise exception 'ENTITY_RENT_ALREADY_RECORDED: this property already points at an income record entered the earlier way, move that record to the fund instead of adding the rent twice'
          using errcode = '23505';
      end if;
    end if;
    if r.business_entity_asset_id is not null then
      if not exists (
        select 1 from business_entity_assets a
        where a.id = r.business_entity_asset_id and a.business_entity_id = r.business_entity_id and a.user_id = r.user_id
      ) then
        raise exception 'ENTITY_RENT_ASSET: rent can only be tied to an asset of the same entity' using errcode = '23514';
      end if;
    end if;
  end if;
end;
$fn$ language plpgsql;

create or replace function entity_item_scope_rule() returns trigger as $fn$
declare
  v_type text;
  v_user uuid;
begin
  if new.entity_kind = 'smsf' then
    select f.user_id into v_user from smsf_funds f where f.id = new.smsf_fund_id;
    if v_user is distinct from new.user_id then
      raise exception 'ENTITY_NOT_YOURS: that fund was not found' using errcode = '42501';
    end if;
  else
    select e.user_id, e.entity_type into v_user, v_type from business_entities e where e.id = new.business_entity_id;
    if v_user is distinct from new.user_id then
      raise exception 'ENTITY_NOT_YOURS: that entity was not found' using errcode = '42501';
    end if;
    if v_type is distinct from new.entity_kind then
      raise exception 'ENTITY_KIND_MISMATCH: this record says it belongs to a different kind of entity' using errcode = '23514';
    end if;
  end if;

  if tg_table_name = 'entity_income_items' then
    perform entity_income_rent_rule(new);
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_entity_income_scope on entity_income_items;
create trigger trg_entity_income_scope
  before insert or update of entity_kind, smsf_fund_id, business_entity_id, smsf_holding_id, business_entity_asset_id, income_type, is_active on entity_income_items
  for each row execute function entity_item_scope_rule();

drop trigger if exists trg_entity_expense_scope on entity_expense_items;
create trigger trg_entity_expense_scope
  before insert or update of entity_kind, smsf_fund_id, business_entity_id on entity_expense_items
  for each row execute function entity_item_scope_rule();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Audit triggers. They fire on insert and on a change of a meaningful column, not on the link being cleared when an asset is deleted
--    (that keeps an account deletion cascade clear of the log)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_item_audit() returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := case when new.source_type = 'moved_from_personal' then 'moved_from_personal' else 'insert' end;
  elsif new.is_active = false and old.is_active then
    v_action := 'retire';
  else
    v_action := 'update';
  end if;
  insert into entity_change_log(user_id, entity_kind, entity_id, table_name, row_id, action, old_values, new_values)
  values (
    new.user_id, new.entity_kind, coalesce(new.smsf_fund_id, new.business_entity_id), tg_table_name, new.id, v_action,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new)
  );
  return new;
end;
$fn$;

revoke all on function entity_item_audit() from public;

drop trigger if exists trg_entity_income_audit on entity_income_items;
create trigger trg_entity_income_audit
  after insert or update of income_type, income_name, amount, frequency, currency_code, notes, is_active on entity_income_items
  for each row execute function entity_item_audit();

drop trigger if exists trg_entity_expense_audit on entity_expense_items;
create trigger trg_entity_expense_audit
  after insert or update of expense_type, expense_name, amount, frequency, currency_code, notes, is_active on entity_expense_items
  for each row execute function entity_item_audit();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Move a legacy personal income or expense row tagged SMSF to the fund (preview first, one transaction)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_income_type_for(p_master_key text, p_income_type text) returns text as $fn$
  select case
    when p_master_key in ('rental_income', 'airbnb_income') or p_income_type = 'rental' then 'rent'
    when p_master_key = 'interest_income' then 'interest'
    when p_master_key = 'dividend_income' then 'dividends'
    when p_master_key in ('trust_distribution', 'managed_fund_distribution', 'partnership_distribution') then 'distributions'
    else 'other'
  end;
$fn$ language sql immutable;

create or replace function smsf_entity_move_personal_cash_flow(
  p_fund_id uuid,
  p_register text,
  p_row_id uuid,
  p_confirm boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_inc record;
  v_exp record;
  v_type text;
  v_holding uuid;
  v_new_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund not found', errcode = 'P0002';
  end if;
  if p_register not in ('income', 'expenses') then
    raise exception 'smsf: the register must be income or expenses' using errcode = '22023';
  end if;

  if p_register = 'income' then
    select * into v_inc from income_sources where id = p_row_id and user_id = v_uid and owner = 'smsf' and is_active;
    if not found then
      raise exception using message = 'smsf: that income record was not found or is not tagged to the SMSF', errcode = 'P0002';
    end if;
    v_type := entity_income_type_for(v_inc.master_item_key, v_inc.income_type);
    select h.id into v_holding from smsf_holdings h
      where h.smsf_fund_id = p_fund_id and h.user_id = v_uid and h.linked_income_source_id = p_row_id and h.is_active limit 1;
    if not p_confirm then
      return jsonb_build_object('status', 'preview', 'register', 'income', 'name', v_inc.source_name, 'amount', v_inc.amount,
                                'frequency', v_inc.frequency, 'currency_code', v_inc.currency_code, 'income_type', v_type,
                                'property_asset_id', v_holding);
    end if;
    if v_holding is not null then
      update smsf_holdings set linked_income_source_id = null, updated_at = now() where id = v_holding;
    end if;
    update income_sources set is_active = false, updated_at = now() where id = p_row_id and user_id = v_uid;
    insert into entity_income_items(user_id, entity_kind, smsf_fund_id, income_type, income_name, amount, frequency, currency_code, country_code, smsf_holding_id, source_type)
    values (v_uid, 'smsf', p_fund_id, v_type, v_inc.source_name, v_inc.amount, v_inc.frequency, v_inc.currency_code, 'AU',
            case when v_type = 'rent' then v_holding else null end, 'moved_from_personal')
    returning id into v_new_id;
    return jsonb_build_object('status', 'applied', 'register', 'income', 'entity_item_id', v_new_id);
  end if;

  select * into v_exp from expense_items where id = p_row_id and user_id = v_uid and owner = 'smsf' and is_active;
  if not found then
    raise exception using message = 'smsf: that expense record was not found or is not tagged to the SMSF', errcode = 'P0002';
  end if;
  if v_exp.expense_category = 'debt_repayment' then
    raise exception 'ENTITY_NOT_AN_EXPENSE: a loan repayment is a cash flow, not an expense, record the loan on the fund and FHIP works out the repayment'
      using errcode = '22023';
  end if;
  v_type := case when v_exp.expense_category = 'insurance' then 'insurance' when v_exp.expense_category = 'housing' then 'property_costs' else 'other' end;
  if not p_confirm then
    return jsonb_build_object('status', 'preview', 'register', 'expenses', 'name', v_exp.expense_name, 'amount', v_exp.amount,
                              'frequency', v_exp.frequency, 'currency_code', v_exp.currency_code, 'expense_type', v_type);
  end if;
  update expense_items set is_active = false, updated_at = now() where id = p_row_id and user_id = v_uid;
  insert into entity_expense_items(user_id, entity_kind, smsf_fund_id, expense_type, expense_name, amount, frequency, currency_code, country_code, source_type)
  values (v_uid, 'smsf', p_fund_id, v_type, v_exp.expense_name, v_exp.amount, v_exp.frequency, v_exp.currency_code, 'AU', 'moved_from_personal')
  returning id into v_new_id;
  return jsonb_build_object('status', 'applied', 'register', 'expenses', 'entity_item_id', v_new_id);
end;
$fn$;

revoke all on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) from public;
revoke all on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) from anon;
grant execute on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) to authenticated;

comment on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) is
  'Moves a legacy personal income or expense row tagged SMSF to the fund, preview first, one transaction: the personal row is retired and the fund record is created, so the flow is counted once. A rent record also takes over the property asset link. A loan repayment is refused, it is a cash flow derived out of the fund liabilities, never an expense.';

commit;
