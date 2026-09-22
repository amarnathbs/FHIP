-- Module 11 AI Remediation Programme (2026-09-22) — R4: Admin AI Operations
-- capabilities (brief sections 34-39; Admin Architecture Standard §2, §4, §5).
--
-- MIGRATION NUMBER: 0177 — next after this programme's 0175/0176.
--
-- WHY TWO NEW COLUMNS INSTEAD OF requireAdmin(). The 19 existing
-- /api/admin/ai/* routes are gated on bare requireAdmin() (Super Admin).
-- The Admin Standard §2 prohibits gating a NEW admin surface on a coarse
-- "has some admin role" check, so the AI Operations screen introduces two
-- separately named, separately tested capabilities, following the PC6/PC7
-- precedent (migrations 0155/0157) exactly:
--
--   can_view_ai_operations   -> may load the read-only AI Operations screen
--                               and its aggregate read API (§5: read-only
--                               family — no config authority implied).
--   can_manage_ai_operations -> may see and use the guarded controls
--                               (kill switches, limits, model/prompt/provider
--                               state, manual scheduler runs). The write
--                               routes those controls call remain the
--                               pre-existing requireAdmin() routes, so a
--                               manager must ALSO be a Super Admin for a
--                               change to succeed (recorded in the R4 report
--                               as a §1.2/§14 boundary: existing routes are
--                               not rebuilt under this authority).
--
-- Neither is implied by presence in admin_users, by the other, or by any
-- Resources role (§2, §3). Both default false: applying this migration
-- grants nothing to anyone.
--
-- DATABASE LAYER (§4 layer 1). Every table the screen reads is a Module 11
-- governance table with RLS enabled and ZERO policies — a user session can
-- read none of them directly regardless of any admin column; only the
-- service-role client (behind the API guard) can. The predicates below exist
-- for parity with PC6/PC7 and for any future policy, and are the single
-- SQL definition of each capability.

alter table admin_users add column if not exists can_view_ai_operations boolean not null default false;
alter table admin_users add column if not exists can_manage_ai_operations boolean not null default false;

comment on column admin_users.can_view_ai_operations is
  'Module 11 R4: separately named capability (Admin Standard §2) authorising the read-only Admin AI Operations screen and its aggregate read API. Not implied by admin_users membership.';
comment on column admin_users.can_manage_ai_operations is
  'Module 11 R4: separately named capability (Admin Standard §2, §5) authorising the guarded AI controls on the Admin AI Operations screen. Not implied by admin_users membership or by can_view_ai_operations.';

create or replace function is_ai_operations_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where admin_users.user_id = auth.uid() and can_view_ai_operations = true);
$$;
create or replace function is_ai_operations_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where admin_users.user_id = auth.uid() and can_manage_ai_operations = true);
$$;
comment on function is_ai_operations_viewer() is 'Module 11 R4. True only for an admin_users row with can_view_ai_operations=true.';
comment on function is_ai_operations_manager() is 'Module 11 R4. True only for an admin_users row with can_manage_ai_operations=true.';
