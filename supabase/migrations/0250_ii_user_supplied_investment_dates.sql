-- 0250 -- User-supplied investment date for a holdings-only position
-- (Document2 defect D-3, PO decision 2026-10-03).
--
-- A statement can give a HOLDING (units, a value, an as-of date) with no
-- purchase date at all. The product now asks the user for the investment date,
-- validates it, takes the fund's NAV on that date, and writes ONE derived
-- 'purchase' row into ii_transactions (source_reference
-- 'USER_INVESTMENT_DATE:<input id>') so every existing reader -- the India MF
-- report, performance, tax lots -- computes exactly as if a statement had
-- carried the date. This table is the AUDITABLE, EDITABLE record of what the
-- user said and what was derived from it.
--
-- WHAT THIS ADDS
--   public.ii_investment_date_inputs   one row per user answer. Editing the
--                                      date supersedes the old row (never an
--                                      in-place overwrite) so the history of
--                                      what the user said stays.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It alters no existing table, drops no constraint, widens no CHECK (the
--     0185-vs-0180 trap). The derived transaction uses columns, a type and a
--     status that already exist.
--   * It adds no audit event type: the application uses the existing
--     'user_correction' event with a metadata.kind, so ii_audit_events'
--     CHECK is untouched.
--   * It touches no ownership table. Owner / joint / entity allocation of the
--     account is unchanged; the derived row hangs off the same account.
--
-- RLS: a user may READ their own rows. There is NO insert/update/delete policy
-- for the authenticated role: every write goes through the service-role client
-- in server code that has already checked the account belongs to the caller
-- (same forgery-guard discipline as ii_transactions, migration 0087). So a raw
-- PostgREST call cannot forge a date, a provenance or a derived-transaction link.
--
-- DISCIPLINE: additive, idempotent (safe to run twice), guarded (refuses to run
-- on a database missing what it references).
--
-- APPLY AFTER: 0033 (ii_transactions, ii_holding_snapshots), 0032
-- (ii_accounts), 0031 (ii_instruments). Nothing else is required; it does not
-- depend on 0242-0249.

do $$
begin
  if to_regclass('public.ii_transactions') is null
     or to_regclass('public.ii_holding_snapshots') is null
     or to_regclass('public.ii_accounts') is null
     or to_regclass('public.ii_instruments') is null then
    raise exception '0250: the Investment Intelligence tables (ii_accounts, ii_instruments, ii_transactions, ii_holding_snapshots) must exist first';
  end if;
end $$;

create table if not exists public.ii_investment_date_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.ii_accounts(id) on delete cascade,
  instrument_id uuid not null references public.ii_instruments(id),
  investment_date date not null,
  -- Only one provenance exists today. Named so a later source (e.g. an admin
  -- correction) is an explicit, reviewed addition, not an accident.
  provenance text not null default 'user_supplied' constraint ii_investment_date_inputs_provenance_check check (provenance in ('user_supplied')),
  -- awaiting_nav : the date is saved, no NAV on/just before it is on file yet.
  -- applied      : the derived purchase row exists and is in use.
  -- superseded   : the user changed the date (a newer row replaced this one) or
  --                a statement with real history replaced it.
  status text not null default 'awaiting_nav' constraint ii_investment_date_inputs_status_check check (status in ('awaiting_nav', 'applied', 'superseded')),
  -- What the derivation used, kept so the number can be explained later.
  units_at_capture numeric(20, 6) not null check (units_at_capture > 0),
  snapshot_id uuid references public.ii_holding_snapshots(id) on delete set null,
  snapshot_as_of_date date,
  nav_price numeric(20, 6),
  nav_date date,
  derived_transaction_id uuid references public.ii_transactions(id) on delete set null,
  supersede_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one LIVE answer per position. Superseded rows accumulate as history.
create unique index if not exists uidx_ii_investment_date_inputs_active
  on public.ii_investment_date_inputs (user_id, account_id, instrument_id)
  where status in ('awaiting_nav', 'applied');

create index if not exists idx_ii_investment_date_inputs_user
  on public.ii_investment_date_inputs (user_id, status);

alter table public.ii_investment_date_inputs enable row level security;

-- Defence in depth (same as 0240): the default privileges Supabase grants in
-- `public` would otherwise leave INSERT/UPDATE/DELETE to the API roles, held back
-- only by the absence of a policy. Revoke them so a missing or future policy
-- can never open a write path; the service role (server code) is unaffected.
revoke insert, update, delete, truncate on public.ii_investment_date_inputs from anon, authenticated;

drop policy if exists "read own ii_investment_date_inputs" on public.ii_investment_date_inputs;
create policy "read own ii_investment_date_inputs" on public.ii_investment_date_inputs
  for select using (auth.uid() = user_id);

comment on table public.ii_investment_date_inputs is
  'User-supplied investment date for a holdings-only position (0250). provenance=user_supplied. The derived purchase lives in ii_transactions with source_reference USER_INVESTMENT_DATE:<id>. Server-write-only (no authenticated insert/update/delete policy).';
