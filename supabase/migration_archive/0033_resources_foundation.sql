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
create table resource_user_roles (
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
create unique index uq_resource_user_roles_active on resource_user_roles(user_id, role) where is_active;
create index idx_resource_user_roles_user on resource_user_roles(user_id) where is_active;
create index idx_resource_user_roles_role on resource_user_roles(role) where is_active;

alter table resource_user_roles enable row level security;
-- Self-read only, mirroring admin_users' existing "self read admin flag"
-- policy exactly. Role assignment/removal happens via the service-role
-- client only (no INSERT/UPDATE/DELETE policy is granted to any
-- client-facing role) — R1.1 has no admin UI to assign roles through yet;
-- when R1.2 builds one, it will call through the service-role client from a
-- server action, the same pattern admin_users already uses. This is the
-- strictest possible stance against self-escalation (spec §51) and requires
-- no new trust decision beyond what admin_users already established.
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
create table resource_categories (
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
create index idx_resource_categories_parent on resource_categories(parent_id);
create index idx_resource_categories_slug on resource_categories(slug);
create index idx_resource_categories_active on resource_categories(is_active);

-- -----------------------------------------------------------------------------
-- 4. Tags
-- -----------------------------------------------------------------------------
create table resource_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_resource_tags_slug on resource_tags(slug);
create index idx_resource_tags_active on resource_tags(is_active);

-- -----------------------------------------------------------------------------
-- 5. Authors (may or may not be a real FHIP/Supabase Auth user)
-- -----------------------------------------------------------------------------
create table resource_authors (
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
create index idx_resource_authors_user on resource_authors(user_id);
create index idx_resource_authors_slug on resource_authors(slug);

-- -----------------------------------------------------------------------------
-- 6. Media foundation
-- -----------------------------------------------------------------------------
-- FHIP has no pre-existing generic media-metadata table (checked: report/
-- forecast PDF export writes directly to Supabase Storage with no metadata
-- row). This is a genuinely new concern, not a duplicate of anything
-- existing — created fresh, but deliberately storage-agnostic (references a
-- bucket/path rather than assuming a specific bucket) so it can point at
-- whatever bucket convention R1.2's media upload flow decides to use.
create table resource_media (
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
create index idx_resource_media_uploaded_by on resource_media(uploaded_by);

alter table resource_authors add constraint fk_resource_authors_profile_image
  foreign key (profile_image_id) references resource_media(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 7. CTA library
-- -----------------------------------------------------------------------------
create table resource_ctas (
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
create index idx_resource_ctas_active on resource_ctas(is_active);

-- -----------------------------------------------------------------------------
-- 8. Core content table — resource_posts
-- -----------------------------------------------------------------------------
create table resource_posts (
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
create index idx_resource_posts_slug on resource_posts(slug);
create index idx_resource_posts_content_id on resource_posts(content_id);
create index idx_resource_posts_status on resource_posts(status);
create index idx_resource_posts_content_type on resource_posts(content_type);
create index idx_resource_posts_jurisdiction on resource_posts(jurisdiction);
create index idx_resource_posts_published_at on resource_posts(published_at);
create index idx_resource_posts_scheduled_at on resource_posts(scheduled_at);
create index idx_resource_posts_next_review_at on resource_posts(next_review_at);
create index idx_resource_posts_primary_category on resource_posts(primary_category_id);
create index idx_resource_posts_author on resource_posts(author_id);
create index idx_resource_posts_compliance_classification on resource_posts(compliance_classification);
-- Composite index matching the public-read policy's predicate exactly
-- (status, visibility, published_at) — the query plan for the public
-- listing/detail read will use this instead of a sequential scan.
create index idx_resource_posts_public_read on resource_posts(status, visibility, published_at);

-- §9 content_blocks structural guard: must be a JSON array (not an object,
-- string, or arbitrary type) at the top level. This is deliberately
-- shallow — it does not attempt to whitelist every future block "type"
-- value (that would make adding a new block type in the editor phase a
-- migration), but it does guarantee the column can never silently become a
-- non-array shape, and it can never contain executable content because
-- JSONB has no executable-code type to begin with (there is no
-- HTML/script-tag data type in JSON — this is a storage-format guarantee,
-- not merely a convention).
alter table resource_posts add constraint chk_resource_posts_content_blocks_is_array
  check (jsonb_typeof(content_blocks) = 'array');

-- -----------------------------------------------------------------------------
-- 9. Post/Category relationship
-- -----------------------------------------------------------------------------
create table resource_post_categories (
  post_id uuid not null references resource_posts(id) on delete cascade,
  category_id uuid not null references resource_categories(id) on delete cascade,
  is_primary boolean not null default false,
  sort_order int not null default 0 check (sort_order >= 0),
  primary key (post_id, category_id)
);
create index idx_resource_post_categories_category on resource_post_categories(category_id);

-- -----------------------------------------------------------------------------
-- 10. Post/Tag relationship
-- -----------------------------------------------------------------------------
create table resource_post_tags (
  post_id uuid not null references resource_posts(id) on delete cascade,
  tag_id uuid not null references resource_tags(id) on delete cascade,
  primary key (post_id, tag_id)
);
create index idx_resource_post_tags_tag on resource_post_tags(tag_id);

-- -----------------------------------------------------------------------------
-- 11. @GKTC video foundation — metadata only, YouTube remains the host
-- -----------------------------------------------------------------------------
create table resource_videos (
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
create index idx_resource_videos_youtube_id on resource_videos(youtube_video_id);

-- -----------------------------------------------------------------------------
-- 12. Sources
-- -----------------------------------------------------------------------------
create table resource_sources (
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

create table resource_post_sources (
  post_id uuid not null references resource_posts(id) on delete cascade,
  source_id uuid not null references resource_sources(id) on delete cascade,
  sort_order int not null default 0 check (sort_order >= 0),
  notes text,
  primary key (post_id, source_id)
);
create index idx_resource_post_sources_source on resource_post_sources(source_id);

-- -----------------------------------------------------------------------------
-- 13. FAQs (reusable across posts)
-- -----------------------------------------------------------------------------
create table resource_faqs (
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

create table resource_post_faqs (
  post_id uuid not null references resource_posts(id) on delete cascade,
  faq_id uuid not null references resource_faqs(id) on delete cascade,
  sort_order int not null default 0 check (sort_order >= 0),
  primary key (post_id, faq_id)
);
create index idx_resource_post_faqs_faq on resource_post_faqs(faq_id);

-- -----------------------------------------------------------------------------
-- 14. Related content
-- -----------------------------------------------------------------------------
create table resource_related_content (
  id uuid primary key default gen_random_uuid(),
  source_post_id uuid not null references resource_posts(id) on delete cascade,
  related_post_id uuid not null references resource_posts(id) on delete cascade,
  relationship_type text not null default 'related' check (relationship_type in ('related', 'prerequisite', 'next_step', 'see_also')),
  sort_order int not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  constraint chk_resource_related_content_no_self_reference check (source_post_id <> related_post_id),
  constraint uq_resource_related_content unique (source_post_id, related_post_id, relationship_type)
);
create index idx_resource_related_content_related on resource_related_content(related_post_id);

-- -----------------------------------------------------------------------------
-- 15. FHIP contextual resource mapping
-- -----------------------------------------------------------------------------
create table resource_context_links (
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
create index idx_resource_context_links_context_key on resource_context_links(context_key);
create index idx_resource_context_links_module on resource_context_links(module);
create index idx_resource_context_links_post on resource_context_links(resource_post_id);

-- -----------------------------------------------------------------------------
-- 16. Revision history
-- -----------------------------------------------------------------------------
create table resource_post_versions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references resource_posts(id) on delete cascade,
  version_number int not null check (version_number > 0),
  snapshot jsonb not null,
  change_summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint uq_resource_post_versions unique (post_id, version_number)
);
create index idx_resource_post_versions_post on resource_post_versions(post_id, created_at);
-- No automatic snapshot trigger is created (spec §36: "do not introduce a
-- fragile automatic trigger if the required business context such as
-- change_summary cannot be captured properly" — change_summary is an
-- editor-authored field with no sensible default, so it can only be
-- captured meaningfully from the future editor UI, not synthesised by a
-- trigger). The table exists as the foundation; write path is deferred.

-- -----------------------------------------------------------------------------
-- 17. Workflow history
-- -----------------------------------------------------------------------------
create table resource_workflow_history (
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
create index idx_resource_workflow_history_post on resource_workflow_history(post_id, created_at);

-- -----------------------------------------------------------------------------
-- 18. Audit log
-- -----------------------------------------------------------------------------
create table resource_audit_log (
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
create index idx_resource_audit_log_entity on resource_audit_log(entity_type, entity_id);
create index idx_resource_audit_log_actor on resource_audit_log(actor_user_id, created_at);

-- -----------------------------------------------------------------------------
-- 19. Resources settings
-- -----------------------------------------------------------------------------
create table resource_settings (
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
create policy "public read active categories" on resource_categories for select using (is_active);
create policy "staff manage categories" on resource_categories for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

create policy "public read active tags" on resource_tags for select using (is_active);
create policy "staff manage tags" on resource_tags for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

create policy "public read active authors" on resource_authors for select using (is_active);
create policy "staff manage authors" on resource_authors for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- Media: no blanket public read (files may include not-yet-published social
-- images/author photos for draft content) — public exposure happens through
-- the specific post/author fields that reference a media row, not by
-- reading resource_media directly. Staff (any active Resources role) may
-- read all media metadata; only managers/uploaders may write.
create policy "staff read media" on resource_media for select using (private.is_resource_staff(auth.uid()));
create policy "staff insert media" on resource_media for insert with check (private.is_resource_staff(auth.uid()));
create policy "managers update media" on resource_media for update
  using (private.can_manage_resources(auth.uid()) or uploaded_by = auth.uid())
  with check (private.can_manage_resources(auth.uid()) or uploaded_by = auth.uid());
create policy "managers delete media" on resource_media for delete using (private.can_manage_resources(auth.uid()));

create policy "public read active ctas" on resource_ctas for select using (is_active);
create policy "staff manage ctas" on resource_ctas for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- --- resource_posts: the central draft-protection policy (§48/§49).
-- Public/anon AND ordinary authenticated customers get exactly the same
-- read policy — being logged in grants no extra Resources access (§49).
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
create policy "staff read all posts" on resource_posts for select using (private.is_resource_staff(auth.uid()));
-- Authors may create drafts and edit their own; editors/managers may edit
-- any post's content fields. Status/approval/publish-control columns are
-- deliberately NOT reachable through this policy at all — see the
-- column-level grants below, which is where that boundary is actually
-- enforced (RLS is row-level; Postgres column privileges are what stop a
-- content-only editor from writing to `status` directly).
create policy "authors insert own drafts" on resource_posts for insert
  with check (private.is_resource_staff(auth.uid()) and created_by = auth.uid());
create policy "staff update posts" on resource_posts for update
  using (private.is_resource_staff(auth.uid()))
  with check (private.is_resource_staff(auth.uid()));
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

create policy "public read post-category links for readable posts" on resource_post_categories for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage post-category links" on resource_post_categories for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read post-tag links for readable posts" on resource_post_tags for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage post-tag links" on resource_post_tags for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read videos for readable posts" on resource_videos for select
  using (exists (select 1 from resource_posts p where p.id = resource_post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage videos" on resource_videos for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read public sources" on resource_sources for select using (is_public);
create policy "staff read all sources" on resource_sources for select using (private.is_resource_staff(auth.uid()));
create policy "staff manage sources" on resource_sources for insert with check (private.is_resource_staff(auth.uid()));
create policy "staff update sources" on resource_sources for update using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));
create policy "managers delete sources" on resource_sources for delete using (private.can_manage_resources(auth.uid()));

create policy "public read post-source links for readable posts" on resource_post_sources for select
  using (exists (select 1 from resource_posts p join resource_sources s on s.id = source_id where p.id = post_id and s.is_public and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage post-source links" on resource_post_sources for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read active faqs" on resource_faqs for select using (is_active);
create policy "staff manage faqs" on resource_faqs for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read post-faq links for readable posts" on resource_post_faqs for select
  using (exists (select 1 from resource_posts p where p.id = post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage post-faq links" on resource_post_faqs for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

create policy "public read related links between readable posts" on resource_related_content for select
  using (exists (select 1 from resource_posts p where p.id = source_post_id and (
    (p.status in ('published', 'review_due', 'archived') and p.visibility in ('public', 'unlisted') and p.published_at is not null and p.published_at <= now())
    or private.is_resource_staff(auth.uid())
  )));
create policy "staff manage related content" on resource_related_content for all
  using (private.is_resource_staff(auth.uid())) with check (private.is_resource_staff(auth.uid()));

-- Context links: no public read policy at all in R1.1. §35 explicitly says
-- "do not modify the existing modules to display these links in R1.1" — the
-- FHIP dashboard/score/etc pages do not query this table yet, so there is
-- no legitimate reason for `anon`/ordinary `authenticated` to read it
-- before that integration is built. Staff-only for now; a public policy can
-- be added in the phase that actually wires it into the app.
create policy "staff read context links" on resource_context_links for select using (private.is_resource_staff(auth.uid()));
create policy "staff manage context links" on resource_context_links for all
  using (private.can_manage_resources(auth.uid())) with check (private.can_manage_resources(auth.uid()));

-- Versions/workflow history/audit log: no public or blanket-authenticated
-- access whatsoever (§50 explicitly lists these as never-expose). Authors
-- may see the workflow history of their own posts (useful feedback: why was
-- my draft sent back); full history/audit access is staff/manager-only.
create policy "staff read post versions" on resource_post_versions for select using (private.is_resource_staff(auth.uid()));
create policy "staff insert post versions" on resource_post_versions for insert with check (private.is_resource_staff(auth.uid()));

create policy "authors read own post workflow history" on resource_workflow_history for select
  using (private.is_resource_staff(auth.uid()) or exists (
    select 1 from resource_posts p where p.id = post_id and p.created_by = auth.uid()
  ));
-- No INSERT policy for workflow history at all — every row is written by
-- the SECURITY DEFINER transition RPC (§13), which bypasses RLS by design
-- (that is the entire point of routing status changes through one audited
-- function rather than direct table writes).

create policy "managers read audit log" on resource_audit_log for select using (private.can_manage_resources(auth.uid()));
-- No INSERT policy — audit rows are written exclusively by the transition
-- RPC and by service-role code paths (e.g. a future role-assignment admin
-- action), never directly by a client.

create policy "staff read settings" on resource_settings for select using (private.is_resource_staff(auth.uid()));
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
