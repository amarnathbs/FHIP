-- 0267 promo and premium data retention and scheduled cleanup (part A of D)
-- =============================================================================
-- NEW migration on top of 0266. Nothing applied is edited. Item 7 of the hardening mission.
--
-- WHAT THIS ADDS
--   * a policy table with one named retention period per data set (the periods are PROPOSALS for PO approval,
--     each is one row that can be changed without a migration),
--   * legal hold rows that pause cleanup for a data set or for one user,
--   * an append-only run record, so every cleanup run leaves evidence (dry runs too),
--   * promo_retention_run(): the cleanup, service role only, anonymising instead of deleting where the audit
--     trail needs the row, and handling rows that belong to deleted accounts,
--   * a job control row promo_retention that SHIPS DISABLED, and a pg_cron job registered ONLY on a database
--     that carries the production marker row (it does nothing while the switch is off).
--
-- PROPOSED PERIODS (all disabled until the PO approves and enables the job)
--   promo_redemption_attempts   30 days   delete
--   promo_email_requests        180 days  delete
--   promo_email_sends           180 days  anonymise (the keyed recipient hash is replaced, status kept)
--   premium_expiry_email_ledger 400 days  delete settled rows
--   promo_codes                 365 days  anonymise (after disable or after the redeem by date)
--   promo_code_events           2555 days anonymise (7 years, the actor is replaced, the event stays)
--
-- ACCOUNT DELETION. Redemption rows and reminder ledger rows follow the user by foreign key cascade. Rows
-- with no foreign key (attempts, event actors, e-mail request admins) are cleaned by the orphan step of
-- promo_retention_run, which runs on every pass and does not wait for the age limit.
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to D in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0267: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

alter table public.promo_email_sends add column if not exists anonymised_at timestamptz;
alter table public.promo_code_events add column if not exists anonymised_at timestamptz;

create table if not exists public.promo_retention_policy (
  data_set text primary key,
  retention_days int not null check (retention_days between 1 and 3650),
  action text not null check (action in ('delete', 'anonymise')),
  note text,
  updated_at timestamptz not null default now()
);
comment on table public.promo_retention_policy is
  'Hardening 0267 item 7: one named retention period per promo and premium data set. Proposals pending PO approval. Changing a period is a row update, not a migration.';

insert into public.promo_retention_policy (data_set, retention_days, action, note)
select v.data_set, v.retention_days, v.action, v.note
  from (values
    ('promo_redemption_attempts', public.promo_attempts_retention_days(), 'delete', 'Rate limit ledger. The redeem function also prunes with the same value.'),
    ('promo_email_requests', 180, 'delete', 'Dispatch requests: admin, purpose and counts only.'),
    ('promo_email_sends', 180, 'anonymise', 'Keyed recipient hash replaced, provider id and error cleared, status kept.'),
    ('premium_expiry_email_ledger', 400, 'delete', 'Settled rows only (sent, abandoned, unknown, void).'),
    ('promo_codes', 365, 'anonymise', 'Disabled or past the redeem by date for this long: note and digest cleared, row kept.'),
    ('promo_code_events', 2555, 'anonymise', 'Seven years, then the actor is replaced and the event stays.')
  ) as v(data_set, retention_days, action, note)
 where not exists (select 1 from public.promo_retention_policy p where p.data_set = v.data_set);

create table if not exists public.promo_retention_holds (
  id uuid primary key default gen_random_uuid(),
  data_set text not null check (data_set in ('all', 'promo_redemption_attempts', 'promo_email_requests', 'promo_email_sends',
                                              'premium_expiry_email_ledger', 'promo_codes', 'promo_code_events')),
  user_id uuid,
  reason text not null check (char_length(btrim(reason)) >= 10 and char_length(reason) <= 500),
  created_by text not null default current_user,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by text
);
comment on table public.promo_retention_holds is
  'Hardening 0267 item 7: a legal hold. An open row (released_at is null) with user_id null pauses cleanup of that data set (or all). With a user_id it protects that user rows only.';

create table if not exists public.promo_retention_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  started_at timestamptz not null default now(),
  dry_run boolean not null,
  data_set text not null,
  outcome text not null check (outcome in ('ok', 'skipped_hold', 'skipped_disabled')),
  rows_affected int not null default 0,
  details jsonb not null default '{}'::jsonb
);
create index if not exists idx_promo_retention_runs_time on public.promo_retention_runs (started_at desc);
comment on table public.promo_retention_runs is
  'Hardening 0267 item 7: append-only evidence of every cleanup run, dry runs included. Counts only.';

drop trigger if exists trg_promo_retention_runs_no_change on public.promo_retention_runs;
create trigger trg_promo_retention_runs_no_change before update or delete on public.promo_retention_runs
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_promo_retention_runs_no_truncate on public.promo_retention_runs;
create trigger trg_promo_retention_runs_no_truncate before truncate on public.promo_retention_runs
  for each statement execute function public.promo_hardening_append_only();

alter table public.promo_retention_policy enable row level security;
alter table public.promo_retention_holds enable row level security;
alter table public.promo_retention_runs enable row level security;
revoke all on public.promo_retention_policy, public.promo_retention_holds, public.promo_retention_runs from anon, authenticated;

-- The kill switch row (same table and pattern as the expiry reminder job). Ships disabled.
insert into public.premium_reminder_job_control (job_key, enabled, disabled_reason)
select 'promo_retention', false, 'Shipped disabled. Enable only after the PO approves the retention periods in promo_retention_policy.'
 where not exists (select 1 from public.premium_reminder_job_control where job_key = 'promo_retention');
