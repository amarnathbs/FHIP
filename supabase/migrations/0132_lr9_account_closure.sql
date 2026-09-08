-- LR-9 WP-06/07/08 — Account closure request model + a narrow, separately
-- named Admin capability to review/execute it.
--
-- ARCHITECTURE DECISION (per docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md
-- §2): admin_users is today a single flat "has any admin access at all" flag
-- (migration 0011) -- the Standard explicitly prohibits "possession of any
-- Admin-related role (a coarse 'has some Admin role' check)" as the SOLE
-- basis for a NEW capability. Rather than build a generic multi-role
-- capability table (a much larger, unrelated undertaking this phase has no
-- mandate for -- Standard §14 "no hidden scope expansion"), this adds one
-- narrowly-named, separately-testable boolean specifically for this
-- capability, matching the Standard's minimum bar (separately named,
-- separately documented, separately tested) without inventing an RBAC
-- engine LR-9 doesn't need.
alter table admin_users add column if not exists can_manage_account_deletions boolean not null default false;
comment on column admin_users.can_manage_account_deletions is
  'LR-9: a separately-named, separately-tested capability (Admin Architecture Standard §2) authorising review and execution of the account-deletion queue. Deliberately NOT implied by mere presence in admin_users -- see this migration''s own header.';

-- Database-layer enforcement of that capability (Standard §4: every
-- protected capability must be enforced independently at the database
-- layer, not only at the API layer). SECURITY DEFINER so a caller's RLS
-- context on account_deletion_requests can invoke it without needing SELECT
-- on admin_users directly.
create or replace function public.is_account_deletion_admin(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admin_users
    where user_id = check_user_id
    and can_manage_account_deletions = true
  );
$$;
comment on function public.is_account_deletion_admin(uuid) is
  'LR-9: true only for an admin_users row with can_manage_account_deletions=true -- never true merely for being present in admin_users. Used by account_deletion_requests'' own RLS policies and may be reused by the API-layer capability check.';

-- WP-07 — server-owned deletion-request state with user ownership,
-- timestamps, optional reason, and idempotency (a partial unique index, not
-- an application-level check alone, so a client cannot forge a second
-- concurrent active request even via a direct API race).
--
-- user_id is ON DELETE SET NULL, not CASCADE, deliberately: once an admin
-- executes a deletion, auth.admin.deleteUser() cascades the user's ~130
-- other owned tables away in one operation (see LR-9 discovery: migrations
-- 0111/0130 already prove and fix this cascade live), but THIS row must
-- survive that cascade as the completion record WP-10 needs to prove the
-- deletion actually happened -- the same "on delete set null" pattern
-- already used for audit_events.user_id, resource_audit_log.actor_user_id
-- and ii_audit_events.user_id in this schema, for the identical reason. No
-- PII (email, name) is stored on this row at all -- see the API layer,
-- which reads identity live from auth.users only while the row is still
-- linked, and never persists it here -- so a completed row with user_id
-- null is a genuine non-identifying tombstone, not a residual PII leak.
create table account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  reason text,
  requested_at timestamptz not null default now(),
  cancelled_at timestamptz,
  processing_started_at timestamptz,
  processed_at timestamptz,
  -- Which admin executed this -- also set null rather than cascade if that
  -- admin's own account is ever deleted, for the same audit-preservation
  -- reason as user_id above.
  processed_by uuid references auth.users(id) on delete set null,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- WP-07 idempotency: at most one active (pending or processing) request per
-- user. A partial unique index rather than a CHECK/trigger -- the standard,
-- race-safe Postgres pattern for "at most one row matching a condition".
create unique index uq_account_deletion_requests_one_active_per_user
  on account_deletion_requests (user_id)
  where status in ('pending', 'processing');

create index idx_account_deletion_requests_status on account_deletion_requests (status, requested_at);

alter table account_deletion_requests enable row level security;

-- A user may see their own request history.
create policy "user select own deletion requests" on account_deletion_requests
  for select using (auth.uid() = user_id);

-- A user may create their own request, always starting 'pending' -- every
-- other field defaults server-side; a client cannot forge processing/
-- completed/failed/processed_by/processed_at on insert.
create policy "user insert own deletion request" on account_deletion_requests
  for insert with check (auth.uid() = user_id and status = 'pending');

-- A user may cancel their OWN request only while it is still pending (WP-07:
-- "Server-controlled state transitions must not be client-forgeable") --
-- once an admin has started processing it, only the admin/service-role path
-- may change its state further.
create policy "user cancel own pending deletion request" on account_deletion_requests
  for update using (auth.uid() = user_id and status = 'pending')
  with check (auth.uid() = user_id and status = 'cancelled');

-- Admin read/write, gated by the narrow capability above -- defense in
-- depth alongside the API-layer requireAccountDeletionAdmin() check (the
-- application still uses the service-role client for the actual execution
-- writes, matching this codebase's own established admin-route pattern
-- (lib/services/adminAuth.ts's own header comment) -- these policies are
-- what stop a forged/anon-key request from reaching this table at all).
create policy "account deletion admin select all" on account_deletion_requests
  for select using (public.is_account_deletion_admin(auth.uid()));

create policy "account deletion admin update all" on account_deletion_requests
  for update using (public.is_account_deletion_admin(auth.uid()));

-- ROLLBACK: `drop policy` the 5 policies above, `drop table
-- account_deletion_requests`, `drop function public.is_account_deletion_admin(uuid)`,
-- `alter table admin_users drop column can_manage_account_deletions`.
-- Safe to roll back at any point before a real deletion has been executed
-- through this table; once executed, the affected auth.users row is already
-- gone regardless of this table's own state.
