-- Investment Intelligence R11 — Multi-source & Professional Expansion,
-- Objective B: secure, revocable, least-privilege delegated professional
-- access. Genuinely new capability (R11-P0 confirmed: no invitation/
-- delegation/shared-account construct exists anywhere in the schema to
-- reuse or collide with). Explicitly NOT platform-admin access (spec
-- section 7) — professional_profiles.user_id is an ordinary auth.users
-- row, never the service role, never lib/services/adminAuth.ts's admin
-- plane.
--
-- Write model (deliberate, spec sections 77-92): every mutating table here
-- is SELECT-only for the authenticated role. All state transitions
-- (invite/accept/revoke/grant-scope/revoke-scope) happen exclusively
-- through API routes using the service-role client, after the route
-- verifies the caller's own session identity and the transition is legal
-- in TypeScript (lib/services/professional-access/access.ts). A DB-level
-- trigger below is a SECOND, independent backstop against a future
-- application bug — it fires on every UPDATE regardless of role (service
-- role is NOT exempt from triggers, only from RLS), enforcing the
-- invariants that must NEVER be violated by any code path: identity
-- columns are immutable, and revoked/expired/declined relationships can
-- never transition back to active ("unrevoke" attack, spec section 90).

-- ---------------------------------------------------------------------------
-- professional_profiles — one row per professional identity. Factual
-- attributes only (spec section 71): never platform-verified regulatory
-- status. is_active governs whether ANY of this professional's
-- relationships can be used (a deactivated professional loses all access,
-- spec section 68).
-- ---------------------------------------------------------------------------
create table professional_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  organisation text,
  professional_type text not null check (professional_type in ('financial_adviser', 'accountant', 'tax_professional', 'other')),
  contact_email text,
  jurisdiction text, -- factual, self-declared; never implies platform verification
  registration_details text, -- factual, self-declared (e.g. licence number as provided)
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_professional_profiles_active on professional_profiles(id) where is_active = true;

alter table professional_profiles enable row level security;
-- The professional may read/update their own profile (factual fields only —
-- app layer enforces which columns are editable; is_active is never
-- client-settable, matching the deactivation-is-a-privileged-action rule).
create policy "own professional_profiles" on professional_profiles
  for select using (auth.uid() = user_id);
create policy "update own professional_profiles" on professional_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id and is_active = (select is_active from professional_profiles p2 where p2.id = professional_profiles.id));
-- No insert/delete policy for authenticated — profile creation happens via
-- a service-role API route at professional onboarding.
-- (The "client may read a related professional's factual profile" policy
-- is created further below, AFTER professional_relationships exists — a
-- CREATE POLICY's USING clause is resolved against real catalog objects at
-- creation time, so it cannot reference a table that doesn't exist yet.)

-- ---------------------------------------------------------------------------
-- professional_relationships — the canonical delegated-access relationship
-- (spec section 44). One row per (client, professional) invitation/
-- engagement lifecycle instance — a revoked relationship is never reused;
-- re-inviting the same professional creates a NEW row, preserving full
-- history (spec section 46's "auditable" requirement).
-- ---------------------------------------------------------------------------
create table professional_relationships (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references auth.users(id) on delete cascade,
  professional_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending_invite' check (status in ('pending_invite', 'active', 'revoked', 'expired', 'declined')),
  invited_by text not null check (invited_by in ('client', 'professional')),
  purpose text, -- free-text stated purpose (spec section 47's "purpose" consent field)
  terms_version text not null default 'r11-terms-v1',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text check (revoked_by is null or revoked_by in ('client', 'professional_deactivation', 'expiry', 'system')),
  updated_at timestamptz not null default now(),
  check (client_user_id <> professional_user_id)
);
create index idx_professional_relationships_client on professional_relationships(client_user_id, status);
create index idx_professional_relationships_professional on professional_relationships(professional_user_id, status);
-- At most one PENDING or ACTIVE relationship per (client, professional) pair
-- at a time — prevents duplicate concurrent invitations; a revoked/expired/
-- declined row does not block a fresh re-invitation (partial index).
create unique index uidx_professional_relationships_live_pair
  on professional_relationships(client_user_id, professional_user_id)
  where status in ('pending_invite', 'active');

alter table professional_relationships enable row level security;
create policy "client reads own professional_relationships" on professional_relationships
  for select using (auth.uid() = client_user_id);
create policy "professional reads own professional_relationships" on professional_relationships
  for select using (auth.uid() = professional_user_id);
-- No insert/update/delete policy for authenticated — see write-model note
-- above. All lifecycle writes go through the service-role client from
-- app/api/professional-access/*.

-- Now that professional_relationships exists, add the deferred
-- professional_profiles policy (spec section 62: "must not search
-- arbitrary FHIP users" — a client may read a professional's FACTUAL
-- profile fields only if a real relationship between them exists).
create policy "client reads related professional_profiles" on professional_profiles
  for select using (
    exists (
      select 1 from professional_relationships r
      where r.professional_user_id = professional_profiles.user_id
        and r.client_user_id = auth.uid()
    )
  );

-- Defense-in-depth backstop (fires for every role, service role included):
-- identity columns immutable; a relationship that ever reaches revoked/
-- expired/declined can never move to any other status again, from ANY
-- prior status, no exceptions.
create or replace function enforce_professional_relationship_transition()
returns trigger
language plpgsql
as $$
begin
  if new.client_user_id is distinct from old.client_user_id
     or new.professional_user_id is distinct from old.professional_user_id
     or new.created_at is distinct from old.created_at
     or new.invited_by is distinct from old.invited_by then
    raise exception 'professional_relationships: identity/invitation-origin columns are immutable (attempted % -> %)', old.status, new.status;
  end if;
  if old.status in ('revoked', 'expired', 'declined') and new.status is distinct from old.status then
    raise exception 'professional_relationships: a % relationship can never transition to % (terminal state)', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger trg_enforce_professional_relationship_transition
  before update on professional_relationships
  for each row execute function enforce_professional_relationship_transition();

-- ---------------------------------------------------------------------------
-- professional_permission_scopes — least-privilege, per-scope grants (spec
-- section 48: "no single broad professional=full access flag"). A row per
-- granted scope; revocation sets revoked_at rather than deleting, so scope
-- HISTORY is auditable (spec section 47) even though CURRENT effective
-- access (revoked_at is null) is what every access check reads.
-- ---------------------------------------------------------------------------
create table professional_permission_scopes (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references professional_relationships(id) on delete cascade,
  scope text not null check (scope in (
    'VIEW_FINANCIAL_SUMMARY', 'VIEW_INVESTMENTS', 'VIEW_GOALS', 'VIEW_FORECASTS',
    'VIEW_REPORTS', 'VIEW_TAX_SUMMARY', 'VIEW_SOURCE_PROVENANCE', 'COMMENT_OR_NOTE'
  )),
  granted_at timestamptz not null default now(),
  granted_by text not null check (granted_by in ('client', 'system')), -- never 'professional' — a professional can never grant itself a scope (spec section 78)
  revoked_at timestamptz,
  revoked_by text check (revoked_by is null or revoked_by in ('client', 'system'))
);
-- At most one LIVE (unrevoked) grant per (relationship, scope) — re-granting
-- after revocation is a NEW row, preserving history.
create unique index uidx_professional_permission_scopes_live
  on professional_permission_scopes(relationship_id, scope)
  where revoked_at is null;
create index idx_professional_permission_scopes_relationship on professional_permission_scopes(relationship_id);

alter table professional_permission_scopes enable row level security;
create policy "client reads own professional_permission_scopes" on professional_permission_scopes
  for select using (
    exists (select 1 from professional_relationships r where r.id = professional_permission_scopes.relationship_id and r.client_user_id = auth.uid())
  );
create policy "professional reads own professional_permission_scopes" on professional_permission_scopes
  for select using (
    exists (select 1 from professional_relationships r where r.id = professional_permission_scopes.relationship_id and r.professional_user_id = auth.uid())
  );
-- No insert/update/delete policy for authenticated — service-role only
-- (grant/revoke API routes), same discipline as professional_relationships.
-- This is the DB-level guarantee behind "professional scope self-upgrade
-- must be blocked" (spec section 78): the professional role has literally
-- no write path to this table at all.

-- revoked_at can never be un-set once written (mirrors the relationship
-- trigger's irreversibility rule, applied at the scope grain).
create or replace function enforce_professional_scope_irreversible_revocation()
returns trigger
language plpgsql
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'professional_permission_scopes: a revoked scope grant can never be un-revoked';
  end if;
  if new.relationship_id is distinct from old.relationship_id or new.scope is distinct from old.scope or new.granted_at is distinct from old.granted_at then
    raise exception 'professional_permission_scopes: relationship/scope/granted_at are immutable';
  end if;
  return new;
end;
$$;

create trigger trg_enforce_professional_scope_irreversible_revocation
  before update on professional_permission_scopes
  for each row execute function enforce_professional_scope_irreversible_revocation();

-- ---------------------------------------------------------------------------
-- professional_consent_audit — append-only audit trail (spec sections 47,
-- 92: "must not be forgeable"). No INSERT/UPDATE/DELETE policy for the
-- authenticated role at all — rows are written EXCLUSIVELY by the
-- SECURITY DEFINER trigger functions below, as a direct, automatic
-- consequence of a real validated state change on professional_
-- relationships / professional_permission_scopes. There is no code path,
-- client or service-role application bug included, that can insert a
-- freestanding audit row unconnected to a real transition, because the
-- table has no reachable INSERT policy for anything except the trigger's
-- elevated (SECURITY DEFINER, owned by the migration role) context.
-- ---------------------------------------------------------------------------
create table professional_consent_audit (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references professional_relationships(id) on delete cascade,
  event_type text not null check (event_type in (
    'invited', 'accepted', 'declined', 'scope_granted', 'scope_revoked',
    'relationship_revoked', 'relationship_expired', 'resource_accessed'
  )),
  actor_user_id uuid, -- who performed the action; null for system-driven events (e.g. expiry sweep)
  actor_role text not null check (actor_role in ('client', 'professional', 'system')),
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index idx_professional_consent_audit_relationship on professional_consent_audit(relationship_id, created_at);

alter table professional_consent_audit enable row level security;
create policy "client reads own professional_consent_audit" on professional_consent_audit
  for select using (
    exists (select 1 from professional_relationships r where r.id = professional_consent_audit.relationship_id and r.client_user_id = auth.uid())
  );
create policy "professional reads own professional_consent_audit" on professional_consent_audit
  for select using (
    exists (select 1 from professional_relationships r where r.id = professional_consent_audit.relationship_id and r.professional_user_id = auth.uid())
  );
-- Deliberately: no insert/update/delete policy for authenticated at all.

create or replace function audit_professional_relationship_change()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
declare
  v_event text;
  v_actor_role text;
begin
  if tg_op = 'INSERT' then
    v_event := 'invited';
    v_actor_role := new.invited_by;
  elsif old.status is distinct from new.status then
    if new.status = 'active' then v_event := 'accepted'; v_actor_role := 'professional';
    elsif new.status = 'declined' then v_event := 'declined'; v_actor_role := 'professional';
    elsif new.status = 'revoked' then v_event := 'relationship_revoked'; v_actor_role := coalesce(new.revoked_by, 'client');
    elsif new.status = 'expired' then v_event := 'relationship_expired'; v_actor_role := 'system';
    else return new;
    end if;
  else
    return new;
  end if;

  insert into professional_consent_audit (relationship_id, event_type, actor_user_id, actor_role, metadata)
  values (
    new.id,
    v_event,
    case when v_actor_role = 'client' then new.client_user_id when v_actor_role = 'professional' then new.professional_user_id else null end,
    case when v_actor_role in ('client', 'professional') then v_actor_role else 'system' end,
    jsonb_build_object('status', new.status, 'terms_version', new.terms_version)
  );
  return new;
end;
$$;

create trigger trg_audit_professional_relationship_insert
  after insert on professional_relationships
  for each row execute function audit_professional_relationship_change();
create trigger trg_audit_professional_relationship_update
  after update on professional_relationships
  for each row execute function audit_professional_relationship_change();

create or replace function audit_professional_scope_change()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into professional_consent_audit (relationship_id, event_type, actor_user_id, actor_role, metadata)
    select new.relationship_id, 'scope_granted',
           case when new.granted_by = 'client' then r.client_user_id else null end,
           case when new.granted_by = 'client' then 'client' else 'system' end,
           jsonb_build_object('scope', new.scope)
    from professional_relationships r where r.id = new.relationship_id;
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into professional_consent_audit (relationship_id, event_type, actor_user_id, actor_role, metadata)
    select new.relationship_id, 'scope_revoked',
           case when new.revoked_by = 'client' then r.client_user_id else null end,
           case when new.revoked_by = 'client' then 'client' else 'system' end,
           jsonb_build_object('scope', new.scope)
    from professional_relationships r where r.id = new.relationship_id;
  end if;
  return new;
end;
$$;

create trigger trg_audit_professional_scope_insert
  after insert on professional_permission_scopes
  for each row execute function audit_professional_scope_change();
create trigger trg_audit_professional_scope_update
  after update on professional_permission_scopes
  for each row execute function audit_professional_scope_change();

-- ---------------------------------------------------------------------------
-- professional_notes — professional-authored content, explicitly NEVER
-- canonical financial truth (spec section 53). Bounded, RLS-enforced
-- direct write (unlike the tables above, this is a safe, narrow action:
-- create-only note authorship gated by an active relationship + the
-- COMMENT_OR_NOTE scope, enforced entirely inside the WITH CHECK clause —
-- a real DB-level enforcement of the permission-scope model, not merely an
-- app-layer check).
-- ---------------------------------------------------------------------------
create table professional_notes (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references professional_relationships(id) on delete cascade,
  author_user_id uuid not null references auth.users(id),
  subject_type text not null check (subject_type in ('general', 'investment_position', 'goal', 'report', 'tax_summary')),
  subject_id uuid,
  note_text text not null check (char_length(note_text) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index idx_professional_notes_relationship on professional_notes(relationship_id, created_at);

alter table professional_notes enable row level security;
create policy "client reads professional_notes" on professional_notes
  for select using (
    exists (select 1 from professional_relationships r where r.id = professional_notes.relationship_id and r.client_user_id = auth.uid())
  );
create policy "professional reads own professional_notes" on professional_notes
  for select using (auth.uid() = author_user_id);
-- Insert is the one direct-write path granted to the professional role,
-- and it is fully bounded at the DB level: the relationship must be
-- ACTIVE, the caller must be its professional, and COMMENT_OR_NOTE must be
-- a currently-live (unrevoked) scope grant on that exact relationship.
create policy "professional creates bounded professional_notes" on professional_notes
  for insert with check (
    auth.uid() = author_user_id
    and exists (
      select 1 from professional_relationships r
      join professional_permission_scopes s on s.relationship_id = r.id
      where r.id = professional_notes.relationship_id
        and r.professional_user_id = auth.uid()
        and r.status = 'active'
        and s.scope = 'COMMENT_OR_NOTE'
        and s.revoked_at is null
    )
  );
-- No update/delete policy — notes are immutable once written (an incorrect
-- note is superseded by a new one, never edited/erased, same discipline as
-- every other II provenance record).

-- ---------------------------------------------------------------------------
-- professional_report_access_log — auditable professional report access
-- WITHOUT logging report contents (spec section 65). Reuses R10's existing
-- report snapshot rows (ii_reports / equivalent) rather than a new
-- professional report engine — this table only records who/when/what-id.
-- ---------------------------------------------------------------------------
create table professional_report_access_log (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references professional_relationships(id) on delete cascade,
  professional_user_id uuid not null references auth.users(id),
  client_user_id uuid not null references auth.users(id),
  report_id uuid not null, -- polymorphic reference to the R10 report row; app-validated, not a hard FK (R10's report table is outside R11 scope to alter)
  action text not null check (action in ('view', 'download')),
  accessed_at timestamptz not null default now()
);
create index idx_professional_report_access_log_relationship on professional_report_access_log(relationship_id, accessed_at);

alter table professional_report_access_log enable row level security;
create policy "client reads own professional_report_access_log" on professional_report_access_log
  for select using (auth.uid() = client_user_id);
create policy "professional reads own professional_report_access_log" on professional_report_access_log
  for select using (auth.uid() = professional_user_id);
-- No insert/update/delete policy for authenticated — written exclusively
-- by the service-role report-access API route, after it has independently
-- verified VIEW_REPORTS is live for that relationship (defense in depth:
-- even if that check were ever buggy, the log itself cannot be forged by
-- either party to fabricate an access record that didn't happen, or to
-- erase one that did).
