-- Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency.
-- Round 2 (Product Owner remediation dispatch): atomic Benchmark source
-- lifecycle mutation + mandatory audit evidence.
--
-- SUPERSEDES this migration's own Round 1 content (never applied anywhere —
-- confirmed by a fresh exhaustive collision scan before this rewrite; see
-- the Wave 4 report §5.2/§8 for the scan evidence). Round 1 committed the
-- `benchmark_sources` status mutation, then attempted a separate audit
-- INSERT afterward, logged-and-swallowed any insert failure, and still
-- returned business success — an approval/suspension/reinstatement could
-- therefore "succeed" with zero audit evidence if the second statement
-- failed for any reason. The Product Owner correctly rejected this as
-- unacceptable for a mandatory high-risk audit action (spec §9 priorities
-- 2/4) and required one authoritative transaction instead.
--
-- Round 1 also (a) widened benchmark_update_runs.approval_status's CHECK
-- constraint to accept the full source-status vocabulary and (b) planned to
-- store the resulting status in `previous_version`/`new_version` — both
-- rejected by the Product Owner as semantic overload: those two columns
-- canonically mean a *dataset's version string* (see
-- datasets/[id]/activate's own use: `new_version: data.version`), not a
-- source's lifecycle status, and approval_status's three-value vocabulary
-- ('pending'/'approved'/'rejected') canonically means "did this governance
-- action's *validation* succeed", not "what status did the row end up in".
-- This rewrite does NOT widen approval_status at all — it is left exactly
-- as originally defined in migration 0011, so the existing
-- dataset-activation write path's invariants are provably unweakened (no
-- column touched, no constraint touched, no existing row's meaning
-- reinterpreted). Instead, three new, purpose-specific, nullable columns
-- are added, so a source-lifecycle event and a dataset-import event can
-- share one physical audit table (Standard §10's "prefer integrating into
-- an existing structure"; this Wave's own §9: "do not duplicate an
-- existing complete event") without corrupting either event type's
-- meaning:
--
--   event_type        'DATASET_IMPORT' (legacy rows, and this migration's
--                      own backfill of every existing row) or
--                      'SOURCE_LIFECYCLE' (new, written only by the RPC
--                      below).
--   previous_status    the benchmark_sources.status value BEFORE a
--                      SOURCE_LIFECYCLE transition. NULL for
--                      DATASET_IMPORT rows — a dataset import has no
--                      equivalent "previous status" concept of its own
--                      (its own state is `data_status` on
--                      benchmark_datasets, not modelled here).
--   new_status         the resulting benchmark_sources.status value AFTER
--                      a SOURCE_LIFECYCLE transition. NULL for
--                      DATASET_IMPORT rows.
--
-- `approval_status` keeps its exact pre-existing meaning for BOTH event
-- types: "did this governance action complete successfully (`approved`) or
-- fail validation (`rejected`)" — a source-lifecycle transition that
-- reaches the INSERT below has, by construction, already passed every
-- authorization/validation check the function performs, so it is always
-- recorded as `approved` (there is no "rejected" outcome for a source
-- transition that gets this far — an invalid status or an unauthorized
-- caller is refused before any row is touched, exactly like the dataset
-- path's own `rejected` row is only ever written for a *validation*
-- failure, not an authorization failure).
--
-- ============================================================================
-- 1. Additive columns — zero risk to existing rows or existing invariants
-- ============================================================================
alter table benchmark_update_runs
  add column if not exists event_type text,
  add column if not exists previous_status text,
  add column if not exists new_status text;

-- Backfill every pre-existing row (all of them are dataset-import events —
-- this table has never had a source_id populated by any INSERT in this
-- codebase before this migration, confirmed by direct code search) so
-- `event_type` is never null for old data, without guessing at a
-- previous/new status that was never recorded for those rows.
update benchmark_update_runs set event_type = 'DATASET_IMPORT' where event_type is null;

alter table benchmark_update_runs
  add constraint benchmark_update_runs_event_type_check
  check (event_type in ('DATASET_IMPORT', 'SOURCE_LIFECYCLE'));

comment on column benchmark_update_runs.event_type is
  'Admin A0.2 Wave 4. Distinguishes a dataset-import/activation event (legacy meaning of this table) from a benchmark_sources lifecycle-transition event (new). Never null.';
comment on column benchmark_update_runs.previous_status is
  'Admin A0.2 Wave 4. benchmark_sources.status immediately before a SOURCE_LIFECYCLE transition. Always null for DATASET_IMPORT rows — a dataset import has no equivalent concept.';
comment on column benchmark_update_runs.new_status is
  'Admin A0.2 Wave 4. benchmark_sources.status immediately after a SOURCE_LIFECYCLE transition. Always null for DATASET_IMPORT rows.';

-- ============================================================================
-- 2. Atomic lifecycle-transition RPC — Pattern A (caller-context)
-- ============================================================================
-- Approved pattern per the Product Owner's ruling: a single SECURITY
-- DEFINER function performs (in this exact order, inside ONE transaction):
-- row lock -> internal authorization -> transition validation -> idempotent
-- no-change short-circuit -> the benchmark_sources UPDATE -> the
-- benchmark_update_runs audit INSERT -> return the committed row. Because
-- this is one PL/pgSQL function body with no internal exception handler,
-- ANY unhandled error at any step (including the audit INSERT) aborts the
-- ENTIRE function invocation and Postgres rolls back every statement it
-- already ran — there is no code path that can commit the status change
-- without also committing its audit row, and no code path that inserts an
-- audit row without a real, corresponding status change already having
-- happened in the same transaction. This mirrors the exact structure and
-- security posture already proven in this codebase by
-- public.transition_resource_post_status (migration 0049) and
-- public.admin_reorder_related_content (migration 0116) — same pinned
-- empty search_path, same auth.uid()-sourced actor, same internal
-- capability recheck, same fail-closed-on-null-actor discipline, same
-- REVOKE PUBLIC/anon + GRANT authenticated,service_role posture.
create or replace function public.admin_transition_benchmark_source(
  p_source_id uuid,
  p_new_status text
)
returns benchmark_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_source public.benchmark_sources;
  v_previous_status text;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select exists(select 1 from public.admin_users where user_id = v_actor) into v_is_admin;
  if not v_is_admin then
    raise exception 'Admin access required';
  end if;

  if p_new_status is null or p_new_status not in ('draft', 'under_review', 'approved', 'active', 'superseded', 'suspended', 'archived') then
    raise exception 'Invalid target status: %', p_new_status;
  end if;

  -- Row lock: FOR UPDATE prevents a concurrent transition on the same
  -- source from reading a stale "before" status, matching the same
  -- concurrency discipline transition_resource_post_status already uses.
  select * into v_source from public.benchmark_sources where id = p_source_id for update;
  if not found then
    raise exception 'Benchmark source % not found', p_source_id;
  end if;

  v_previous_status := v_source.status;

  -- Idempotent no-op: resubmitting the SAME status is a valid, successful
  -- no-change request (spec §14/PO4-2's own "an idempotent no-change
  -- request produces no false transition event") — no row is written, no
  -- audit event is created, and the current row is returned unchanged so
  -- the caller still gets a normal successful response.
  if v_previous_status = p_new_status then
    return v_source;
  end if;

  update public.benchmark_sources set
    status = p_new_status,
    approved_by = case when p_new_status = 'approved' then v_actor else approved_by end,
    approved_at = case when p_new_status = 'approved' then now() else approved_at end,
    updated_at = now()
  where id = p_source_id
  returning * into v_source;

  insert into public.benchmark_update_runs (
    source_id, dataset_id, approval_status, event_type,
    previous_status, new_status, audit_user
  ) values (
    p_source_id, null, 'approved', 'SOURCE_LIFECYCLE',
    v_previous_status, p_new_status, v_actor
  );

  return v_source;
end;
$$;

revoke all on function public.admin_transition_benchmark_source(uuid, text) from public;
revoke all on function public.admin_transition_benchmark_source(uuid, text) from anon;
grant execute on function public.admin_transition_benchmark_source(uuid, text) to authenticated, service_role;

comment on function public.admin_transition_benchmark_source is
  'Admin A0.2 Wave 4 — the only sanctioned path for changing benchmark_sources.status. Performs its own internal Super Admin (admin_users) authorization check via auth.uid() (Pattern A, mirroring transition_resource_post_status and admin_reorder_related_content), then atomically updates the row and records a benchmark_update_runs audit event (event_type=SOURCE_LIFECYCLE) in the SAME transaction — an audit-insert failure rolls back the status change, and a successful call always produces exactly one status change and exactly one audit event, never one without the other.';

-- ============================================================================
-- 3. Immutability — Gate G7 ("do not claim immutability merely because no
--    current UI exposes UPDATE or DELETE")
-- ============================================================================
-- Before this migration, benchmark_update_runs' only immutability evidence
-- was structural-by-absence: RLS enabled with zero policies for
-- `authenticated`/`anon`, and no application route ever calling UPDATE or
-- DELETE on it. That is a real control, but it is a convention, not a hard
-- guarantee — a future service-role script (a maintenance job, a manual
-- fixup) could UPDATE or DELETE a row and nothing in the database itself
-- would refuse it. This closes that gap the same way migration 0115
-- already did for `ai_config_audit` (`ai_config_audit_immutable()`): an
-- unconditional BEFORE UPDATE OR DELETE trigger that raises, regardless of
-- caller — including service-role and the table owner — so immutability is
-- enforced by the table itself, not by a convention nobody has broken yet.
-- INSERT is completely unaffected (this trigger only fires for UPDATE/
-- DELETE), so the RPC above and the existing dataset-activate/retire
-- INSERT paths are unchanged.
--
-- This same hardening was considered for `resource_audit_log` and
-- `resource_workflow_history` (also named by Gate G7) and DELIBERATELY NOT
-- applied here: a direct code search found several existing, working
-- service-role maintenance/rollback scripts
-- (scripts/resources/p0-content/r17d-cleanup-duplicate-run.ts,
-- r17d-stale-approval-regression.ts, rollback-safety-proof.ts,
-- rollback-r0a.ts) that legitimately call `.delete()` on those two tables
-- as part of certification-fixture cleanup and rollback tooling. Adding an
-- unconditional trigger there would silently break that existing,
-- already-certified tooling — a real defensible reason to stop rather than
-- unilaterally tighten a Resources-domain table this Wave was not asked to
-- touch. Recorded as a named residual for Product Owner decision (retire
-- those scripts first, or accept a narrower immutability contract for
-- Resources' own audit tables) rather than silently left unaddressed.
create or replace function public.benchmark_update_runs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'benchmark_update_runs is append-only: % is not permitted', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists trg_benchmark_update_runs_no_update on benchmark_update_runs;
create trigger trg_benchmark_update_runs_no_update
  before update or delete on benchmark_update_runs
  for each row execute function public.benchmark_update_runs_immutable();

comment on function public.benchmark_update_runs_immutable is
  'Admin A0.2 Wave 4, Gate G7 — enforces benchmark_update_runs append-only posture at the database level (mirrors ai_config_audit_immutable(), migration 0115), independent of RLS/grants and independent of caller (including service-role).';
