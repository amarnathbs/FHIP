-- ============================================================================
-- 0049 — Migration-lineage reconciliation: Phase 0C section-status + Resources
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
-- Three feature streams were developed in parallel off main (which tops out at
-- 0030) and each allocated its own "next" migration numbers without a shared
-- registry. Versions 0031-0040 were therefore claimed twice:
--
--   0031-0032  Phase 0C (core section-status)  vs  Investment Intelligence
--   0033-0040  Resources module                vs  Investment Intelligence
--
-- Both sets were applied to DEV by hand, so DEV is correct, but no single
-- branch ever contained both and a fresh database could not be rebuilt
-- deterministically: two different files claimed the same version prefix.
--
-- CANONICALIZATION DECISION (see docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md)
--
-- Investment Intelligence retains 0031-0044 as the canonical active legacy
-- lineage, because it is the longer contiguous chain, it is the lineage the
-- certified FDH-1 migrations 0045-0048 were already built on top of, and
-- R2-R6 all depend on its numbering. The Phase 0C and Resources files are
-- preserved verbatim as historical artefacts under supabase/migration_archive/
-- and are NEVER executed from there. Their canonical effects are re-emitted,
-- forward-only, by this migration.
--
-- SAFETY PROPERTIES
--
--  * Idempotent. Every statement is guarded (IF NOT EXISTS / DROP ... IF EXISTS
--    before CREATE / CREATE OR REPLACE). Against DEV, where all 21 tables and
--    every policy, index and constraint already exist, this migration is a
--    no-op and mutates no row.
--  * Additive only. It drops no table, no column, and no data. The only DROPs
--    are DROP ... IF EXISTS immediately preceding the re-creation of the same
--    named policy or constraint with identical definition.
--  * Order-independent. Audited at reconciliation time: no active migration
--    (0001-0048) references any resource_* object or user_financial_section_status,
--    and no archived migration references any ii_* or fdh_* object. Running
--    these effects at 0049 instead of 0031-0040 is therefore semantically
--    equivalent, and this equivalence was proven by replaying both orderings
--    into a fresh PostgreSQL 18 database and diffing the resulting schemas.
--  * The three backfill INSERTs re-emitted from Phase 0C 0031 all carry
--    ON CONFLICT (user_id, section) DO NOTHING, so they cannot overwrite a
--    user's existing confirmation. The Resources seed INSERTs are likewise
--    conflict-guarded and cannot overwrite existing published content.
--
-- The blocks below are the archived migrations in their original order, with
-- only mechanical idempotency guards added. No semantic content was changed.
-- ============================================================================


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0031_financial_section_status.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0031_financial_section_status.sql)
-- ============================================================================
-- Phase 0C: canonical per-user, per-section review status.
--
-- Phase 0B found that healthScore.ts and resilience.ts were inferring
-- "confirmed zero debt" / "confirmed no insurance" purely from an absence
-- of rows plus a loose hasEngaged() heuristic — the user never actually
-- confirmed either. This table lets a household explicitly confirm
-- "I have none of this" (reviewed_zero) or "this doesn't apply to me"
-- (not_applicable), distinct from simply not having gotten to a section
-- yet. It is intentionally sparse: 'reviewed_with_data' and 'not_started'
-- are never persisted here — they're derived at read time from whether
-- real rows exist for that category (see lib/engines/financialSectionStatus.ts),
-- so this table only ever needs to hold the two states that can't be
-- inferred from row presence alone.
--
-- Additive only. Does not touch, rename, or drop any existing column or
-- table. user_profiles.not_applicable_{investments,retirement,insurance}
-- (migration 0029) are left in place for backwards compatibility and are
-- read once, below, only to seed this table for users who already set them
-- — they are not otherwise written to going forward; the section-status
-- table becomes the canonical source engines read from.
create table if not exists user_financial_section_status (
  user_id uuid not null references auth.users(id) on delete cascade,
  section text not null check (section in (
    'household', 'income', 'expenses', 'assets', 'liabilities',
    'investments', 'retirement', 'insurance'
  )),
  -- Only these two states are ever written here — see comment above.
  status text not null check (status in ('reviewed_zero', 'not_applicable')),
  updated_at timestamptz not null default now(),
  primary key (user_id, section)
);

alter table user_financial_section_status enable row level security;

drop policy if exists "own financial section status" on user_financial_section_status;


create policy "own financial section status" on user_financial_section_status
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Backfill: seed 'not_applicable' rows from the existing opt-out booleans so
-- no user who already confirmed "I don't have investments/retirement/
-- insurance" loses that confirmation when the engines switch over to
-- reading this table. Deliberately does NOT infer 'reviewed_zero' for
-- liabilities/insurance from an absence of rows anywhere in this backfill —
-- per the Phase 0C decision, ambiguous historical absence must stay
-- unconfirmed (derived as 'not_started'/'in_progress' at read time) rather
-- than being auto-confirmed as zero.
insert into user_financial_section_status (user_id, section, status)
select user_id, 'investments', 'not_applicable' from user_profiles where not_applicable_investments = true
on conflict (user_id, section) do nothing;

insert into user_financial_section_status (user_id, section, status)
select user_id, 'retirement', 'not_applicable' from user_profiles where not_applicable_retirement = true
on conflict (user_id, section) do nothing;

insert into user_financial_section_status (user_id, section, status)
select user_id, 'insurance', 'not_applicable' from user_profiles where not_applicable_insurance = true
on conflict (user_id, section) do nothing;

-- Rollback notes (manual — this repo has no down-migration runner):
--   drop policy "own financial section status" on user_financial_section_status;
--   drop table user_financial_section_status;
-- Safe to run at any time: no other table has a foreign key into this one,
-- and no existing column was altered by this migration, so rolling it back
-- returns the schema exactly to its pre-0031 state with no data loss
-- outside this table itself.


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0032_section_status_reviewed_with_data.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0032_section_status_reviewed_with_data.sql)
-- ============================================================================
-- Phase 0C.1: widen user_financial_section_status.status to also accept
-- 'reviewed_with_data'.
--
-- Phase 0C's completion report surfaced a semantic gap: effectiveSectionStatus()
-- was treating "at least one row exists" as equivalent to "the user has
-- finished reviewing this section" for positive-data sections (Income,
-- Expenses, Assets, Investments, Retirement, and Liabilities/Insurance once
-- rows exist). One salary row doesn't prove Income is fully reviewed any
-- more than one rent row proves Expenses is. Positive-data sections now
-- need their own explicit "I've added everything relevant to me"
-- confirmation, persisted the same way 'reviewed_zero'/'not_applicable'
-- already are.
--
-- Additive-only: widens an existing CHECK constraint, does not touch any
-- other column, table, row, or the RLS policy from migration 0031. No
-- backfill is performed here — see the Phase 0C.1 completion report for why
-- existing users with unconfirmed rows are deliberately left at
-- 'in_progress' (derived, not persisted) rather than being auto-marked
-- 'reviewed_with_data'.
alter table user_financial_section_status
  drop constraint if exists user_financial_section_status_status_check;

alter table user_financial_section_status drop constraint if exists user_financial_section_status_status_check;


alter table user_financial_section_status add constraint user_financial_section_status_status_check
  check (status in ('reviewed_zero', 'not_applicable', 'reviewed_with_data'));

-- Rollback notes (manual — this repo has no down-migration runner):
--   alter table user_financial_section_status drop constraint if exists user_financial_section_status_status_check;
--   alter table user_financial_section_status add constraint user_financial_section_status_status_check
--     check (status in ('reviewed_zero', 'not_applicable'));
-- Only safe to roll back if no row has status = 'reviewed_with_data' yet —
-- otherwise the old, narrower constraint would reject those existing rows.
-- Check first: select count(*) from user_financial_section_status where status = 'reviewed_with_data';


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0033_resources_foundation.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0033_resources_foundation.sql)
-- ============================================================================
-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.1 Database Foundation
-- =============================================================================
-- Foundation-only migration: schema, RBAC, RLS, workflow enforcement, audit.
-- No admin UI, no public UI, no editor UI — those are R1.2+.
--
-- Pre-implementation audit findings that shaped the decisions below (full
-- detail in docs/resources/R1.1-database-foundation.md):
--   - FHIP has no native-Postgres-enum convention anywhere in 32 prior
--     migrations; every controlled value uses `text` + `check (x in (...))`.
--     Followed here for consistency, and because it is easier to extend
--     later (ALTER TABLE ... DROP/ADD CONSTRAINT) than a native enum type.
--   - FHIP's only existing admin/RBAC concept is `admin_users` (0011): a
--     single binary flag, RLS-self-read-only, writes via service-role only.
--     This is Scenario B from the R1.1 brief (no suitable granular RBAC
--     exists) — `admin_users` is reused AS-IS for the Resources "Super
--     Admin" tier (full FHIP admin rights, no parallel super-admin concept
--     introduced), and a new `resource_user_roles` table is added for the
--     six Resources-specific roles (a sixth, 'analyst', was added during the
--     R1.1 closure pass to reconcile against the approved R0-B spec).
--   - No `private` (non-API-exposed) schema exists yet — created here.
--   - No DB-level `updated_at` trigger convention exists; every existing
--     service sets `updated_at` explicitly in the application layer
--     (lib/services/registry.ts:46). Followed here rather than introducing
--     a new trigger-based pattern inconsistent with the rest of the schema.
--   - `financial_records_audit` (0003) exists but is shaped for customer
--     data-change audit (keyed by the data owner's user_id, no before/after
--     snapshot). Not reused — a dedicated `resource_audit_log` is created,
--     shaped for staff-actor CMS actions with before/after JSONB state.

-- -----------------------------------------------------------------------------
-- 0. Private (non-API-exposed) schema for security helper functions
-- -----------------------------------------------------------------------------
create schema if not exists private;
-- PostgREST only exposes schemas listed in its config (public by default on
-- Supabase). Nothing here is reachable via the Data API — functions in this
-- schema are only callable from other SQL (RLS policies, other functions).
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

-- -----------------------------------------------------------------------------
-- 1. RBAC — resource_user_roles (Scenario B: new Resources-specific roles)
-- -----------------------------------------------------------------------------
-- admin_users (existing, unchanged) = Super Admin = full FHIP rights,
-- including full Resources rights. Not duplicated here.
create table if not exists resource_user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst')),
  is_active boolean not null default true,
  assigned_by uuid references auth.users(id),
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A user may hold multiple Resources roles, but never two *active* rows for
-- the same (user_id, role) pair (spec §8).
create unique index if not exists uq_resource_user_roles_active on resource_user_roles(user_id, role) where is_active;
create index if not exists idx_resource_user_roles_user on resource_user_roles(user_id) where is_active;
create index if not exists idx_resource_user_roles_role on resource_user_roles(role) where is_active;

alter table resource_user_roles enable row level security;
-- Self-read only, mirroring admin_users' existing "self read admin flag"
-- policy exactly. Role assignment/removal happens via the service-role
-- client only (no INSERT/UPDATE/DELETE policy is granted to any
-- client-facing role) — R1.1 has no admin UI to assign roles through yet;
-- when R1.2 builds one, it will call through the service-role client from a
-- server action, the same pattern admin_users already uses. This is the
-- strictest possible stance against self-escalation (spec §51) and requires
-- no new trust decision beyond what admin_users already established.
drop policy if exists "self read own resource roles" on resource_user_roles;

create policy "self read own resource roles" on resource_user_roles for select using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 2. Security helper functions (private schema, SECURITY DEFINER where
--    needed to read resource_user_roles/admin_users across a caller's own
--    row without granting broad table SELECT to every authenticated user)
-- -----------------------------------------------------------------------------
-- All are STABLE (safe to reuse within one statement), have an
-- explicit empty search_path (prevents search-path-hijack privilege
-- escalation — the classic SECURITY DEFINER footgun), fully qualify every
-- object reference, and are granted EXECUTE only to `authenticated` (never
-- `anon`, never `public`). None accept or build arbitrary SQL.

create or replace function private.is_fhip_super_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au where au.user_id = p_user_id
  );
$$;
revoke all on function private.is_fhip_super_admin(uuid) from public;
grant execute on function private.is_fhip_super_admin(uuid) to authenticated, service_role;

create or replace function private.has_resource_role(p_user_id uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.resource_user_roles r
    where r.user_id = p_user_id and r.role = p_role and r.is_active
  ) or private.is_fhip_super_admin(p_user_id);
$$;
revoke all on function private.has_resource_role(uuid, text) from public;
grant execute on function private.has_resource_role(uuid, text) to authenticated, service_role;

-- "Can manage almost all Resources operations" (spec §7, Resource
-- Administrator) — resource_admin or super admin.
create or replace function private.can_manage_resources(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_resource_role(p_user_id, 'resource_admin')
      or private.is_fhip_super_admin(p_user_id);
$$;
revoke all on function private.can_manage_resources(uuid) from public;
-- anon (not just authenticated) needs EXECUTE here: Postgres requires the
-- querying role to hold EXECUTE on every function referenced in ANY RLS
-- policy attached to a table it queries, even a policy that will ultimately
-- evaluate false for that role — the permission check happens at
-- plan/evaluation time for the policy expression itself, independent of
-- the function's own SECURITY DEFINER body. Discovered live during the
-- R1.1 closure pass: an anonymous SELECT against resource_posts failed
-- outright with "permission denied for function is_resource_staff" (see
-- below) because the co-existing "staff read all posts" policy on the same
-- table references it and anon lacked EXECUTE — not a logic bug in the
-- policy itself, a missing grant.
grant execute on function private.can_manage_resources(uuid) to anon, authenticated, service_role;

-- Any *content-workflow* staff role — used to gate read access to
-- non-public workflow rows (drafts, review states) where the exact role
-- doesn't matter, only "is this a CMS content-workflow staff member".
-- Deliberately excludes 'analyst': the closure-pass brief is explicit that
-- Analyst must not gain draft/workflow visibility "merely because the role
-- exists" — Analyst is scoped separately (see private.is_resource_analyst
-- below) to read-only future analytics/reporting surfaces only, none of
-- which exist yet in R1.1.
create or replace function private.is_resource_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.resource_user_roles r
    where r.user_id = p_user_id and r.is_active
      and r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher')
  ) or private.is_fhip_super_admin(p_user_id);
$$;

-- Analyst-specific check, kept separate from is_resource_staff on purpose
-- (see comment above). No table grants a read/write policy to this
-- function in R1.1 — it exists now so a future analytics-table migration
-- has a ready-made, already-tested predicate to attach a policy to,
-- without needing to touch this migration again.
create or replace function private.is_resource_analyst(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_resource_role(p_user_id, 'analyst') or private.can_manage_resources(p_user_id);
$$;
revoke all on function private.is_resource_analyst(uuid) from public;
grant execute on function private.is_resource_analyst(uuid) to authenticated, service_role;
revoke all on function private.is_resource_staff(uuid) from public;
-- anon needs EXECUTE here too, for the same reason documented on
-- can_manage_resources above — this is the specific function whose missing
-- anon grant broke every anonymous read of resource_posts (and everything
-- joined to it) during live R1.1 closure-pass testing.
grant execute on function private.is_resource_staff(uuid) to anon, authenticated, service_role;

create or replace function private.can_publish_resource(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_resource_role(p_user_id, 'publisher')
      or private.can_manage_resources(p_user_id);
$$;
revoke all on function private.can_publish_resource(uuid) from public;
grant execute on function private.can_publish_resource(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Categories (hierarchical)
-- -----------------------------------------------------------------------------
create table if not exists resource_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  parent_id uuid references resource_categories(id) on delete set null,
  sort_order int not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_resource_categories_parent on resource_categories(parent_id);
create index if not exists idx_resource_categories_slug on resource_categories(slug);
create index if not exists idx_resource_categories_active on resource_categories(is_active);

-- -----------------------------------------------------------------------------
-- 4. Tags
-- -----------------------------------------------------------------------------
create table if not exists resource_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_resource_tags_slug on resource_tags(slug);
create index if not exists idx_resource_tags_active on resource_tags(is_active);

-- -----------------------------------------------------------------------------
-- 5. Authors (may or may not be a real FHIP/Supabase Auth user)
-- -----------------------------------------------------------------------------
create table if not exists resource_authors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  slug text not null unique,
  role_title text,
  bio text,
  expertise text[],
  profile_image_id uuid, -- FK added after resource_media exists (§8)
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_resource_authors_user on resource_authors(user_id);
create index if not exists idx_resource_authors_slug on resource_authors(slug);

-- -----------------------------------------------------------------------------
-- 6. Media foundation
-- -----------------------------------------------------------------------------
-- FHIP has no pre-existing generic media-metadata table (checked: report/
-- forecast PDF export writes directly to Supabase Storage with no metadata
-- row). This is a genuinely new concern, not a duplicate of anything
-- existing — created fresh, but deliberately storage-agnostic (references a
-- bucket/path rather than assuming a specific bucket) so it can point at
-- whatever bucket convention R1.2's media upload flow decides to use.
create table if not exists resource_media (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null,
  storage_path text not null,
  public_url text,
  file_name text not null,
  mime_type text not null,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  width int check (width is null or width >= 0),
  height int check (height is null or height >= 0),
  alt_text text,
  caption text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);
create index if not exists idx_resource_media_uploaded_by on resource_media(uploaded_by);

alter table resource_authors drop constraint if exists fk_resource_authors_profile_image;


alter table resource_authors add constraint fk_resource_authors_profile_image
  foreign key (profile_image_id) references resource_media(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 7. CTA library
-- -----------------------------------------------------------------------------
create table if not exists resource_ctas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  label text not null,
  description text,
  destination_type text not null check (destination_type in ('internal_resource', 'fhip_module', 'registration', 'external', 'youtube')),
  destination_url text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_resource_ctas_active on resource_ctas(is_active);

-- -----------------------------------------------------------------------------
-- 8. Core content table — resource_posts
-- -----------------------------------------------------------------------------
create table if not exists resource_posts (
  id uuid primary key default gen_random_uuid(),
  content_id text unique, -- external/R0-A source identifier, nullable (not every post originates from the R0-A import)

  title text not null,
  slug text unique, -- nullable pre-publication (§22: required only "before publication", enforced by the constraint below)
  excerpt text,
  content_blocks jsonb not null default '[]'::jsonb, -- structured blocks only, see §9 constraint; editor UI is a later phase

  content_type text not null check (content_type in ('article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update', 'money_update_template')),
  jurisdiction text not null default 'global' check (jurisdiction in ('global', 'australia', 'india', 'australia_india_cross_border')),
  difficulty text check (difficulty in ('beginner', 'beginner_intermediate', 'intermediate', 'intermediate_advanced', 'advanced')),
  freshness_type text not null default 'evergreen' check (freshness_type in ('evergreen', 'time_sensitive')),
  visibility text not null default 'private' check (visibility in ('public', 'unlisted', 'private')),

  primary_category_id uuid references resource_categories(id) on delete set null,
  featured_image_id uuid references resource_media(id) on delete set null,
  author_id uuid references resource_authors(id) on delete set null,
  reviewer_id uuid references resource_authors(id) on delete set null,
  compliance_reviewer_id uuid references resource_authors(id) on delete set null,

  status text not null default 'idea' check (status in ('idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived')),
  compliance_classification text not null default 'green' check (compliance_classification in ('green', 'amber', 'red')),

  scheduled_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  last_reviewed_at timestamptz,
  next_review_at timestamptz,

  seo_title text,
  seo_description text,
  canonical_url text,
  social_image_id uuid references resource_media(id) on delete set null,
  is_indexable boolean not null default true,

  primary_cta_id uuid references resource_ctas(id) on delete set null,
  secondary_cta_id uuid references resource_ctas(id) on delete set null,

  is_featured boolean not null default false,
  featured_priority int check (featured_priority is null or featured_priority >= 0),

  editorial_approved_by uuid references auth.users(id) on delete set null,
  editorial_approved_at timestamptz,
  compliance_approved_by uuid references auth.users(id) on delete set null,
  compliance_approved_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),

  -- §22 Slug: required before publication.
  constraint chk_resource_posts_slug_before_publish check (status = 'idea' or status = 'draft' or slug is not null),
  -- §22 Scheduled requires scheduled_at.
  constraint chk_resource_posts_scheduled_at check (status <> 'scheduled' or scheduled_at is not null),
  -- §22 Published requires published_at.
  constraint chk_resource_posts_published_at check (status <> 'published' or published_at is not null),
  -- §22/§42 AMBER cannot be scheduled/published without a recorded compliance approval.
  -- Defense-in-depth: the transition RPC (§13) is the only sanctioned write
  -- path and enforces this with a better error message; this constraint is
  -- the hard backstop that holds even if the RPC is ever bypassed.
  constraint chk_resource_posts_amber_requires_compliance check (
    compliance_classification <> 'amber'
    or status not in ('scheduled', 'published')
    or (compliance_approved_by is not null and compliance_approved_at is not null)
  ),
  -- §22/§43 RED can never be scheduled/published under the standard R1.1 workflow.
  constraint chk_resource_posts_red_never_publishes check (
    compliance_classification <> 'red' or status not in ('scheduled', 'published')
  )
);
create index if not exists idx_resource_posts_slug on resource_posts(slug);
create index if not exists idx_resource_posts_content_id on resource_posts(content_id);
create index if not exists idx_resource_posts_status on resource_posts(status);
create index if not exists idx_resource_posts_content_type on resource_posts(content_type);
create index if not exists idx_resource_posts_jurisdiction on resource_posts(jurisdiction);
create index if not exists idx_resource_posts_published_at on resource_posts(published_at);
create index if not exists idx_resource_posts_scheduled_at on resource_posts(scheduled_at);
create index if not exists idx_resource_posts_next_review_at on resource_posts(next_review_at);
create index if not exists idx_resource_posts_primary_category on resource_posts(primary_category_id);
create index if not exists idx_resource_posts_author on resource_posts(author_id);
create index if not exists idx_resource_posts_compliance_classification on resource_posts(compliance_classification);
-- Composite index matching the public-read policy's predicate exactly
-- (status, visibility, published_at) — the query plan for the public
-- listing/detail read will use this instead of a sequential scan.
create index if not exists idx_resource_posts_public_read on resource_posts(status, visibility, published_at);

-- §9 content_blocks structural guard: must be a JSON array (not an object,
-- string, or arbitrary type) at the top level. This is deliberately
-- shallow — it does not attempt to whitelist every future block "type"
-- value (that would make adding a new block type in the editor phase a
-- migration), but it does guarantee the column can never silently become a
-- non-array shape, and it can never contain executable content because
-- JSONB has no executable-code type to begin with (there is no
-- HTML/script-tag data type in JSON — this is a storage-format guarantee,
-- not merely a convention).
alter table resource_posts drop constraint if exists chk_resource_posts_content_blocks_is_array;

alter table resource_posts add constraint chk_resource_posts_content_blocks_is_array
  check (jsonb_typeof(content_blocks) = 'array');

-- -----------------------------------------------------------------------------
-- 9. Post/Category relationship
-- -----------------------------------------------------------------------------
create table if not exists resource_post_categories (
  post_id uuid not null references resource_posts(id) on delete cascade,
  category_id uuid not null references resource_categories(id) on delete cascade,
  is_primary boolean not null default false,
  sort_order int not null default 0 check (sort_order >= 0),
  primary key (post_id, category_id)
);
create index if not exists idx_resource_post_categories_category on resource_post_categories(category_id);

-- -----------------------------------------------------------------------------
-- 10. Post/Tag relationship
-- -----------------------------------------------------------------------------
create table if not exists resource_post_tags (
  post_id uuid not null references resource_posts(id) on delete cascade,
  tag_id uuid not null references resource_tags(id) on delete cascade,
  primary key (post_id, tag_id)
);
create index if not exists idx_resource_post_tags_tag on resource_post_tags(tag_id);

-- -----------------------------------------------------------------------------
-- 11. @GKTC video foundation — metadata only, YouTube remains the host
-- -----------------------------------------------------------------------------
create table if not exists resource_videos (
  id uuid primary key default gen_random_uuid(),
  resource_post_id uuid not null references resource_posts(id) on delete cascade,
  youtube_video_id text not null,
  youtube_url text not null,
  youtube_channel_handle text not null default '@GKTC',
  youtube_channel_url text,
  duration_seconds int check (duration_seconds is null or duration_seconds >= 0),
  thumbnail_url text,
  youtube_published_at timestamptz,
  transcript text,
  chapters jsonb not null default '[]'::jsonb,
  embed_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resource_post_id), -- one video per post (§29: "should normally map to one primary YouTube video")
  constraint chk_resource_videos_youtube_id_not_blank check (btrim(youtube_video_id) <> ''),
  constraint chk_resource_videos_chapters_is_array check (jsonb_typeof(chapters) = 'array')
);
create index if not exists idx_resource_videos_youtube_id on resource_videos(youtube_video_id);

-- -----------------------------------------------------------------------------
-- 12. Sources
-- -----------------------------------------------------------------------------
create table if not exists resource_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  document_title text,
  url text,
  source_type text,
  jurisdiction text check (jurisdiction is null or jurisdiction in ('global', 'australia', 'india', 'australia_india_cross_border')),
  publication_date date,
  checked_at timestamptz,
  is_public boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists resource_post_sources (
  post_id uuid not null references resource_posts(id) on delete cascade,
  source_id uuid not null references resource_sources(id) on delete cascade,
  sort_order int not null default 0 check (sort_order >= 0),
  notes text,
  primary key (post_id, source_id)
);
create index if not exists idx_resource_post_sources_source on resource_post_sources(source_id);

-- -----------------------------------------------------------------------------
-- 13. FAQs (reusable across posts)
-- -----------------------------------------------------------------------------
create table if not exists resource_faqs (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer_blocks jsonb not null default '[]'::jsonb,
  jurisdiction text not null default 'global' check (jurisdiction in ('global', 'australia', 'india', 'australia_india_cross_border')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_resource_faqs_answer_blocks_is_array check (jsonb_typeof(answer_blocks) = 'array')
);

create table if not exists resource_post_faqs (
  post_id uuid not null references resource_posts(id) on delete cascade,
  faq_id uuid not null references resource_faqs(id) on delete cascade,
  sort_order int not null default 0 check (sort_order >= 0),
  primary key (post_id, faq_id)
);
create index if not exists idx_resource_post_faqs_faq on resource_post_faqs(faq_id);

-- -----------------------------------------------------------------------------
-- 14. Related content
-- -----------------------------------------------------------------------------
create table if not exists resource_related_content (
  id uuid primary key default gen_random_uuid(),
  source_post_id uuid not null references resource_posts(id) on delete cascade,
  related_post_id uuid not null references resource_posts(id) on delete cascade,
  relationship_type text not null default 'related' check (relationship_type in ('related', 'prerequisite', 'next_step', 'see_also')),
  sort_order int not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  constraint chk_resource_related_content_no_self_reference check (source_post_id <> related_post_id),
  constraint uq_resource_related_content unique (source_post_id, related_post_id, relationship_type)
);
create index if not exists idx_resource_related_content_related on resource_related_content(related_post_id);

-- -----------------------------------------------------------------------------
-- 15. FHIP contextual resource mapping
-- -----------------------------------------------------------------------------
create table if not exists resource_context_links (
  id uuid primary key default gen_random_uuid(),
  context_key text not null,
  module text not null,
  metric_or_feature text,
  label text not null,
  resource_post_id uuid not null references resource_posts(id) on delete cascade,
  sort_order int not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_resource_context_links_context_key on resource_context_links(context_key);
create index if not exists idx_resource_context_links_module on resource_context_links(module);
create index if not exists idx_resource_context_links_post on resource_context_links(resource_post_id);

-- -----------------------------------------------------------------------------
-- 16. Revision history
-- -----------------------------------------------------------------------------
create table if not exists resource_post_versions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references resource_posts(id) on delete cascade,
  version_number int not null check (version_number > 0),
  snapshot jsonb not null,
  change_summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint uq_resource_post_versions unique (post_id, version_number)
);
create index if not exists idx_resource_post_versions_post on resource_post_versions(post_id, created_at);
-- No automatic snapshot trigger is created (spec §36: "do not introduce a
-- fragile automatic trigger if the required business context such as
-- change_summary cannot be captured properly" — change_summary is an
-- editor-authored field with no sensible default, so it can only be
-- captured meaningfully from the future editor UI, not synthesised by a
-- trigger). The table exists as the foundation; write path is deferred.

-- -----------------------------------------------------------------------------
-- 17. Workflow history
-- -----------------------------------------------------------------------------
create table if not exists resource_workflow_history (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references resource_posts(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  action text not null,
  reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_resource_workflow_history_post on resource_workflow_history(post_id, created_at);

-- -----------------------------------------------------------------------------
-- 18. Audit log
-- -----------------------------------------------------------------------------
create table if not exists resource_audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_resource_audit_log_entity on resource_audit_log(entity_type, entity_id);
create index if not exists idx_resource_audit_log_actor on resource_audit_log(actor_user_id, created_at);

-- -----------------------------------------------------------------------------
-- 19. Resources settings
-- -----------------------------------------------------------------------------
create table if not exists resource_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table resource_categories enable row level security;
alter table resource_tags enable row level security;
alter table resource_authors enable row level security;
alter table resource_media enable row level security;
alter table resource_ctas enable row level security;
alter table resource_posts enable row level security;
alter table resource_post_categories enable row level security;
alter table resource_post_tags enable row level security;
alter table resource_videos enable row level security;
alter table resource_sources enable row level security;
alter table resource_post_sources enable row level security;
alter table resource_faqs enable row level security;
alter table resource_post_faqs enable row level security;
alter table resource_related_content enable row level security;
alter table resource_context_links enable row level security;
alter table resource_post_versions enable row level security;
alter table resource_workflow_history enable row level security;
alter table resource_audit_log enable row level security;
alter table resource_settings enable row level security;

-- --- Public-safe reference tables: active rows readable by everyone,
-- --- full read+write reserved for resource_admin/super_admin. §50.
drop policy if exists "public read active categories" on resource_categories;

create policy "public read active categories" on resource_categories for select using (is_active);
drop policy if exists "staff manage categories" on resource_categories;

create policy "staff manage categories" on resource_categories for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

drop policy if exists "public read active tags" on resource_tags;


create policy "public read active tags" on resource_tags for select using (is_active);
drop policy if exists "staff manage tags" on resource_tags;

create policy "staff manage tags" on resource_tags for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

drop policy if exists "public read active authors" on resource_authors;


create policy "public read active authors" on resource_authors for select using (is_active);
drop policy if exists "staff manage authors" on resource_authors;

create policy "staff manage authors" on resource_authors for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- Media: no blanket public read (files may include not-yet-published social
-- images/author photos for draft content) — public exposure happens through
-- the specific post/author fields that reference a media row, not by
-- reading resource_media directly. Staff (any active Resources role) may
-- read all media metadata; only managers/uploaders may write.
drop policy if exists "staff read media" on resource_media;

create policy "staff read media" on resource_media for select using (private.is_resource_staff(auth.uid()));
drop policy if exists "staff insert media" on resource_media;

create policy "staff insert media" on resource_media for insert with check (private.is_resource_staff(auth.uid()));
drop policy if exists "managers update media" on resource_media;

create policy "managers update media" on resource_media for update
  using (private.can_manage_resources(auth.uid()) or uploaded_by = auth.uid())
  with check (private.can_manage_resources(auth.uid()) or uploaded_by = auth.uid());
drop policy if exists "managers delete media" on resource_media;

create policy "managers delete media" on resource_media for delete using (private.can_manage_resources(auth.uid()));

drop policy if exists "public read active ctas" on resource_ctas;


create policy "public read active ctas" on resource_ctas for select using (is_active);
drop policy if exists "staff manage ctas" on resource_ctas;

create policy "staff manage ctas" on resource_ctas for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- --- resource_posts: the central draft-protection policy (§48/§49).
-- Public/anon AND ordinary authenticated customers get exactly the same
-- read policy — being logged in grants no extra Resources access (§49).
drop policy if exists "public read published posts" on resource_posts;

create policy "public read published posts" on resource_posts for select
  using (
    status in ('published', 'review_due', 'archived')
    and visibility in ('public', 'unlisted')
    and published_at is not null
    and published_at <= now()
  );
-- Staff read: any active Resources role (or super admin) may read every
-- post regardless of status — narrower per-action rules (who may transition
-- what) are enforced by the transition RPC (§13 below), not by this SELECT
-- policy, since editorial/compliance/publisher roles all need visibility
-- into the same draft to do their part of the review.
drop policy if exists "staff read all posts" on resource_posts;

create policy "staff read all posts" on resource_posts for select using (private.is_resource_staff(auth.uid()));
-- Authors may create drafts and edit their own; editors/managers may edit
-- any post's content fields. Status/approval/publish-control columns are
-- deliberately NOT reachable through this policy at all — see the
-- column-level grants below, which is where that boundary is actually
-- enforced (RLS is row-level; Postgres column privileges are what stop a
-- content-only editor from writing to `status` directly).
drop policy if exists "authors insert own drafts" on resource_posts;

create policy "authors insert own drafts" on resource_posts for insert
  with check (private.is_resource_staff(auth.uid()) and created_by = auth.uid());
drop policy if exists "staff update posts" on resource_posts;

create policy "staff update posts" on resource_posts for update
  using (private.is_resource_staff(auth.uid()))
  with check (private.is_resource_staff(auth.uid()));
drop policy if exists "managers delete posts" on resource_posts;

create policy "managers delete posts" on resource_posts for delete using (private.can_manage_resources(auth.uid()));

-- Column-level grants: this is the actual enforcement boundary for §46 (no
-- unrestricted status update) and §44 (author cannot publish). RLS policies
-- above establish *which rows* a role may touch; these GRANT/REVOKE
-- statements establish *which columns*. The `authenticated` role gets
-- UPDATE on ordinary editorial content columns only; the workflow-control
-- columns (status, compliance_classification, the four approval columns,
-- scheduled_at, published_at) are only writable by `service_role` and by
-- SECURITY DEFINER functions (the transition RPC), never directly by
-- `authenticated` — so even a staff member with a valid RLS-matching row
-- cannot `UPDATE resource_posts SET status = 'published' WHERE id = ...`
-- through PostgREST; they must go through public.transition_resource_post_status.
revoke update on resource_posts from authenticated;
grant update (
  title, slug, excerpt, content_blocks, content_type, jurisdiction, difficulty,
  freshness_type, visibility, primary_category_id, featured_image_id, author_id,
  reviewer_id, compliance_reviewer_id, expires_at, last_reviewed_at, next_review_at,
  seo_title, seo_description, canonical_url, social_image_id, is_indexable,
  primary_cta_id, secondary_cta_id, is_featured, featured_priority, updated_by, updated_at
) on resource_posts to authenticated;

drop policy if exists "public read post-category links for readable posts" on resource_post_categories;


create policy "public read post-category links for readable posts" on resource_post_categories for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage post-category links" on resource_post_categories;

create policy "staff manage post-category links" on resource_post_categories for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read post-tag links for readable posts" on resource_post_tags;


create policy "public read post-tag links for readable posts" on resource_post_tags for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage post-tag links" on resource_post_tags;

create policy "staff manage post-tag links" on resource_post_tags for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read videos for readable posts" on resource_videos;


create policy "public read videos for readable posts" on resource_videos for select
  using (exists (select 1 from resource_posts p where p.id = resource_post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage videos" on resource_videos;

create policy "staff manage videos" on resource_videos for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read public sources" on resource_sources;


create policy "public read public sources" on resource_sources for select using (is_public);
drop policy if exists "staff read all sources" on resource_sources;

create policy "staff read all sources" on resource_sources for select using (private.is_resource_staff(auth.uid()));
drop policy if exists "staff manage sources" on resource_sources;

create policy "staff manage sources" on resource_sources for insert with check (private.is_resource_staff(auth.uid()));
drop policy if exists "staff update sources" on resource_sources;

create policy "staff update sources" on resource_sources for update using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));
drop policy if exists "managers delete sources" on resource_sources;

create policy "managers delete sources" on resource_sources for delete using (private.can_manage_resources(auth.uid()));

drop policy if exists "public read post-source links for readable posts" on resource_post_sources;


create policy "public read post-source links for readable posts" on resource_post_sources for select
  using (exists (select 1 from resource_posts p join resource_sources s on s.id = source_id where p.id = post_id and s.is_public and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage post-source links" on resource_post_sources;

create policy "staff manage post-source links" on resource_post_sources for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read active faqs" on resource_faqs;


create policy "public read active faqs" on resource_faqs for select using (is_active);
drop policy if exists "staff manage faqs" on resource_faqs;

create policy "staff manage faqs" on resource_faqs for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read post-faq links for readable posts" on resource_post_faqs;


create policy "public read post-faq links for readable posts" on resource_post_faqs for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage post-faq links" on resource_post_faqs;

create policy "staff manage post-faq links" on resource_post_faqs for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

drop policy if exists "public read related links between readable posts" on resource_related_content;


create policy "public read related links between readable posts" on resource_related_content for select
  using (exists (select 1 from resource_posts p where p.id = source_post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
drop policy if exists "staff manage related content" on resource_related_content;

create policy "staff manage related content" on resource_related_content for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

-- Context links: no public read policy at all in R1.1. §35 explicitly says
-- "do not modify the existing modules to display these links in R1.1" — the
-- FHIP dashboard/score/etc pages do not query this table yet, so there is
-- no legitimate reason for `anon`/ordinary `authenticated` to read it
-- before that integration is built. Staff-only for now; a public policy can
-- be added in the phase that actually wires it into the app.
drop policy if exists "staff read context links" on resource_context_links;

create policy "staff read context links" on resource_context_links for select using (private.is_resource_staff(auth.uid()));
drop policy if exists "staff manage context links" on resource_context_links;

create policy "staff manage context links" on resource_context_links for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- Versions/workflow history/audit log: no public or blanket-authenticated
-- access whatsoever (§50 explicitly lists these as never-expose). Authors
-- may see the workflow history of their own posts (useful feedback: why was
-- my draft sent back); full history/audit access is staff/manager-only.
drop policy if exists "staff read post versions" on resource_post_versions;

create policy "staff read post versions" on resource_post_versions for select using (private.is_resource_staff(auth.uid()));
drop policy if exists "staff insert post versions" on resource_post_versions;

create policy "staff insert post versions" on resource_post_versions for insert with check (private.is_resource_staff(auth.uid()));

drop policy if exists "authors read own post workflow history" on resource_workflow_history;


create policy "authors read own post workflow history" on resource_workflow_history for select
  using (private.is_resource_staff(auth.uid()) or exists (
    select 1 from resource_posts p where p.id = post_id and p.created_by = auth.uid()
  ));
-- No INSERT policy for workflow history at all — every row is written by
-- the SECURITY DEFINER transition RPC (§13), which bypasses RLS by design
-- (that is the entire point of routing status changes through one audited
-- function rather than direct table writes).

drop policy if exists "managers read audit log" on resource_audit_log;


create policy "managers read audit log" on resource_audit_log for select using (private.can_manage_resources(auth.uid()));
-- No INSERT policy — audit rows are written exclusively by the transition
-- RPC and by service-role code paths (e.g. a future role-assignment admin
-- action), never directly by a client.

drop policy if exists "staff read settings" on resource_settings;


create policy "staff read settings" on resource_settings for select using (private.is_resource_staff(auth.uid()));
drop policy if exists "managers write settings" on resource_settings;

create policy "managers write settings" on resource_settings for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- =============================================================================
-- Grants — baseline table privileges. RLS policies above are the row
-- filter; these are the statement-level gate PostgREST checks first. Every
-- table gets SELECT to `anon, authenticated` (RLS narrows what rows are
-- actually visible; tables with no public-facing policy at all — versions,
-- workflow_history, audit_log, resource_user_roles — simply return zero
-- rows to anon/ordinary-authenticated regardless of this grant, since no
-- permissive policy exists for them). Write grants are scoped per-table to
-- match what each table's policies actually allow.
-- =============================================================================
grant select on resource_categories, resource_tags, resource_authors, resource_media, resource_ctas,
  resource_posts, resource_post_categories, resource_post_tags, resource_videos, resource_sources,
  resource_post_sources, resource_faqs, resource_post_faqs, resource_related_content,
  resource_context_links, resource_post_versions, resource_workflow_history, resource_audit_log,
  resource_settings, resource_user_roles
  to anon, authenticated;

grant insert, update, delete on resource_categories, resource_tags, resource_authors, resource_ctas,
  resource_context_links, resource_settings to authenticated;
grant insert, update, delete on resource_media to authenticated;
grant insert on resource_posts to authenticated; -- update is column-scoped above; delete via policy only for managers
grant delete on resource_posts to authenticated; -- policy restricts to managers; grant is the ceiling, not the floor
grant insert, update, delete on resource_post_categories, resource_post_tags, resource_videos,
  resource_post_sources, resource_post_faqs, resource_related_content to authenticated;
grant insert, update, delete on resource_sources, resource_faqs to authenticated;
grant insert on resource_post_versions to authenticated;
-- Deliberately NOT granted to authenticated at all: insert/update/delete on
-- resource_user_roles (role assignment, service-role only, §51), insert on
-- resource_workflow_history / resource_audit_log (RPC/service-role only,
-- §46/§78), and any write on resource_workflow_history/resource_audit_log.

-- =============================================================================
-- 13. Controlled workflow-status transition RPC
-- =============================================================================
-- The single sanctioned path for changing resource_posts.status (and the
-- columns that travel with a status change: the four approval columns,
-- scheduled_at, published_at). Lives in `public` (not `private`) because it
-- must be callable via supabase-js `.rpc()` from a server action — PostgREST
-- only exposes functions in schemas listed in its exposed-schemas config,
-- which for this project is just `public`. It is SECURITY DEFINER so it can
-- write the workflow-control columns (revoked from `authenticated` above)
-- and insert into resource_workflow_history/resource_audit_log (no INSERT
-- policy granted to authenticated on either), while still performing its
-- own explicit permission check as the very first thing it does — the
-- elevated privilege is scoped to *this function's own logic*, not handed
-- to the caller.
create or replace function public.transition_resource_post_status(
  p_post_id uuid,
  p_to_status text,
  p_reason text default null,
  p_notes text default null
)
returns resource_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_post public.resource_posts;
  v_from_status text;
  v_can_editorial boolean;
  v_can_compliance boolean;
  v_can_publish boolean;
  v_can_manage boolean;
  v_actor_role text;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_post from public.resource_posts where id = p_post_id for update;
  if not found then
    raise exception 'Resource post % not found', p_post_id;
  end if;
  v_from_status := v_post.status;

  if p_to_status not in ('idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived') then
    raise exception 'Invalid target status: %', p_to_status;
  end if;

  v_can_editorial := private.has_resource_role(v_actor, 'editor') or private.can_manage_resources(v_actor);
  v_can_compliance := private.has_resource_role(v_actor, 'compliance_reviewer') or private.can_manage_resources(v_actor);
  v_can_publish := private.can_publish_resource(v_actor);
  v_can_manage := private.can_manage_resources(v_actor);

  -- §44 permission matrix, encoded per target status. An Author reaching
  -- this function at all requires editorial_review as the *only* transition
  -- they may cause (submit for review) — enforced by requiring
  -- v_can_editorial-or-author-is-creator for that one case, and requiring a
  -- specific staff role for every other transition. Authors can never
  -- reach 'approved'/'scheduled'/'published' through this function no
  -- matter what they pass, because none of those branches accept
  -- "is the creator" as sufficient.
  if p_to_status = 'draft' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to move this post to draft';
    end if;
  elsif p_to_status = 'editorial_review' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to submit this post for editorial review';
    end if;
  elsif p_to_status = 'compliance_review' then
    if not v_can_editorial then
      raise exception 'Only an Editor, Resource Administrator, or Super Admin may send content to compliance review';
    end if;
  elsif p_to_status = 'approved' then
    if v_post.compliance_classification = 'amber' then
      if not v_can_compliance then
        raise exception 'AMBER content requires Compliance Reviewer approval, not editorial approval alone';
      end if;
    else
      if not v_can_editorial then
        raise exception 'Only an Editor, Resource Administrator, or Super Admin may approve GREEN content';
      end if;
    end if;
  elsif p_to_status = 'scheduled' or p_to_status = 'published' then
    if v_post.compliance_classification = 'red' then
      raise exception 'RED content cannot be scheduled or published under the standard R1.1 workflow';
    end if;
    if v_post.compliance_classification = 'amber' and v_post.compliance_approved_by is null then
      raise exception 'AMBER content must have a recorded Compliance Reviewer approval before it can be scheduled or published';
    end if;
    if v_post.status <> 'approved' and v_from_status not in ('scheduled') then
      raise exception 'Only approved content may be scheduled or published (current status: %)', v_from_status;
    end if;
    if not v_can_publish then
      raise exception 'Only a Publisher, Resource Administrator, or Super Admin may schedule or publish';
    end if;
  elsif p_to_status = 'review_due' or p_to_status = 'archived' then
    if not (v_can_publish or v_can_manage) then
      raise exception 'Not permitted to change this post''s status';
    end if;
  elsif p_to_status = 'idea' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_manage)) then
      raise exception 'Not permitted to move this post back to idea';
    end if;
  end if;

  v_actor_role := case
    when private.is_fhip_super_admin(v_actor) then 'super_admin'
    when private.has_resource_role(v_actor, 'resource_admin') then 'resource_admin'
    when private.has_resource_role(v_actor, 'publisher') then 'publisher'
    when private.has_resource_role(v_actor, 'compliance_reviewer') then 'compliance_reviewer'
    when private.has_resource_role(v_actor, 'editor') then 'editor'
    when private.has_resource_role(v_actor, 'author') then 'author'
    when private.has_resource_role(v_actor, 'analyst') then 'analyst'
    else 'unknown'
  end;

  update public.resource_posts set
    status = p_to_status,
    editorial_approved_by = case when p_to_status = 'approved' and compliance_classification <> 'amber' then v_actor else editorial_approved_by end,
    editorial_approved_at = case when p_to_status = 'approved' and compliance_classification <> 'amber' then now() else editorial_approved_at end,
    compliance_approved_by = case when p_to_status = 'approved' and compliance_classification = 'amber' then v_actor else compliance_approved_by end,
    compliance_approved_at = case when p_to_status = 'approved' and compliance_classification = 'amber' then now() else compliance_approved_at end,
    published_at = case when p_to_status = 'published' and published_at is null then now() else published_at end,
    updated_by = v_actor,
    updated_at = now()
  where id = p_post_id
  returning * into v_post;

  insert into public.resource_workflow_history (post_id, from_status, to_status, actor_user_id, actor_role, action, reason, notes)
  values (p_post_id, v_from_status, p_to_status, v_actor, v_actor_role, 'status_transition', p_reason, p_notes);

  insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, after_state, metadata)
  values ('resource_post', p_post_id, 'status_transition', v_actor,
    jsonb_build_object('status', v_from_status),
    jsonb_build_object('status', p_to_status),
    jsonb_build_object('reason', p_reason, 'notes', p_notes, 'actor_role', v_actor_role));

  return v_post;
end;
$$;
revoke all on function public.transition_resource_post_status(uuid, text, text, text) from public;
grant execute on function public.transition_resource_post_status(uuid, text, text, text) to authenticated, service_role;

comment on function public.transition_resource_post_status is
  'R1.1 — the only sanctioned path for changing resource_posts.status. Enforces the R1.1 permission matrix (spec §44) and the GREEN/AMBER/RED compliance workflow (spec §41-43) inside the function itself, then records a resource_workflow_history row and a resource_audit_log row atomically with the status change. Direct UPDATE of status/approval columns is blocked at the grant level (see the REVOKE UPDATE / column-scoped GRANT UPDATE on resource_posts above).';


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0034_resources_seed.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0034_resources_seed.sql)
-- ============================================================================
-- =============================================================================
-- Resources — R1.1 minimal seed data
-- =============================================================================
-- Per spec §65: only foundation data required for safe development/testing.
-- Explicitly NOT the 218-record R0-A import (that is R1.7).

insert into resource_settings (key, value, description) values
  ('youtube_channel_handle', '"@GKTC"'::jsonb, 'Default @GKTC YouTube channel handle for Resource Videos'),
  ('youtube_channel_url', '"https://www.youtube.com/@GKTC"'::jsonb, 'Default @GKTC YouTube channel URL'),
  ('default_review_cycle_days', '365'::jsonb, 'Default number of days before a published post''s next_review_at falls due'),
  ('default_disclaimer', '"This content is general financial education, not personal financial advice. It does not take into account your individual objectives, financial situation or needs."'::jsonb, 'Default disclaimer text for GREEN/AMBER content')
on conflict (key) do nothing;

-- Initial foundational taxonomy seed (reconciled during the R1.1 closure
-- pass: these are genuine top-level categories drawn directly from spec
-- §24's own eventual-taxonomy list, not throwaway test fixtures — they are
-- real, intended top-level Resources categories, just a small foundational
-- subset rather than the full ~14-category set. R1.7's full R0-A import
-- will add the remaining categories and the 218 content records; it is not
-- expected to need to remove or rename any of the five seeded here.
insert into resource_categories (name, slug, description, sort_order) values
  ('Financial Health', 'financial-health', 'Understanding and improving your overall financial health', 1),
  ('Managing Money', 'managing-money', 'Budgeting, cash flow, and day-to-day money management', 2),
  ('Emergency & Resilience', 'emergency-resilience', 'Building a safety net and preparing for shocks', 3),
  ('Investing', 'investing', 'Growing wealth through investment', 4),
  ('FHIP Explained', 'fhip-explained', 'How FHIP''s scores, forecasts, and features work', 5)
on conflict (slug) do nothing;


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0035_resources_analyst_role_delta.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0035_resources_analyst_role_delta.sql)
-- ============================================================================
-- =============================================================================
-- Resources — R1.1 closure-pass delta: Analyst role reconciliation
-- =============================================================================
-- 0033_resources_foundation.sql was edited in place (still uncommitted, not
-- yet permanent history) to add the sixth Resources role, 'analyst', per
-- the R1.1 closure-pass brief's reconciliation against the approved R0-B
-- spec. This delta brings the already-applied DEV schema in sync with that
-- edit without re-running the full 928-line file. A fresh database applying
-- 0033 (as it now stands) + 0034 + this file gets the identical end state —
-- this file exists only because 0033 was already live in DEV before the
-- edit was made.

alter table resource_user_roles drop constraint if exists resource_user_roles_role_check;
alter table resource_user_roles drop constraint if exists resource_user_roles_role_check;

alter table resource_user_roles add constraint resource_user_roles_role_check
  check (role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'));

-- Redefine is_resource_staff to explicitly exclude 'analyst' — Analyst must
-- not gain draft/workflow visibility merely because the role exists (R1.1
-- closure brief §5). Everywhere this function is already used by an RLS
-- policy or the transition RPC picks up the new definition automatically
-- (CREATE OR REPLACE, same signature, no re-grant needed).
create or replace function private.is_resource_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.resource_user_roles r
    where r.user_id = p_user_id and r.is_active
      and r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher')
  ) or private.is_fhip_super_admin(p_user_id);
$$;

create or replace function private.is_resource_analyst(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_resource_role(p_user_id, 'analyst') or private.can_manage_resources(p_user_id);
$$;
revoke all on function private.is_resource_analyst(uuid) from public;
grant execute on function private.is_resource_analyst(uuid) to authenticated, service_role;

create or replace function public.transition_resource_post_status(
  p_post_id uuid,
  p_to_status text,
  p_reason text default null,
  p_notes text default null
)
returns resource_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_post public.resource_posts;
  v_from_status text;
  v_can_editorial boolean;
  v_can_compliance boolean;
  v_can_publish boolean;
  v_can_manage boolean;
  v_actor_role text;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_post from public.resource_posts where id = p_post_id for update;
  if not found then
    raise exception 'Resource post % not found', p_post_id;
  end if;
  v_from_status := v_post.status;

  if p_to_status not in ('idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived') then
    raise exception 'Invalid target status: %', p_to_status;
  end if;

  v_can_editorial := private.has_resource_role(v_actor, 'editor') or private.can_manage_resources(v_actor);
  v_can_compliance := private.has_resource_role(v_actor, 'compliance_reviewer') or private.can_manage_resources(v_actor);
  v_can_publish := private.can_publish_resource(v_actor);
  v_can_manage := private.can_manage_resources(v_actor);

  if p_to_status = 'draft' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to move this post to draft';
    end if;
  elsif p_to_status = 'editorial_review' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_editorial)) then
      raise exception 'Not permitted to submit this post for editorial review';
    end if;
  elsif p_to_status = 'compliance_review' then
    if not v_can_editorial then
      raise exception 'Only an Editor, Resource Administrator, or Super Admin may send content to compliance review';
    end if;
  elsif p_to_status = 'approved' then
    if v_post.compliance_classification = 'amber' then
      if not v_can_compliance then
        raise exception 'AMBER content requires Compliance Reviewer approval, not editorial approval alone';
      end if;
    else
      if not v_can_editorial then
        raise exception 'Only an Editor, Resource Administrator, or Super Admin may approve GREEN content';
      end if;
    end if;
  elsif p_to_status = 'scheduled' or p_to_status = 'published' then
    if v_post.compliance_classification = 'red' then
      raise exception 'RED content cannot be scheduled or published under the standard R1.1 workflow';
    end if;
    if v_post.compliance_classification = 'amber' and v_post.compliance_approved_by is null then
      raise exception 'AMBER content must have a recorded Compliance Reviewer approval before it can be scheduled or published';
    end if;
    if v_post.status <> 'approved' and v_from_status not in ('scheduled') then
      raise exception 'Only approved content may be scheduled or published (current status: %)', v_from_status;
    end if;
    if not v_can_publish then
      raise exception 'Only a Publisher, Resource Administrator, or Super Admin may schedule or publish';
    end if;
  elsif p_to_status = 'review_due' or p_to_status = 'archived' then
    if not (v_can_publish or v_can_manage) then
      raise exception 'Not permitted to change this post''s status';
    end if;
  elsif p_to_status = 'idea' then
    if not (private.is_resource_staff(v_actor) and (v_post.created_by = v_actor or v_can_manage)) then
      raise exception 'Not permitted to move this post back to idea';
    end if;
  end if;

  v_actor_role := case
    when private.is_fhip_super_admin(v_actor) then 'super_admin'
    when private.has_resource_role(v_actor, 'resource_admin') then 'resource_admin'
    when private.has_resource_role(v_actor, 'publisher') then 'publisher'
    when private.has_resource_role(v_actor, 'compliance_reviewer') then 'compliance_reviewer'
    when private.has_resource_role(v_actor, 'editor') then 'editor'
    when private.has_resource_role(v_actor, 'author') then 'author'
    when private.has_resource_role(v_actor, 'analyst') then 'analyst'
    else 'unknown'
  end;

  update public.resource_posts set
    status = p_to_status,
    editorial_approved_by = case when p_to_status = 'approved' and compliance_classification <> 'amber' then v_actor else editorial_approved_by end,
    editorial_approved_at = case when p_to_status = 'approved' and compliance_classification <> 'amber' then now() else editorial_approved_at end,
    compliance_approved_by = case when p_to_status = 'approved' and compliance_classification = 'amber' then v_actor else compliance_approved_by end,
    compliance_approved_at = case when p_to_status = 'approved' and compliance_classification = 'amber' then now() else compliance_approved_at end,
    published_at = case when p_to_status = 'published' and published_at is null then now() else published_at end,
    updated_by = v_actor,
    updated_at = now()
  where id = p_post_id
  returning * into v_post;

  insert into public.resource_workflow_history (post_id, from_status, to_status, actor_user_id, actor_role, action, reason, notes)
  values (p_post_id, v_from_status, p_to_status, v_actor, v_actor_role, 'status_transition', p_reason, p_notes);

  insert into public.resource_audit_log (entity_type, entity_id, action, actor_user_id, before_state, after_state, metadata)
  values ('resource_post', p_post_id, 'status_transition', v_actor,
    jsonb_build_object('status', v_from_status),
    jsonb_build_object('status', p_to_status),
    jsonb_build_object('reason', p_reason, 'notes', p_notes, 'actor_role', v_actor_role));

  return v_post;
end;
$$;


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0036_resources_anon_function_grants_fix.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0036_resources_anon_function_grants_fix.sql)
-- ============================================================================
-- =============================================================================
-- Resources — R1.1 closure-pass fix: missing `anon` EXECUTE grants
-- =============================================================================
-- GENUINE DEFECT found during live R1.1 closure-pass testing, not a design
-- change: `anon` was never granted EXECUTE on private.is_resource_staff or
-- private.can_manage_resources. Postgres requires the querying role to hold
-- EXECUTE on every function referenced in ANY RLS policy attached to a
-- table it queries — even a policy that evaluates false for that role — so
-- every anonymous SELECT against resource_posts (and every table joined to
-- it) was failing outright with "permission denied for function
-- is_resource_staff" instead of correctly returning the public rows. This
-- broke the single most basic public-read case (§13 of the closure brief).
--
-- The RLS policy logic itself was already correct — anon was never at risk
-- of seeing a draft or unpublished row; the bug made public reads fail
-- closed (an outage-class bug) rather than fail open (a security bug), but
-- it is still a genuine defect that must be fixed before FULL PASS.

grant execute on function private.can_manage_resources(uuid) to anon;
grant execute on function private.is_resource_staff(uuid) to anon;


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0037_resources_editor_support.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0037_resources_editor_support.sql)
-- ============================================================================
-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.3 editor support delta
-- =============================================================================
-- Additive, minimal (spec §8: "Avoid a migration if the current schema
-- already supports the requirement" — checked first; it does not for this
-- one specific column). Does not touch 0033-0036.
--
-- Genuine gap found during the R1.3 pre-implementation schema audit:
-- 0033's column-scoped UPDATE grant on resource_posts (the "authors insert
-- own drafts" / "staff update posts" RLS-plus-column-privilege pair that
-- lets content-workflow staff edit ordinary content fields directly, without
-- going through the SECURITY DEFINER transition RPC) lists every editable
-- content column EXCEPT compliance_classification:
--
--   grant update (
--     title, slug, excerpt, content_blocks, content_type, jurisdiction, difficulty,
--     freshness_type, visibility, primary_category_id, featured_image_id, author_id,
--     reviewer_id, compliance_reviewer_id, expires_at, last_reviewed_at, next_review_at,
--     seo_title, seo_description, canonical_url, social_image_id, is_indexable,
--     primary_cta_id, secondary_cta_id, is_featured, featured_priority, updated_by, updated_at
--   ) on resource_posts to authenticated;
--
-- R1.1 never needed this column writable (no editor existed yet — INSERT is
-- unrestricted, so a post's *initial* classification could be set at
-- creation, but never revised afterwards by anyone other than service-role).
-- R1.3 spec §53-56 requires the editor to let authorised staff manage GREEN/
-- AMBER/RED as ordinary content metadata (same governance tier as
-- jurisdiction/difficulty — any Resources-workflow staff member, not a
-- privileged-only operation), so this is a genuine, narrow requirement this
-- migration exists to satisfy.
--
-- This does NOT weaken the R1.1 security boundary: it only widens the
-- *column* privilege ceiling for a role/row-set that already has RLS UPDATE
-- access to the row (private.is_resource_staff() via the existing "staff
-- update posts" policy, unchanged here). It does not touch `status` or any
-- of the four approval columns / scheduled_at / published_at — those remain
-- exclusively reachable through public.transition_resource_post_status(),
-- exactly as before. The existing hard backstops
-- (chk_resource_posts_amber_requires_compliance,
-- chk_resource_posts_red_never_publishes) are unaffected and continue to
-- apply regardless of what compliance_classification value a direct UPDATE
-- sets, because those constraints are keyed off `status`, and `status` is
-- still only writable via the RPC.

grant update (compliance_classification) on resource_posts to authenticated;

comment on column resource_posts.compliance_classification is
  'GREEN/AMBER/RED editorial-compliance classification. Editable by any Resources content-workflow staff role via ordinary column UPDATE (RLS: "staff update posts") as of migration 0037 — R1.1 (0033) omitted this column from the authenticated UPDATE grant, which blocked reclassification after creation. status and the four approval columns remain reachable only via public.transition_resource_post_status().';


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0038_resources_specialist_content_support.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0038_resources_specialist_content_support.sql)
-- ============================================================================
-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.4 specialist content delta
-- =============================================================================
-- Additive, minimal (spec §10: "Before creating it, prove the existing schema
-- cannot support the required feature cleanly. Keep changes additive and
-- narrow."). Does not touch 0033-0037.
--
-- Pre-implementation audit (spec §9) found resource_posts/resource_videos/
-- resource_faqs/resource_post_faqs/resource_sources/resource_post_sources/
-- resource_context_links/resource_related_content already cover the large
-- majority of R1.4's data model with zero schema changes:
--   - Video: resource_videos already has youtube_video_id/url/channel,
--     duration, thumbnail_url, transcript, chapters (jsonb array),
--     embed_enabled. No change needed.
--   - Glossary: term/short-definition/detailed-explanation/example map to
--     resource_posts.title/excerpt/content_blocks exactly as R1.3 already
--     uses them for other content types. Related Terms maps directly onto
--     the existing resource_related_content table (relationship_type
--     'related', self-reference and duplicate-pair already blocked by its
--     existing constraints). No change needed for either.
--   - Money Update structured sections (What Happened / Why It Matters /
--     Who May Be Affected / Financial Health Impact / FHIP Relevance /
--     Official Sources) map onto content_blocks the same way R1.3's
--     starterTemplateFor() pre-populates headings for Article/Guide/FHIP
--     Explainer — a new specialist starter template function, not a schema
--     change. Authoritative-source linking reuses resource_sources /
--     resource_post_sources exactly as-is.
--   - FAQ ordering-per-post: resource_post_faqs.sort_order already exists
--     (spec §37: "If the current relationship table supports ordering,
--     allow post-specific FAQ order" — it already does).
--
-- Three genuine, narrow gaps remain, addressed below:
--
-- 1. resource_posts.event_date — Money Update's "Event Date" (spec §42) is
--    the real-world date the financial development occurred, which is a
--    distinct concept from every existing date column on resource_posts
--    (scheduled_at/published_at are FHIP-editorial-workflow dates;
--    expires_at/next_review_at are freshness dates). It is also a required
--    list column and filter/sort target (spec §41), which needs a real,
--    indexable column rather than something encoded inside content_blocks.
--
-- 2. resource_posts.affected_audience — Money Update's "Affected Audience"
--    (spec §42) is listed as a field distinct from "Summary / 30-second
--    explanation" (which reuses the existing `excerpt` column, same as
--    every other content type). No existing column represents it.
--
-- 3. resource_posts.aliases — Glossary's "Aliases / Synonyms" (spec §26)
--    must be searchable (spec §25/§72: "search by term/aliases/definition")
--    and duplicate-checkable, which requires a real queryable column, not
--    free text embedded in content_blocks. text[] rather than a join table:
--    aliases are simple short strings scoped entirely to one glossary term
--    (not a shared/reusable taxonomy the way tags are), so a normalised
--    child table would be overhead disproportionate to the actual need.
--
-- A fourth, narrower gap: resource_faqs (spec §34) needs a few fields the
-- R1.1 foundation table doesn't carry — short_answer (spec §34: "Short
-- Answer / Required" is conceptually distinct from the existing
-- answer_blocks, which better represents the optional "Expanded Answer"),
-- category_id (spec §33/§34 list this as both a list column and an editable
-- field; resource_categories already exists and is reused as-is, no new
-- taxonomy concept), compliance_classification (spec §34: "if FAQ schema
-- contains/needs governance classification" — narrow, GREEN-default, same
-- three-value model as resource_posts, so a shared FAQ can be judged for
-- editorial risk the same way a post can), and updated_by (spec §57: "If
-- FAQ schema supports updated_at, use equivalent stale protection where
-- practical" — resource_faqs already has updated_at; updated_by is the
-- companion audit column every other Resources table already carries).

-- -----------------------------------------------------------------------------
-- 1. resource_posts: three new nullable columns for Money Update / Glossary.
-- -----------------------------------------------------------------------------
alter table resource_posts add column if not exists event_date date;
alter table resource_posts add column if not exists affected_audience text;
alter table resource_posts add column if not exists aliases text[];

comment on column resource_posts.event_date is
  'R1.4 — the real-world date a Money Update''s financial development occurred (not an FHIP editorial-workflow date). Null for content types other than money_update/money_update_template.';
comment on column resource_posts.affected_audience is
  'R1.4 — Money Update''s "Who may be affected" short summary field (spec §42). Null for content types other than money_update/money_update_template.';
comment on column resource_posts.aliases is
  'R1.4 — Glossary term aliases/search synonyms (spec §26), e.g. {Emergency Fund, Rainy Day Fund, Cash Buffer}. Null/empty for content types other than glossary.';

create index if not exists idx_resource_posts_event_date on resource_posts(event_date);
-- GIN + pg_trgm would give substring-in-array search; this project's other
-- text search (sanitizeSearchTerm + ilike, lib/resources/admin/queries.ts)
-- does not use trigram indexes anywhere else either, and the Glossary table
-- is tiny (dozens of rows, spec §1's approved master lists 50 definitions
-- total) — a sequential scan over `aliases` is not a real performance
-- concern at this scale, so no extension/index is added for it here.

-- Column-scoped UPDATE grant (spec §57/§99 pattern, migration 0033/0037):
-- these three columns must be explicitly added to the authenticated
-- column-allowlist or they are silently unwritable by ordinary staff saves
-- (PostgREST enforces column grants; the existing grant list from 0033 is a
-- fixed allowlist, not "every column except the ones explicitly revoked").
grant update (event_date, affected_audience, aliases) on resource_posts to authenticated;

-- -----------------------------------------------------------------------------
-- 2. resource_faqs: governance/categorisation/short-answer columns.
-- -----------------------------------------------------------------------------
alter table resource_faqs add column if not exists short_answer text;
alter table resource_faqs add column if not exists category_id uuid references resource_categories(id) on delete set null;
alter table resource_faqs add column if not exists compliance_classification text not null default 'green'
  check (compliance_classification in ('green', 'amber', 'red'));
alter table resource_faqs add column if not exists updated_by uuid references auth.users(id) on delete set null;

comment on column resource_faqs.short_answer is
  'R1.4 — required standalone-usable short answer (spec §34/§35). Nullable at the DB level (table pattern established by 0033: required-for-workflow fields are nullable in the DB and enforced by application-level validation, e.g. resource_posts.primary_category_id) — enforced by lib/resources/faq/validation.ts before a FAQ can be marked active.';
comment on column resource_faqs.category_id is
  'R1.4 — optional FAQ category, reusing the existing resource_categories taxonomy (spec §106: do not build a parallel category concept).';
comment on column resource_faqs.compliance_classification is
  'R1.4 — GREEN/AMBER/RED governance classification for a standalone FAQ (spec §34), same three-value model as resource_posts.compliance_classification. FAQs are never routed through public.transition_resource_post_status (they are not resource_posts rows) — this column is informational/editorial only in R1.4, there is no FAQ-specific compliance workflow RPC.';

create index if not exists idx_resource_faqs_category on resource_faqs(category_id);
create index if not exists idx_resource_faqs_compliance on resource_faqs(compliance_classification);

-- resource_faqs already has unrestricted (non-column-scoped) insert/update
-- grants to `authenticated` from migration 0033
-- (`grant insert, update, delete on resource_sources, resource_faqs to
-- authenticated;`), gated by the existing "staff manage faqs" RLS policy —
-- no grant change needed for the new columns.


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0039_resources_public_settings_read.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0039_resources_public_settings_read.sql)
-- ============================================================================
-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.5 public settings read
-- =============================================================================
-- R1.5 spec §57: "Use the centrally managed Resources disclaimer/settings
-- where implemented. Do not copy/paste separate disclaimer wording into each
-- public component." resource_settings already carries a seeded
-- `default_disclaimer` value (migration 0034) plus the @GKTC channel handle/
-- URL — but migration 0033 only ever granted it a staff-only SELECT policy
-- ("staff read settings", private.is_resource_staff(auth.uid())). An
-- anonymous/ordinary-authenticated public visitor genuinely cannot read it
-- today, which would force R1.5 to hard-code a duplicate copy of the
-- disclaimer string instead of reading the one real source of truth — this
-- is the one genuine, narrow schema gap R1.5 found (spec §131 D: "expected
-- None unless a genuine gap requires a narrow migration").
--
-- Kept intentionally narrow: an explicit fixed allowlist of three known-safe
-- keys (not "any settings row"), so nothing sensitive/internal that might
-- later be added to resource_settings (e.g. workflow tuning values) is
-- silently exposed to anon by this policy. All three values are already
-- either publicly visible elsewhere (the @GKTC handle/URL are shown in every
-- public video's attribution and R1.4's own YouTube embed component) or
-- explicitly meant for public display (the disclaimer itself).
drop policy if exists "public read safe settings" on resource_settings;

create policy "public read safe settings" on resource_settings for select
  using (key in ('default_disclaimer', 'youtube_channel_handle', 'youtube_channel_url'));

-- resource_settings already has a blanket SELECT grant to anon/authenticated
-- from migration 0033 (`grant select on resource_categories, ...,
-- resource_settings, ... to anon, authenticated;`) — RLS (the policy above)
-- is what actually narrows the visible rows, so no grant change is needed
-- here, matching the same pattern every other R1.1 public-read policy uses.


-- ============================================================================
-- RE-EMITTED FROM ARCHIVED HISTORICAL MIGRATION: 0040_resources_discovery_context_support.sql
-- (original artefact preserved verbatim at supabase/migration_archive/0040_resources_discovery_context_support.sql)
-- ============================================================================
-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.6 Discovery & Context support
-- =============================================================================
-- Additive, narrow migration. Does not modify 0033-0039. Audited first (R1.6
-- completion report §B): resource_related_content, resource_ctas and
-- resource_context_links already exist with the exact shape R1.6 needs
-- (relationship_type/sort_order on related content; destination_type/
-- is_active on CTAs; context_key/module/label/is_active/sort_order on
-- context links) — no new tables for those. Two gaps found by the audit are
-- closed here:
--
--   1. No full-text search representation exists anywhere (no resource_search
--      table, no tsvector column). R1.6 spec §16 prefers a generated
--      search_vector column + GIN index over introducing an external search
--      provider or a hand-maintained side table. Added below, generated from
--      resource_posts.title/excerpt/aliases only (spec §15: body/transcript
--      indexing is optional and "only if it can be done cleanly" — content_blocks
--      is unstructured per-block jsonb with no stable text-extraction path
--      the R1.1-R1.5 schema defines, so it is deliberately NOT included in the
--      generated column; video transcript search is handled separately, as a
--      lower-priority ILIKE tier over resource_videos.transcript, directly in
--      the search RPC below — see that function's comments).
--
--   2. resource_context_links has RLS policies for staff only (0033's own
--      header comment: "no legitimate reason for anon/ordinary authenticated
--      to read it before that integration is built" — R1.6 IS that
--      integration). A narrow public read policy is added, scoped to active
--      links whose mapped post is public per the exact PUBLIC_STATUSES rule
--      lib/resources/public/visibility.ts already encodes (published/
--      review_due, public/unlisted visibility, published_at in the past,
--      never money_update_template) — not the wider RLS-only predicate that
--      also allows archived. This mirrors resource_related_content's existing
--      "public read related links between readable posts" policy pattern
--      exactly, just keyed off resource_post_id instead of source_post_id.
--
-- Everything else R1.6 needs (public read of active resource_ctas, public
-- read of resource_related_content rows whose *source* is public) already
-- exists from 0033 and is reused unmodified. The application layer
-- (lib/resources/discovery/related.ts) additionally re-checks the *related*
-- post's own visibility in TypeScript via isPubliclyVisible() before
-- rendering anything — see that file's header — because 0033's related-
-- content policy only constrains the source side, by design (a manually
-- linked target that later becomes Draft must disappear per spec §34/§88,
-- and RLS alone cannot express "the embedded related post individually
-- passes the same public rule" without a second policy on resource_posts
-- itself, which is out of scope to touch here).

-- -----------------------------------------------------------------------------
-- 1. Full-text search support for resource_posts
-- -----------------------------------------------------------------------------
-- Weighted per spec §17's stated relevance order: title and Glossary
-- aliases both get weight A (an alias is exactly as good a match as the
-- term's own title — spec §85's "rainy day fund" -> "Emergency Fund" test
-- depends on this), excerpt gets weight B. Category/tag and transcript
-- matching are handled outside this column (see the RPC below) since they
-- live in other tables.
--
-- Postgres will not accept to_tsvector('english', ...) written directly
-- inside a GENERATED ALWAYS AS (...) STORED expression (42P17: "generation
-- expression is not immutable" — caught live applying this migration to
-- DEV). The 2-arg to_tsvector(regconfig, text) function is itself marked
-- IMMUTABLE, but resolving the text literal 'english' to a regconfig OID is
-- a catalog lookup, and the generated-column validator does not accept that
-- as provably immutable — a long-standing, well-documented Postgres
-- limitation, unrelated to anything specific to this schema. Fixed by
-- wrapping the computation in our own SQL function explicitly declared
-- IMMUTABLE: Postgres then only checks this function's declared volatility
-- as a single node, not the nodes inside its body.
create or replace function resource_posts_search_vector(title text, aliases text[], excerpt text)
returns tsvector
language sql
immutable
as $$
  select
    setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('pg_catalog.english', coalesce(array_to_string(aliases, ' '), '')), 'A') ||
    setweight(to_tsvector('pg_catalog.english', coalesce(excerpt, '')), 'B');
$$;

comment on function resource_posts_search_vector is
  'R1.6 — IMMUTABLE wrapper around to_tsvector() so resource_posts.search_vector can be a GENERATED ALWAYS AS (...) STORED column (see this function''s own inline comment above for why to_tsvector(''english'', ...) cannot be written directly inside that expression).';

alter table resource_posts add column if not exists search_vector tsvector
  generated always as (resource_posts_search_vector(title, aliases, excerpt)) stored;

comment on column resource_posts.search_vector is
  'R1.6 — generated tsvector for public search (title+aliases weight A, excerpt weight B), computed via the IMMUTABLE resource_posts_search_vector() wrapper. Always in sync with the source row (STORED GENERATED ALWAYS AS, not a trigger) — spec §82: no manual "rebuild search" step, ever, including after R1.7''s bulk import.';

create index if not exists idx_resource_posts_search_vector on resource_posts using gin(search_vector);

-- -----------------------------------------------------------------------------
-- 2. Public search RPC
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER (the default — stated explicitly for clarity), not
-- SECURITY DEFINER: this function runs as the *calling* anon/authenticated
-- role, so every row it can possibly return is still independently gated by
-- resource_posts' own "public read published posts" RLS policy underneath —
-- the WHERE clause below is a second, narrower, application-level filter
-- (the exact PUBLIC_STATUSES/PUBLIC_CONTENT_TYPES rule from
-- lib/resources/public/visibility.ts), not the only line of defence. This is
-- deliberately NOT service-role (spec §25/§137: "no service-role search").
--
-- No dynamic SQL anywhere in this function body — p_query is used only as a
-- plain typed parameter to websearch_to_tsquery(), ILIKE and equality
-- comparisons, never concatenated into an executed string, so there is no
-- SQL-injection surface regardless of what text is passed (spec §19/§106).
create or replace function public.search_resource_posts(
  p_query text,
  p_content_type text default null,
  p_jurisdiction text default null,
  p_category_id uuid default null,
  p_limit int default 12,
  p_offset int default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  excerpt text,
  content_type text,
  jurisdiction text,
  difficulty text,
  published_at timestamptz,
  updated_at timestamptz,
  event_date date,
  is_featured boolean,
  featured_priority int,
  rank_score real,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      websearch_to_tsquery('english', coalesce(p_query, '')) as tsq,
      lower(btrim(coalesce(p_query, ''))) as raw
  ),
  scored as (
    select
      p.id, p.slug, p.title, p.excerpt, p.content_type, p.jurisdiction, p.difficulty,
      p.published_at, p.updated_at, p.event_date, p.is_featured, p.featured_priority,
      -- Deterministic tiered score (spec §17/§18: understandable from code,
      -- no opaque "AI relevance"). Bands are spaced far enough apart that a
      -- lower-tier match can never outrank a higher tier; ts_rank_cd only
      -- breaks ties *within* the title/excerpt tiers.
      (
        case when lower(p.title) = (select raw from q) then 1000000 else 0 end
        + case when (select raw from q) <> '' and p.title ilike '%' || (select raw from q) || '%' then 100000 else 0 end
        + case when exists (
            select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term)
            where lower(al.term) = (select raw from q)
          ) then 90000 else 0 end
        + case when exists (
            select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term)
            where (select raw from q) <> '' and lower(al.term) like '%' || (select raw from q) || '%'
          ) then 80000 else 0 end
        + case when (select raw from q) <> '' and p.excerpt ilike '%' || (select raw from q) || '%' then 5000 else 0 end
        + case when exists (
            select 1 from public.resource_post_categories rpc
            join public.resource_categories rc on rc.id = rpc.category_id
            where rpc.post_id = p.id and (select raw from q) <> '' and lower(rc.name) like '%' || (select raw from q) || '%'
          ) then 500 else 0 end
        + case when exists (
            select 1 from public.resource_post_tags rpt
            join public.resource_tags rt on rt.id = rpt.tag_id
            where rpt.post_id = p.id and (select raw from q) <> '' and lower(rt.name) like '%' || (select raw from q) || '%'
          ) then 300 else 0 end
        -- Video transcript — lowest tier, per spec §84 ("must not push an
        -- irrelevant Video above an exact title match").
        + case when p.content_type = 'video' and exists (
            select 1 from public.resource_videos v
            where v.resource_post_id = p.id and (select raw from q) <> '' and v.transcript ilike '%' || (select raw from q) || '%'
          ) then 50 else 0 end
        + coalesce(ts_rank_cd(p.search_vector, (select tsq from q)), 0) * 10
      )::real as rank_score,
      count(*) over () as total_count
    from public.resource_posts p
    where
      -- Exact mirror of lib/resources/public/visibility.ts's
      -- applyPublicPostVisibility()/PUBLIC_STATUSES/PUBLIC_CONTENT_TYPES —
      -- spec §25's "reuse the certified equivalent" backstop.
      p.status in ('published', 'review_due')
      and p.visibility in ('public', 'unlisted')
      and p.published_at is not null
      and p.published_at <= now()
      and p.content_type in ('article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update')
      and (p_content_type is null or p_content_type = 'all' or p.content_type = p_content_type)
      and (
        p_jurisdiction is null or p_jurisdiction = 'all'
        or (p_jurisdiction = 'global' and p.jurisdiction = 'global')
        or (p_jurisdiction <> 'global' and p.jurisdiction in (p_jurisdiction, 'global'))
      )
      and (
        p_category_id is null
        or exists (select 1 from public.resource_post_categories rpc2 where rpc2.post_id = p.id and rpc2.category_id = p_category_id)
      )
      and (
        (select raw from q) = ''
        or p.search_vector @@ (select tsq from q)
        or p.title ilike '%' || (select raw from q) || '%'
        or exists (select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term) where lower(al.term) like '%' || (select raw from q) || '%')
        or exists (
            select 1 from public.resource_videos v
            where v.resource_post_id = p.id and v.transcript ilike '%' || (select raw from q) || '%'
          )
      )
  )
  select id, slug, title, excerpt, content_type, jurisdiction, difficulty, published_at, updated_at, event_date, is_featured, featured_priority, rank_score, total_count
  from scored
  order by rank_score desc, published_at desc nulls last, id
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.search_resource_posts(text, text, text, uuid, int, int) from public;
grant execute on function public.search_resource_posts(text, text, text, uuid, int, int) to anon, authenticated;

comment on function public.search_resource_posts is
  'R1.6 public Resources search (spec Part A). SECURITY INVOKER — runs under the caller''s own RLS, never service-role. Deterministic tiered ranking, no AI. Never returns money_update_template, draft, or any other non-public row — WHERE clause mirrors lib/resources/public/visibility.ts exactly, and the caller''s own RLS is a second, independent backstop underneath it.';

-- -----------------------------------------------------------------------------
-- 3. Public read of active FHIP contextual mappings (for readable posts only)
-- -----------------------------------------------------------------------------
-- Additive alongside 0033's existing "staff read context links" / "staff
-- manage context links" policies — this does not replace either. Mirrors
-- resource_related_content's "public read related links between readable
-- posts" policy pattern, keyed on resource_post_id instead of source_post_id,
-- and additionally requires is_active (spec §63: "Draft mapping does not
-- leak" / §98). Same PUBLIC_STATUSES subset as the search RPC above
-- (published/review_due only — deliberately narrower than the raw RLS-level
-- predicate elsewhere in this schema, which also allows archived; R1.5's
-- documented product decision excludes archived from every public surface,
-- and context links follow that same decision rather than inventing a wider
-- one here).
drop policy if exists "public read active context links to public posts" on resource_context_links;

create policy "public read active context links to public posts" on resource_context_links for select
  using (
    is_active
    and exists (
      select 1 from resource_posts p
      where p.id = resource_post_id
        and p.status in ('published', 'review_due')
        and p.visibility in ('public', 'unlisted')
        and p.published_at is not null
        and p.published_at <= now()
        and p.content_type <> 'money_update_template'
    )
  );

