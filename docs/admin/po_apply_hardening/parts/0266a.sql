-- 0266 promo e-mail abuse controls and reconcilable dispatch (part A of D)
-- =============================================================================
-- NEW migration on top of 0265 (apply 0264 and 0265 first). 0242 is NOT edited. The functions it created
-- are dropped and recreated here with the same security mode, the same empty search_path and the same
-- grants (authenticated for the admin functions).
--
-- WHAT THIS ADDS (items 8 and 9 of the hardening mission)
--   * a purpose, a kind (create or replace) and the replaced code on every dispatch request, so each
--     request records who started it, why, and for how many recipients (never an address, never a code),
--   * named limits in one function: recipients per admin per rolling 24 hours, recipients across all
--     admins per rolling 24 hours, replacements per code per 24 hours, and the circuit breaker settings,
--   * an advisory lock around the begin step so two simultaneous requests cannot both slip under a limit,
--   * monitoring rows (admin_monitoring_events) when volume gets unusual or a request is refused,
--   * a circuit breaker for the mail provider (service role only) and a status function that lets the
--     admin who started a request see the state of every recipient WITHOUT any plain address or code.
--
-- NOTHING IS SWITCHED ON: sending is still governed by PREMIUM_PROMO_EMAIL_ENABLED (default off).
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to D in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0266: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

alter table public.promo_email_requests add column if not exists purpose text;
alter table public.promo_email_requests add column if not exists kind text not null default 'create';
alter table public.promo_email_requests add column if not exists replaces_promo_code_id uuid;

do $fn$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_email_requests_kind_check' and conrelid = 'public.promo_email_requests'::regclass) then
    alter table public.promo_email_requests add constraint promo_email_requests_kind_check check (kind in ('create', 'replace'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promo_email_requests_purpose_check' and conrelid = 'public.promo_email_requests'::regclass) then
    alter table public.promo_email_requests add constraint promo_email_requests_purpose_check
      check (purpose is null or (char_length(btrim(purpose)) between 10 and 200));
  end if;
end $fn$;
create index if not exists idx_promo_email_requests_time on public.promo_email_requests (created_at desc);
create index if not exists idx_promo_email_requests_replaces on public.promo_email_requests (replaces_promo_code_id, created_at desc) where replaces_promo_code_id is not null;

comment on column public.promo_email_requests.purpose is
  'Hardening 0266 item 9: why the admin sent this (10 to 200 characters). Null only on rows written before 0266.';
comment on column public.promo_email_requests.kind is
  'Hardening 0266 item 9: create (a new code created and sent) or replace (a replacement for an existing code).';
comment on column public.promo_email_requests.replaces_promo_code_id is
  'Hardening 0266 item 9: the code that a replacement stands in for. Used to limit repeated replacement generation.';

-- All the limits in one place. Mirrored by PROMO_EMAIL_LIMITS in lib/services/promoEmailAbuse.ts (a test asserts they agree).
create or replace function public.promo_email_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'admin_recipients_per_day', 100,
    'global_recipients_per_day', 300,
    'replacements_per_code_per_day', 3,
    'volume_alert_percent', 80,
    'circuit_failure_threshold', 5,
    'circuit_open_minutes', 15
  );
$fn$;
comment on function public.promo_email_limits() is
  'Hardening 0266 items 8 and 9: the named limits of the promo e-mail path. One source in SQL, mirrored in TypeScript, asserted equal by a test.';
revoke all on function public.promo_email_limits() from public, anon;
grant execute on function public.promo_email_limits() to authenticated, service_role;

-- The mail provider circuit breaker (one row). Service role only: written by the server after a send.
create table if not exists public.promo_email_circuit (
  id boolean primary key default true check (id),
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  open_until timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.promo_email_circuit enable row level security;
revoke all on public.promo_email_circuit from anon, authenticated;
comment on table public.promo_email_circuit is
  'Hardening 0266 item 9: circuit breaker state for the mail provider. After the configured number of consecutive provider failures sending pauses for the configured minutes and codes are shown once to the admin instead.';
