-- FHIP Admin A0.2 Wave 1 (D-01 remediation): Recommendations "conditions"
-- CSV import integrity.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT (A0.1 Admin Baseline Certification, finding D-01, P1)
-- ---------------------------------------------------------------------------
-- app/api/admin/recommendations/upload/route.ts's fileType=conditions path
-- did:
--   1. DELETE FROM action_recommendation_conditions WHERE recommendation_code
--      IN (codes-present-in-the-uploaded-file)
--   2. INSERT the replacement rows parsed from the file
-- as two independent Supabase/PostgREST calls, each its own implicit
-- transaction. If the DELETE committed and the INSERT then failed for any
-- reason (a malformed row, a network blip, a Supabase timeout), every
-- recommendation code named in the file was left with ZERO conditions,
-- silently — no rollback, no error surfaced beyond a generic upload-failed
-- message, no way to tell which codes were affected. A recommendation with
-- zero conditions is treated by the matcher (lib/engines/recommendations/
-- matcher.ts's recommendationMatches(): "if (conditions.length === 0) return
-- true") as UNCONDITIONALLY MATCHING every user — the exact opposite of
-- "this recommendation never fires", a live-user-facing correctness defect,
-- not just a data-integrity one.
--
-- ---------------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------------
-- All delete+insert work for a conditions-CSV upload now happens inside this
-- ONE database function, called ONCE per upload from the admin API route
-- (never a sequence of independent client-side requests). A PL/pgSQL
-- function body runs inside the same implicit transaction as the statement
-- that invoked it (a single `select admin_import_recommendation_conditions(...)`
-- call from PostgREST): if ANY `raise exception` fires, or any INSERT/DELETE
-- hits a real constraint violation, partway through the loop below,
-- PostgreSQL aborts that whole transaction and rolls back every change the
-- function made in this invocation — including recommendation codes that
-- had already been fully processed earlier in the same call. There is no
-- explicit BEGIN/COMMIT here because none is needed or wanted: the natural
-- one-statement-one-transaction semantics of a single RPC call already give
-- exactly the "whole file, all or nothing" guarantee the spec requires.
--
-- INPUT CONTRACT: a single jsonb argument shaped
--   { "groups": [
--       { "recommendation_code": "REC_001", "clear": false,
--         "conditions": [ { "condition_group": 1, "field_name": "...",
--           "operator": "equals", "comparison_value": "...",
--           "comparison_value_2": null, "data_type": "text",
--           "logical_operator": "AND", "evaluation_order": 1,
--           "is_active": true }, ... ] },
--       ... ] }
-- Fixed SQL only — every column written comes from a fixed, named jsonb key
-- read via `->>`, never from dynamic/derived SQL text. No table or column
-- name is ever taken from the payload, so arbitrary table/column selection
-- is structurally impossible regardless of what a caller supplies.
--
-- A recommendation_code group with clear=true and zero conditions is the
-- ONLY way to legitimately leave a recommendation with no conditions — see
-- lib/services/recommendationsConditionsImport.ts's module header for the
-- full canonical-replacement-semantics writeup (spec section 6). A code
-- simply absent from the payload is left completely untouched: this
-- function never sees it, so it can never delete it.
--
-- TRANSACTIONAL GUARANTEE: every recommendation_code named in the payload is
-- rechecked against action_recommendation_master (defence in depth — the
-- calling API route already validated this against a fresh read, but this
-- function is the actual authority and must not trust a stale or forged
-- caller). Any unknown code, any structural problem (bad JSON shape,
-- clear+conditions both supplied, more than the safety-limit number of
-- groups/conditions), or any real database constraint violation raised
-- while processing ANY group aborts the ENTIRE call — every
-- already-applied delete/insert in this invocation is rolled back with it.
-- Nothing is ever left with zero conditions because of a failure elsewhere
-- in the same upload.
--
-- SECURITY BOUNDARY: this function does not check admin_users itself — that
-- boundary already exists and is preserved unchanged at the application
-- layer (requireAdmin() in lib/services/adminAuth.ts, called by the upload
-- route before it ever reaches this function). What this function adds is a
-- database-layer backstop that makes the admin-only boundary meaningful even
-- if requireAdmin() were ever bypassed or misconfigured: EXECUTE is revoked
-- from public, anon AND authenticated, and granted only to service_role.
-- The upload route is the only code path in this repository that holds a
-- service-role client (lib/supabase/admin.ts's createAdminClient()), so no
-- ordinary authenticated user — Admin or not — can invoke this function
-- directly via PostgREST/supabase-js; only server code that has already
-- passed requireAdmin() ever reaches it. search_path is pinned to prevent
-- search-path hijacking of a SECURITY DEFINER function.
--
-- Forward-only, idempotent (CREATE OR REPLACE FUNCTION; REVOKE/GRANT are
-- naturally idempotent). Touches no existing table, column, or row.

begin;

create or replace function admin_import_recommendation_conditions(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_groups jsonb;
  v_group jsonb;
  v_conditions jsonb;
  v_code text;
  v_clear boolean;
  v_missing text[];
  v_codes text[] := '{}';
  v_deleted_count int;
  v_inserted_count int;
  v_total_deleted int := 0;
  v_total_inserted int := 0;
  v_group_count int;
  v_total_conditions_requested numeric;
  v_max_groups constant int := 2000;
  v_max_conditions_per_group constant int := 200;
  v_max_total_conditions constant int := 20000;
begin
  if p_import is null or jsonb_typeof(p_import) <> 'object' then
    raise exception 'admin_import_recommendation_conditions: payload must be a JSON object' using errcode = '22023';
  end if;

  v_groups := p_import->'groups';
  if v_groups is null or jsonb_typeof(v_groups) <> 'array' then
    raise exception 'admin_import_recommendation_conditions: payload.groups must be a JSON array' using errcode = '22023';
  end if;

  v_group_count := jsonb_array_length(v_groups);
  if v_group_count = 0 then
    -- A validated-but-empty group list (e.g. the API route already reduced
    -- an all-invalid or genuinely empty upload to nothing) is a legitimate
    -- zero-mutation success, never an error and never a full-table clear.
    return jsonb_build_object('recommendationsAffected', 0, 'conditionsInserted', 0, 'conditionsReplaced', 0, 'codes', '[]'::jsonb);
  end if;

  if v_group_count > v_max_groups then
    raise exception 'admin_import_recommendation_conditions: % recommendation codes exceeds the maximum of % per import', v_group_count, v_max_groups
      using errcode = '22023';
  end if;

  select coalesce(sum(jsonb_array_length(coalesce(elem->'conditions', '[]'::jsonb))), 0)
    into v_total_conditions_requested
    from jsonb_array_elements(v_groups) as elem;
  if v_total_conditions_requested > v_max_total_conditions then
    raise exception 'admin_import_recommendation_conditions: % total condition rows exceeds the maximum of % per import', v_total_conditions_requested, v_max_total_conditions
      using errcode = '22023';
  end if;

  -- Defence-in-depth existence recheck for EVERY referenced code, BEFORE any
  -- delete runs for any of them. The calling route already validated this
  -- against a fresh read; this is the authoritative check that protects the
  -- table even if that caller were ever wrong, stale, or bypassed.
  select array_agg(distinct elem->>'recommendation_code')
    into v_missing
    from jsonb_array_elements(v_groups) as elem
    where elem->>'recommendation_code' is null
       or btrim(elem->>'recommendation_code') = ''
       or not exists (
         select 1 from action_recommendation_master m
         where m.recommendation_code = elem->>'recommendation_code'
       );
  if v_missing is not null and array_length(v_missing, 1) > 0 then
    raise exception 'admin_import_recommendation_conditions: unknown or blank recommendation_code(s): %', array_to_string(v_missing, ', ')
      using errcode = 'P0002';
  end if;

  if (select count(*) from jsonb_array_elements(v_groups) e) <>
     (select count(distinct e->>'recommendation_code') from jsonb_array_elements(v_groups) e) then
    raise exception 'admin_import_recommendation_conditions: duplicate recommendation_code across groups in the same payload' using errcode = '22023';
  end if;

  for v_group in select elem from jsonb_array_elements(v_groups) as elem
  loop
    v_code := v_group->>'recommendation_code';
    v_clear := coalesce((v_group->>'clear')::boolean, false);
    v_conditions := coalesce(v_group->'conditions', '[]'::jsonb);

    if jsonb_typeof(v_conditions) <> 'array' then
      raise exception 'admin_import_recommendation_conditions: conditions for % must be a JSON array', v_code using errcode = '22023';
    end if;

    if v_clear and jsonb_array_length(v_conditions) > 0 then
      raise exception 'admin_import_recommendation_conditions: % is marked clear=true but also supplies % condition row(s) — ambiguous', v_code, jsonb_array_length(v_conditions)
        using errcode = '22023';
    end if;

    if not v_clear and jsonb_array_length(v_conditions) = 0 then
      raise exception 'admin_import_recommendation_conditions: % supplies zero conditions without an explicit clear=true — refusing to guess', v_code
        using errcode = '22023';
    end if;

    if jsonb_array_length(v_conditions) > v_max_conditions_per_group then
      raise exception 'admin_import_recommendation_conditions: % supplies % conditions, exceeding the maximum of % per recommendation', v_code, jsonb_array_length(v_conditions), v_max_conditions_per_group
        using errcode = '22023';
    end if;

    delete from action_recommendation_conditions where recommendation_code = v_code;
    get diagnostics v_deleted_count = row_count;
    v_total_deleted := v_total_deleted + v_deleted_count;

    v_inserted_count := 0;
    if jsonb_array_length(v_conditions) > 0 then
      insert into action_recommendation_conditions (
        recommendation_code, condition_group, field_name, operator,
        comparison_value, comparison_value_2, data_type, logical_operator,
        evaluation_order, is_active
      )
      select
        v_code,
        coalesce((c->>'condition_group')::int, 1),
        c->>'field_name',
        coalesce(c->>'operator', 'equals'),
        c->>'comparison_value',
        c->>'comparison_value_2',
        coalesce(c->>'data_type', 'text'),
        coalesce(c->>'logical_operator', 'AND'),
        coalesce((c->>'evaluation_order')::int, 1),
        coalesce((c->>'is_active')::boolean, true)
      from jsonb_array_elements(v_conditions) as c;
      get diagnostics v_inserted_count = row_count;
    end if;
    v_total_inserted := v_total_inserted + v_inserted_count;

    v_codes := v_codes || v_code;
  end loop;

  return jsonb_build_object(
    'recommendationsAffected', v_group_count,
    'conditionsInserted', v_total_inserted,
    'conditionsReplaced', v_total_deleted,
    'codes', to_jsonb(v_codes)
  );
end;
$$;

comment on function admin_import_recommendation_conditions(jsonb) is
  'A0.2 Wave 1 (D-01 fix): atomic, whole-payload replace of action_recommendation_conditions for the recommendation_codes named in the payload only. Codes absent from the payload are never touched. Called exclusively from the Admin recommendations conditions-CSV upload route using the service-role client, after that route''s own pre-validation. See migration 0107 header for full contract.';

revoke all on function admin_import_recommendation_conditions(jsonb) from public;
revoke all on function admin_import_recommendation_conditions(jsonb) from anon;
revoke all on function admin_import_recommendation_conditions(jsonb) from authenticated;
grant execute on function admin_import_recommendation_conditions(jsonb) to service_role;

commit;
