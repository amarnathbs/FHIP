-- 0289 -- SMSF fund liabilities (entity-level assets AND liabilities, part 1 of 2).
--
-- WHY. An SMSF could record its assets (smsf_holdings) but had NO place for its own debts: the only route was a
-- PERSONAL liabilities row linked with property_liability_links (smsf_property_loan). That put the fund's debt in the
-- personal register, where it was deducted a second time (the fund balance is already a NET figure). The PO decision of
-- 17-10-2026: enter assets and liabilities separately at entity level and DERIVE the net. Design:
-- docs/architecture/ENTITY_LEVEL_ASSETS_AND_LIABILITIES_DESIGN_2026-10-16.md (section 5).
--
-- WHAT THIS MIGRATION DOES (additive; nothing is dropped, nothing is backfilled, no existing figure moves):
--   1. smsf_liabilities: the fund's own debts, a child of smsf_funds exactly like smsf_holdings (same RLS shape).
--   2. smsf_liabilities_total_aud(): same conversion convention as smsf_holdings_total_aud() in migration 0084.
--   3. smsf_compute_detailed_net_value() now returns holdings minus the fund's own liabilities minus any still-linked
--      legacy personal loans (each loan is counted once: a loan lives in smsf_liabilities OR as a linked personal
--      row, never both, because the move action in migration 0290 retires the personal side in the same transaction).
--      PREDECESSOR (defined by migration 0084, no later migration redefines it): return holdings total minus linked
--      loans total. Only the second term list changes.
--   3b. smsf_recompute_fund() floors only the Retirement-register mirror at zero (a CHECK there forbids negatives); the
--      true net, possibly negative, stays in smsf_funds.detailed_net_value and smsf_fund_counted_net().
--   4. Recompute triggers on smsf_liabilities, security definer with a pinned search_path, exactly the shape migration
--      0137 gave the holdings trigger (account deletion cascades through these tables).
--   5. smsf_create_fund() reuses an ARCHIVED fund row instead of failing on unique(user_id, master_item_key), and takes
--      p_mode (default detailed = itemised, the recommended way to record a fund). The old 7-argument version is
--      dropped and replaced by the 8-argument one (named-argument callers keep working).
--
-- ROLLBACK (safe while no smsf_liabilities row exists; otherwise archive the rows first):
--   drop trigger trg_smsf_liabilities_recompute on smsf_liabilities; drop table smsf_liabilities;
--   then re-create smsf_compute_detailed_net_value() and smsf_create_fund() using the bodies in migration 0084.

begin;

create table if not exists smsf_liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  smsf_fund_id uuid not null references smsf_funds(id) on delete cascade,
  liability_name text not null check (length(btrim(liability_name)) > 0),
  liability_type text not null default 'other' check (liability_type in ('property_loan', 'other_loan', 'tax_payable', 'other')),
  lender text,
  balance numeric(18, 2) not null check (balance >= 0),
  interest_rate numeric(6, 3) check (interest_rate >= 0 and interest_rate <= 100),
  monthly_repayment numeric(18, 2) check (monthly_repayment >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table smsf_liabilities is
  'Entity-level SMSF debts (migration 0289). Counted only while the fund is itemised (smsf_funds.mode = detailed); the fund net is derived as holdings minus these rows (and any still-linked legacy personal loans). Never read by the personal liabilities, DTI or DSR formulas: the exclusion is structural, this is a different table. Soft-retired with is_active, never hard-deleted by the app.';
comment on column smsf_liabilities.balance is 'Outstanding amount, in currency_code. A fund debt is always non-negative; a fund that owes more than it owns shows a negative NET, never a negative liability.';

create index if not exists idx_smsf_liabilities_fund on smsf_liabilities(smsf_fund_id) where is_active;
create index if not exists idx_smsf_liabilities_user on smsf_liabilities(user_id);

alter table smsf_liabilities enable row level security;
drop policy if exists "own rows - smsf liabilities" on smsf_liabilities;
create policy "own rows - smsf liabilities" on smsf_liabilities
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid())
  );

-- Same fx convention as smsf_holdings_total_aud() (migration 0084): INR per 1 AUD, AUD = INR / rate.
create or replace function smsf_liabilities_total_aud(p_fund_id uuid) returns numeric as $$
declare
  fx numeric;
  total numeric;
begin
  select assumption_value into fx
  from forecast_global_assumptions
  where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true
  limit 1;
  fx := coalesce(fx, 56.0);

  select coalesce(sum(case when currency_code = 'INR' then balance / fx else balance end), 0) into total
  from smsf_liabilities
  where smsf_fund_id = p_fund_id and is_active = true;

  return total;
end;
$$ language plpgsql stable;

create or replace function smsf_compute_detailed_net_value(p_fund_id uuid) returns numeric as $$
begin
  return smsf_holdings_total_aud(p_fund_id) - smsf_liabilities_total_aud(p_fund_id) - smsf_linked_loans_total_aud(p_fund_id);
end;
$$ language plpgsql stable;

comment on function smsf_compute_detailed_net_value(uuid) is
  'Itemised SMSF net = active holdings minus the fund''s own active liabilities (smsf_liabilities, 0289) minus any still-linked legacy personal loans (property_liability_links, 0084). Derived, never typed.';

-- The fund row in the Retirement register mirrors the derived net, but retirement_accounts.current_balance carries a
-- CHECK (current_balance >= 0) (migration 0003). A fund that owes more than it owns has a genuinely NEGATIVE net, which
-- smsf_funds.detailed_net_value keeps exactly (PO decision: a negative entity net flows through as negative); only the
-- retirement mirror is floored at zero. Anything that wants the true net reads smsf_fund_counted_net(), never the mirror.
-- PREDECESSOR: smsf_recompute_fund() as re-declared by migration 0148 (security definer, certified balance bracket); the
-- only change is greatest(v_net, 0) on the mirror write.
create or replace function smsf_recompute_fund(p_fund_id uuid) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_retirement_account_id uuid;
  v_net numeric;
begin
  select mode, retirement_account_id into v_mode, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    return null;
  end if;

  v_net := smsf_compute_detailed_net_value(p_fund_id);

  update smsf_funds set detailed_net_value = v_net, updated_at = now() where id = p_fund_id;

  if v_mode = 'detailed' then
    perform set_config('fhip.smsf_balance_write', 'certified', true);
    update retirement_accounts set current_balance = greatest(v_net, 0), updated_at = now()
    where id = v_retirement_account_id;
    perform set_config('fhip.smsf_balance_write', '', true);
  end if;

  return v_net;
end;
$$;

-- The net that is COUNTED for a fund: the derived net while itemised (may be negative), the typed net while net value only.
create or replace function smsf_fund_counted_net(p_fund_id uuid) returns numeric as $$
  select case when f.mode = 'detailed' then coalesce(f.detailed_net_value, 0) else coalesce(f.summary_balance, 0) end
  from smsf_funds f where f.id = p_fund_id;
$$ language sql stable;

create or replace function trg_smsf_recompute_from_liability_row() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform smsf_recompute_fund(coalesce(new.smsf_fund_id, old.smsf_fund_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_smsf_liabilities_recompute on smsf_liabilities;
create trigger trg_smsf_liabilities_recompute
  after insert or update of balance, currency_code, is_active or delete on smsf_liabilities
  for each row execute function trg_smsf_recompute_from_liability_row();

-- smsf_create_fund(): reuse an archived fund row, and choose the recording mode.
-- The 7-argument version defined in migration 0084 is replaced (a second overload would make named-argument calls ambiguous).
drop function if exists smsf_create_fund(text, text, numeric, date, text, char(3), char(2));

create or replace function smsf_create_fund(
  p_account_name text,
  p_fund_name text,
  p_summary_balance numeric default null,
  p_summary_balance_date date default null,
  p_owner text default 'self',
  p_currency_code char(3) default 'AUD',
  p_country_code char(2) default 'AU',
  p_mode text default 'detailed'
) returns table (retirement_account_id uuid, smsf_fund_id uuid) as $$
declare
  v_uid uuid := auth.uid();
  v_ra_id uuid;
  v_ra_active boolean;
  v_fund_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  if p_mode not in ('detailed', 'summary') then
    raise exception 'smsf: p_mode must be detailed (itemised) or summary (net value only)' using errcode = '22023';
  end if;
  if p_mode = 'summary' and (p_summary_balance is null or p_summary_balance < 0) then
    raise exception 'smsf: a net value is required when the fund is recorded as a net value only' using errcode = '23514';
  end if;

  select ra.id, ra.is_active into v_ra_id, v_ra_active
  from retirement_accounts ra
  where ra.user_id = v_uid and ra.master_item_key = 'smsf';

  if v_ra_id is not null and v_ra_active then
    raise exception 'smsf: you already have an SMSF fund; edit it instead of creating another' using errcode = '23505';
  end if;

  if v_ra_id is not null then
    -- An ARCHIVED fund row holds the unique key: bring it back instead of failing, keeping its recording mode and lines.
    update retirement_accounts
    set is_active = true, account_name = p_account_name, owner = p_owner, updated_at = now()
    where id = v_ra_id;

    select f.id into v_fund_id from smsf_funds f where f.retirement_account_id = v_ra_id;
    if v_fund_id is not null then
      update smsf_funds set is_active = true, fund_name = p_fund_name, updated_at = now() where id = v_fund_id;
      perform smsf_recompute_fund(v_fund_id);
      return query select v_ra_id, v_fund_id;
      return;
    end if;
  else
    insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
    values (v_uid, p_account_name, 'super', coalesce(case when p_mode = 'summary' then p_summary_balance end, 0), p_currency_code, p_country_code, p_owner, 'smsf', true)
    returning id into v_ra_id;
  end if;

  if p_mode = 'summary' then
    insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code)
    values (v_uid, v_ra_id, p_fund_name, 'summary', p_summary_balance, p_summary_balance_date, p_currency_code)
    returning id into v_fund_id;
  else
    insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code, activated_detailed_at)
    values (v_uid, v_ra_id, p_fund_name, 'detailed', null, null, p_currency_code, now())
    returning id into v_fund_id;
  end if;

  return query select v_ra_id, v_fund_id;
end;
$$ language plpgsql;

comment on function smsf_create_fund(text, text, numeric, date, text, char(3), char(2), text) is
  'Atomic SMSF fund creation (retirement_accounts + smsf_funds together), 0289. p_mode detailed (default) = itemised: no typed net, assets and liabilities are entered afterwards and the net is derived. p_mode summary = a typed net value only. An archived fund row is reused (it holds unique(user_id, master_item_key)). Runs as the invoking role: RLS, the AU gate (migration 0084) and the balance guard (0090) apply exactly as for a direct insert.';

commit;
