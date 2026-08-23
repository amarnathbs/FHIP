-- Investment Intelligence R1 — Migration F: the append-only audit event log.
-- A NEW, Investment-Intelligence-owned table, deliberately NOT a retrofit of
-- the existing dead audit_events/financial_records_audit scaffolding
-- (ADR-008 — neither is referenced by any application code today).
--
-- Structural properties frozen by R0_AUDIT_REQUIREMENTS.md section 3:
-- append-only (select + insert only — no update/delete policy for ANY
-- role, not even the owner; all inserts happen via the service-role client
-- from trusted server-side code, per R1_IMPLEMENTATION_SPEC.md section 3),
-- nullable user_id (system-initiated events), actor_type tracking.
--
-- Governing docs: R0_AUDIT_REQUIREMENTS.md, R0_CANONICAL_DATA_CONTRACT.md, ADR-008.

create table ii_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null, -- nullable: system-initiated events own no specific user
  event_type text not null check (event_type in (
    'upload', 'parse', 'parse_completed', 'reconciliation_opened', 'reconciliation_resolved',
    'user_correction', 'admin_correction', 'publication', 'republishing', 'nav_price_update',
    'calculation', 'rule_change', 'goal_allocation', 'export', 'permission_grant',
    'permission_revoke', 'professional_access', 'archive', 'deletion'
  )),
  subject_type text not null,
  subject_id uuid,
  actor_type text not null check (actor_type in ('user', 'admin', 'system', 'professional')),
  actor_id uuid,
  metadata jsonb, -- safe, non-sensitive before/after context only — never raw document contents (spec section 32)
  created_at timestamptz not null default now() -- immutable
);
create index idx_ii_audit_events_user on ii_audit_events(user_id) where user_id is not null;
create index idx_ii_audit_events_subject on ii_audit_events(subject_type, subject_id);
create index idx_ii_audit_events_event_type on ii_audit_events(event_type, created_at desc);

alter table ii_audit_events enable row level security;
-- Owner-read-only. Deliberately NO insert/update/delete policy for the
-- authenticated role at all (R1_IMPLEMENTATION_SPEC.md section 3) — every
-- insert happens through the service-role client from within
-- lib/services/investment-intelligence/audit.ts, never a direct user-facing write.
create policy "read own ii_audit_events" on ii_audit_events
  for select using (auth.uid() = user_id);
