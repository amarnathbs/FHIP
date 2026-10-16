-- 0272 -- Resources bulk upload (articles and money updates): staging tables, capability helper, access rules.
--
-- Part A of three. Safe to run twice. Adds NEW objects only: two staging tables, one helper function and their
-- access rules. It does not change resource_posts or any existing table, constraint, policy or function.
--
-- Staging tables hold a parsed upload between preview and apply. The browser never writes them: only the
-- server does, after checking the capability. A signed-in person can READ only their own runs (resource
-- administrators and super administrators can read all runs for the history screen).
--
-- Capability resources.content.bulk_import is held by: super administrator, resource administrator, editor.
-- It is deliberately NOT held by author, compliance reviewer, publisher or analyst.

create table if not exists public.resource_content_import_runs (
  id uuid primary key default gen_random_uuid(),
  content_type text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  file_name text not null,
  file_sha256 text not null,
  template_version text,
  status text not null default 'ready',
  row_count integer not null default 0,
  valid_count integer not null default 0,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  normalized_digest text,
  file_issues jsonb not null default '[]'::jsonb,
  created_post_count integer not null default 0,
  failure_code text,
  failure_message_safe text,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  applied_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint chk_rcir_content_type check (content_type in ('article', 'money_update')),
  constraint chk_rcir_status check (status in ('ready', 'has_errors', 'applied', 'failed', 'stale', 'rejected', 'expired')),
  constraint chk_rcir_sha256 check (length(file_sha256) = 64 and file_sha256 = lower(file_sha256)),
  constraint chk_rcir_counts check (row_count >= 0 and valid_count >= 0 and warning_count >= 0 and error_count >= 0 and created_post_count >= 0),
  constraint chk_rcir_file_issues_array check (jsonb_typeof(file_issues) = 'array')
);

-- The same successful file can never be applied twice for the same content type (a hard database guarantee).
create unique index if not exists uq_rcir_applied_file
  on public.resource_content_import_runs (content_type, file_sha256)
  where status = 'applied';
create index if not exists idx_rcir_uploaded_by_created
  on public.resource_content_import_runs (uploaded_by, created_at desc);
create index if not exists idx_rcir_status_expires
  on public.resource_content_import_runs (status, expires_at);

create table if not exists public.resource_content_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references public.resource_content_import_runs(id) on delete cascade,
  row_number integer not null,
  external_id text,
  slug text,
  title text,
  display jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  validation_warnings jsonb not null default '[]'::jsonb,
  planned_post_id uuid,
  result_post_id uuid references public.resource_posts(id) on delete set null,
  result_status text not null default 'staged',
  constraint chk_rcirow_result_status check (result_status in ('staged', 'created')),
  constraint chk_rcirow_row_number check (row_number >= 1),
  constraint chk_rcirow_errors_array check (jsonb_typeof(validation_errors) = 'array'),
  constraint chk_rcirow_warnings_array check (jsonb_typeof(validation_warnings) = 'array'),
  constraint uq_rcirow_run_row unique (import_run_id, row_number)
);

create index if not exists idx_rcirow_result_post
  on public.resource_content_import_rows (result_post_id)
  where result_post_id is not null;

-- The capability. One named predicate: SQL is the source of truth, the TypeScript helper mirrors it.
create or replace function private.can_bulk_import_resource_content(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.is_fhip_super_admin(p_user_id)
      or private.has_resource_role(p_user_id, 'resource_admin')
      or private.has_resource_role(p_user_id, 'editor');
$fn$;

revoke all on function private.can_bulk_import_resource_content(uuid) from public, anon;
grant execute on function private.can_bulk_import_resource_content(uuid) to authenticated, service_role;

alter table public.resource_content_import_runs enable row level security;
alter table public.resource_content_import_rows enable row level security;

drop policy if exists rcir_select_own_or_manager on public.resource_content_import_runs;
create policy rcir_select_own_or_manager on public.resource_content_import_runs
  for select to authenticated
  using (
    (uploaded_by = auth.uid() and private.can_bulk_import_resource_content(auth.uid()))
    or private.can_manage_resources(auth.uid())
  );

drop policy if exists rcirow_select_via_run on public.resource_content_import_rows;
create policy rcirow_select_via_run on public.resource_content_import_rows
  for select to authenticated
  using (exists (select 1 from public.resource_content_import_runs r where r.id = import_run_id));

-- No write grant for any API role: only the server (service role) writes staging data.
revoke all on table public.resource_content_import_runs from public, anon, authenticated;
revoke all on table public.resource_content_import_rows from public, anon, authenticated;
grant select on public.resource_content_import_runs to authenticated;
grant select on public.resource_content_import_rows to authenticated;
grant all on public.resource_content_import_runs to service_role;
grant all on public.resource_content_import_rows to service_role;

comment on table public.resource_content_import_runs is 'Bulk upload runs for Resources articles and money updates. One row per uploaded file. The raw file is never stored, only its SHA-256 and the normalised rows. Written by the server only.';
comment on table public.resource_content_import_rows is 'Normalised rows of one bulk upload run, kept between preview and apply. The full payload is cleared when the run is applied. Written by the server only.';
