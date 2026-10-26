-- 0304 -- Retirement contribution FLOW ledger (Document2 (4) F25 / F25b).
--
-- WHY. A retirement contribution is a FLOW (an amount paid in over time), not a balance. Until now the only place a contribution could
-- live was three columns on retirement_accounts (employer_contribution, personal_contribution, contribution_frequency), entered in the
-- same form as the balance, with one frequency for both. There was no history, no provenance, no way to say which payslip a figure came
-- from, and no way to stop a payslip and a manual entry both describing the same contribution.
--
-- WHAT THIS ADDS. ONE new table, public.retirement_contributions: one row per recorded contribution (or per recurring contribution),
-- with member, destination account, type, amount, frequency or date, currency, source (manual or payslip) and the payslip it came
-- from. The payslip source is UNIQUE per payslip and contribution type, so the same payslip can never create a second row.
--   * A payslip contribution waits in status 'needs_destination' (no destination account) until the person chooses where it goes.
--   * status 'superseded' = a revised payslip replaced the earlier one; 'removed' = the person removed it. Rows are never deleted by
--     the application, so history is kept.
--   * The destination must belong to the same person. A destination of kind 'smsf' must be the SMSF fund's own retirement account
--     (master_item_key smsf); kind 'retirement_account' must NOT be. A trigger enforces this so a forged request cannot cross either line.
--   * Row level security: each person sees and changes only their own rows.
--
-- WHAT THIS DOES NOT DO. It changes no existing row and no existing column. It does not copy any existing account contribution
-- figure; those stay exactly where they are until the person records a contribution for that account (the application then asks
-- before replacing it, never silently). It adds no secret and needs no data backup, because nothing existing is touched.
--
-- Additive, idempotent (safe to run twice), forward-only.

create table if not exists public.retirement_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Where the money goes. Null only while the person still has to choose (status needs_destination).
  retirement_account_id uuid references public.retirement_accounts(id) on delete cascade,
  destination_kind text check (destination_kind in ('retirement_account', 'smsf')),
  retirement_member_id uuid references public.retirement_members(id) on delete set null,

  contribution_type text not null
    check (contribution_type in ('employer', 'salary_sacrifice', 'personal', 'spouse', 'government')),
  amount numeric(18, 2) not null check (amount > 0),
  currency_code char(3) not null references public.currencies(currency_code),
  -- Recurring rate (frequency) or a dated one-off (contribution_date); at least one is required.
  frequency text check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  contribution_date date,

  source_type text not null check (source_type in ('manual', 'payslip')),
  -- The payslip this row came from. Unique per payslip and type: a second upload of the same payslip cannot add a second row.
  source_payroll_event_id uuid references public.fdh_payroll_events(id) on delete set null,
  -- The raw payslip line the destination was matched on, and how it was matched (for the person to check; never used as a key).
  source_label text,
  employer_name text,
  employer_normalised text,
  matched_by text check (matched_by in ('fund_name', 'user_choice', 'manual')),

  status text not null default 'active'
    check (status in ('active', 'needs_destination', 'superseded', 'removed')),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retirement_contributions_rate_or_date check (frequency is not null or contribution_date is not null),
  constraint retirement_contributions_destination_state check (
    (status = 'needs_destination' and retirement_account_id is null)
    or (status = 'active' and retirement_account_id is not null)
    or status in ('superseded', 'removed')
  ),
  -- A manual row never names a payslip. A payslip row may lose its payslip reference later (the payslip evidence was deleted), never gain a manual flag.
  constraint retirement_contributions_manual_has_no_payslip check (source_type = 'payslip' or source_payroll_event_id is null),
  constraint retirement_contributions_destination_kind_with_account check (
    retirement_account_id is null or destination_kind is not null
  )
);

create unique index if not exists uq_retirement_contributions_payslip
  on public.retirement_contributions (user_id, source_payroll_event_id, contribution_type)
  where source_payroll_event_id is not null;
create index if not exists idx_retirement_contributions_user on public.retirement_contributions (user_id, status);
create index if not exists idx_retirement_contributions_account on public.retirement_contributions (retirement_account_id) where retirement_account_id is not null;

comment on table public.retirement_contributions is
  'Retirement contribution flow ledger: one row per contribution or recurring contribution, with provenance (manual or payslip). A flow, never a balance.';

-- The destination must belong to the same person, and its kind must match the account: smsf = the SMSF fund account, otherwise not.
create or replace function public.retirement_contributions_validate_destination() returns trigger as $$
declare
  acct_user uuid;
  acct_key text;
  member_user uuid;
begin
  if new.retirement_account_id is not null then
    select user_id, master_item_key into acct_user, acct_key from public.retirement_accounts where id = new.retirement_account_id;
    if acct_user is distinct from new.user_id then
      raise exception 'retirement_contributions: destination account must belong to the same user' using errcode = '42501';
    end if;
    if new.destination_kind = 'smsf' and acct_key is distinct from 'smsf' then
      raise exception 'retirement_contributions: an SMSF destination must be the SMSF fund account' using errcode = '23514';
    end if;
    if new.destination_kind = 'retirement_account' and acct_key is not distinct from 'smsf' then
      raise exception 'retirement_contributions: the SMSF fund account must use destination kind smsf' using errcode = '23514';
    end if;
  end if;
  if new.retirement_member_id is not null then
    select user_id into member_user from public.retirement_members where id = new.retirement_member_id;
    if member_user is distinct from new.user_id then
      raise exception 'retirement_contributions: member must belong to the same user' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_retirement_contributions_validate on public.retirement_contributions;
create trigger trg_retirement_contributions_validate
  before insert or update on public.retirement_contributions
  for each row execute function public.retirement_contributions_validate_destination();

alter table public.retirement_contributions enable row level security;

drop policy if exists "own rows - retirement_contributions" on public.retirement_contributions;
create policy "own rows - retirement_contributions" on public.retirement_contributions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
