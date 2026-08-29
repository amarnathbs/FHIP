-- FHIP Admin A0.2 Wave 1B: single-recommendation create/update atomicity,
-- plus a database-level backstop for the "zero conditions" invariant.
--
-- ---------------------------------------------------------------------------
-- NAMED INVARIANT (read this first — referenced from the matcher, the
-- Wave 1 migration, and the Wave 1B certification report):
--
--   A recommendation record with zero rows in action_recommendation_conditions
--   MATCHES EVERY USER UNCONDITIONALLY.
--
--   lib/engines/recommendations/matcher.ts's recommendationMatches():
--     "if (conditions.length === 0) return true;"
--   This is not a bug in the matcher — an empty condition list legitimately
--   means "no gate, always applies" by design. The danger is entirely on the
--   WRITE side: any code path that can leave an active recommendation with
--   zero conditions BY ACCIDENT (a failed partial write, an upload that
--   silently truncated, an edit that removed every condition without
--   meaning to) turns "never fires" into "fires for everyone" with no
--   visible signal. This has already bitten this codebase once — see
--   lib/services/recommendationsData.ts's fetchAllMasterRows() comment on
--   the pagination truncation risk this exact same danger created.
--
--   Before this migration, nothing in the schema expressly distinguished
--   "zero conditions on purpose" from "zero conditions by accident" — no
--   "always show" flag existed anywhere in this codebase (checked: no such
--   column, no such recommendation type, only this one incidental matcher
--   fallback). This migration makes the distinction explicit and enforces
--   it at the only layer that can't be bypassed by a future bug: the
--   database schema itself.
--
-- ---------------------------------------------------------------------------
-- PART A — the explicit flag
-- ---------------------------------------------------------------------------
-- `matches_unconditionally` must be TRUE for an ACTIVE recommendation to
-- legitimately have zero conditions. Defaults FALSE — every existing row
-- keeps today's behaviour unchanged (this column addition alone changes no
-- runtime matching behaviour; the matcher does not read this column at all,
-- it only gates future ADMIN WRITES via Part B's triggers below).

alter table action_recommendation_master
  add column if not exists matches_unconditionally boolean not null default false;

comment on column action_recommendation_master.matches_unconditionally is
  'Must be true for this recommendation to be saved as is_active=true with zero rows in action_recommendation_conditions. Enforced by trg_recommendation_conditions_nonzero and trg_recommendation_master_nonzero_conditions (this migration). Default false preserves every pre-existing row''s behaviour unchanged — this column does not affect matching at runtime, only what future admin writes are allowed to leave in the table.';

-- ---------------------------------------------------------------------------
-- PART B — the enforcement (deferred constraint triggers)
-- ---------------------------------------------------------------------------
-- Two triggers are needed because there are two different ways to arrive at
-- "active + zero conditions":
--   B1. Conditions get deleted out from under an already-active,
--       non-unconditional recommendation (the CSV upload RPC from migration
--       0107, or this migration's own admin_upsert_recommendation_atomic).
--   B2. A recommendation is (re)activated, or its matches_unconditionally
--       flag is turned off, while it already has zero conditions (the
--       master CSV upload's upsert, or a single-record edit that flips
--       is_active without touching conditions).
--
-- Both are CONSTRAINT TRIGGERS, DEFERRABLE INITIALLY DEFERRED: the check
-- only runs once, at COMMIT, after every statement in the transaction has
-- run. This is essential, not optional — a plain (non-deferred) AFTER
-- DELETE trigger would fire the instant the DELETE half of a normal
-- delete-then-insert replace ran, see zero rows, and reject every ordinary
-- replacement, not just the genuinely dangerous ones. Deferring to commit
-- time means a whole-transaction replace (delete N, insert M>0) is judged
-- only by its FINAL state, exactly like the atomicity guarantee migrations
-- 0107 and 0109 already give the rest of the operation.
--
-- Postgres constraint triggers must be FOR EACH ROW (statement-level
-- constraint triggers are not supported), so each affected row schedules
-- its own deferred check; redundant checks for the same recommendation_code
-- are harmless (small, idempotent SELECT COUNT).

create or replace function trg_enforce_conditions_delete_nonzero() returns trigger as $$
declare
  v_is_active boolean;
  v_matches_unconditionally boolean;
  v_remaining int;
begin
  select is_active, matches_unconditionally into v_is_active, v_matches_unconditionally
    from action_recommendation_master where recommendation_code = old.recommendation_code;

  if v_is_active is null then
    -- Master row itself is gone (ON DELETE CASCADE) — nothing left to protect.
    return null;
  end if;

  if v_is_active and not v_matches_unconditionally then
    select count(*) into v_remaining from action_recommendation_conditions where recommendation_code = old.recommendation_code;
    if v_remaining = 0 then
      raise exception 'recommendation "%" is active with zero conditions and matches_unconditionally=false — this would make it match every user unconditionally. Set matches_unconditionally=true if that is genuinely intended, add at least one condition, or leave it inactive.', old.recommendation_code
        using errcode = '23514', hint = 'See migration 0109''s header for the full write-up of this invariant.';
    end if;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_recommendation_conditions_nonzero on action_recommendation_conditions;
create constraint trigger trg_recommendation_conditions_nonzero
  after delete on action_recommendation_conditions
  deferrable initially deferred
  for each row execute function trg_enforce_conditions_delete_nonzero();

create or replace function trg_enforce_master_nonzero_conditions() returns trigger as $$
declare
  v_remaining int;
begin
  if new.is_active and not new.matches_unconditionally then
    select count(*) into v_remaining from action_recommendation_conditions where recommendation_code = new.recommendation_code;
    if v_remaining = 0 then
      raise exception 'recommendation "%" is active with zero conditions and matches_unconditionally=false — this would make it match every user unconditionally. Set matches_unconditionally=true if that is genuinely intended, add at least one condition, or leave it inactive.', new.recommendation_code
        using errcode = '23514', hint = 'See migration 0109''s header for the full write-up of this invariant.';
    end if;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_recommendation_master_nonzero_conditions on action_recommendation_master;
create constraint trigger trg_recommendation_master_nonzero_conditions
  after insert or update of is_active, matches_unconditionally, recommendation_code on action_recommendation_master
  deferrable initially deferred
  for each row execute function trg_enforce_master_nonzero_conditions();

-- NOTE (disclosed, not fixed here — out of Wave 1B's scope): these triggers
-- fire only on FUTURE writes. They do not retroactively scan or change any
-- pre-existing row — CONSTRAINT TRIGGERS never validate existing data on
-- creation, unlike `ADD CONSTRAINT ... CHECK`. Whether any currently-active
-- recommendation already has zero conditions today (and would therefore
-- need matches_unconditionally=true set the next time it is touched by
-- either RPC) is reported as a read-only finding in the Wave 1B DEV
-- pre-check, not silently corrected by this migration.

-- ---------------------------------------------------------------------------
-- PART C — admin_upsert_recommendation_atomic(): the actual Wave 1B fix
-- ---------------------------------------------------------------------------
-- THE DEFECT (found while implementing Wave 1B, matching the CSV path's
-- D-01 defect class exactly): both app/api/admin/recommendations/route.ts's
-- POST (create) and app/api/admin/recommendations/[id]/route.ts's PATCH
-- (edit) wrote the recommendation_master row and its conditions as two (or
-- three) separate Supabase/PostgREST requests with no shared transaction:
--   POST:  INSERT master, THEN INSERT conditions (if conditions insert
--          fails, a newly created recommendation is left active/inactive
--          per whatever was requested, with zero conditions, and the caller
--          only sees a generic mid-way error).
--   PATCH: UPDATE master, THEN DELETE existing conditions for that code,
--          THEN INSERT the replacement conditions (identical mechanism and
--          risk to migration 0107's original D-01 — if the final INSERT
--          fails, the DELETE has already committed, so the recommendation
--          is left with zero conditions, silently).
--
-- THE FIX: exactly migration 0107's pattern, generalized to one record
-- instead of many, in ONE new function called ONCE per create/update. A
-- single RPC call is one implicit transaction; any raised exception or
-- constraint violation (including the deferred triggers above, which fire
-- at commit) rolls back the ENTIRE call — the master row change AND the
-- conditions replace together, never one without the other.
--
-- WHY A SEPARATE FUNCTION, NOT A GENERALIZATION OF
-- admin_import_recommendation_conditions (spec-mandated design question):
-- The CSV upload RPC (migration 0107) is deliberately narrow — it takes and
-- writes ONLY the fixed conditions-row columns, for a BATCH of
-- recommendation_codes that MUST already exist. This function's job is
-- fundamentally different in shape: ONE recommendation, arbitrary
-- (partial-update) MASTER-table fields, optional create-vs-update braching,
-- and an "insert new master row" path the CSV function has no reason to
-- ever support. Folding master-column writes into the CSV function would
-- force it to either (a) accept dynamic column names from the payload —
-- exactly the "arbitrary table/column selection" migration 0107 was built
-- to make structurally impossible — or (b) carry a second, unrelated
-- responsibility that every future change to the CSV path would have to
-- reason about even though CSV conditions uploads never touch master
-- fields. Both are worse than one additional, equally narrow function.
-- What IS genuinely shared, not duplicated, between the two functions:
--   - The conditions-row INSERT...SELECT FROM jsonb_array_elements shape is
--     kept structurally identical in both (same columns, same coalesce
--     defaults) — see the comment above this function's own conditions
--     block.
--   - The "zero conditions requires explicit confirmation" rule and the
--     "active + zero conditions" invariant are enforced by the SAME two
--     database triggers (Part B) regardless of which function — or any
--     future one — touches these tables. This is a stronger guarantee than
--     sharing application code: a trigger cannot be forgotten by a caller.
--
-- INPUT CONTRACT:
--   p_id            uuid, NULL to create a new recommendation, otherwise the
--                    id of the existing recommendation to update.
--   p_master        jsonb object. On create: must include recommendation_code
--                    plus the master-table's required fields (mirrors the
--                    existing POST route's own required-field check, done in
--                    the API route, not here — this function additionally
--                    guards recommendation_code specifically since it is the
--                    join key conditions rely on). On update: a PARTIAL
--                    update — only keys present in the object are changed
--                    (`p_master ? 'key'`), matching the pre-existing PATCH
--                    route's spread-based partial-update semantics exactly,
--                    just now via a fixed, named column list instead of a
--                    dynamic spread (closing the same "no dynamic SQL"
--                    principle migration 0107 established). recommendation_code
--                    itself is never updatable through this function.
--   p_conditions    NULL = do not touch this recommendation's conditions at
--                    all (existing conditions, if any, are left exactly as
--                    they are). A jsonb array = replace, subject to the same
--                    explicit-clear rule as migration 0107.
--   p_clear_conditions boolean, default false. Required true for p_conditions
--                    to legitimately be an empty array — mirrors migration
--                    0107's per-group `clear` flag.
--
-- SECURITY BOUNDARY: identical posture to migration 0107 — SECURITY DEFINER,
-- pinned search_path, fixed SQL only (every column name is a literal in this
-- function's text, never derived from the payload), EXECUTE revoked from
-- public/anon/authenticated and granted only to service_role. The existing
-- requireAdmin() boundary at the API route layer is unchanged and is still
-- the only way an ordinary request reaches this function.

create or replace function admin_upsert_recommendation_atomic(
  p_id uuid,
  p_master jsonb,
  p_conditions jsonb default null,
  p_clear_conditions boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_id uuid;
  v_is_create boolean := p_id is null;
  v_deleted_count int := 0;
  v_inserted_count int := 0;
begin
  if p_master is null or jsonb_typeof(p_master) <> 'object' then
    raise exception 'admin_upsert_recommendation_atomic: p_master must be a JSON object' using errcode = '22023';
  end if;

  if v_is_create then
    v_code := btrim(coalesce(p_master->>'recommendation_code', ''));
    if v_code = '' then
      raise exception 'admin_upsert_recommendation_atomic: recommendation_code is required to create a recommendation' using errcode = '22023';
    end if;
    if exists (select 1 from action_recommendation_master where recommendation_code = v_code) then
      raise exception 'admin_upsert_recommendation_atomic: recommendation_code % already exists', v_code using errcode = '23505';
    end if;

    insert into action_recommendation_master (
      recommendation_code, trigger_type, forecast_category, forecast_status, pillar_code, score_band,
      sub_category, scenario_name, scenario_description, variance_result, severity, action_type,
      action_title_template, action_content_template, financial_impact_template, calculation_method_code,
      priority_score, country_code, currency_code, customer_segment, is_premium, is_active,
      matches_unconditionally, requires_ai, include_in_forecasting, include_in_monthly_report, admin_notes
    ) values (
      v_code,
      coalesce(p_master->>'trigger_type', 'forecast_variance'),
      p_master->>'forecast_category',
      p_master->>'forecast_status',
      p_master->>'pillar_code',
      p_master->>'score_band',
      p_master->>'sub_category',
      p_master->>'scenario_name',
      p_master->>'scenario_description',
      p_master->>'variance_result',
      coalesce(p_master->>'severity', 'medium'),
      p_master->>'action_type',
      p_master->>'action_title_template',
      p_master->>'action_content_template',
      p_master->>'financial_impact_template',
      p_master->>'calculation_method_code',
      coalesce((p_master->>'priority_score')::int, 0),
      p_master->>'country_code',
      p_master->>'currency_code',
      coalesce(p_master->>'customer_segment', 'base'),
      coalesce((p_master->>'is_premium')::boolean, false),
      coalesce((p_master->>'is_active')::boolean, false),
      coalesce((p_master->>'matches_unconditionally')::boolean, false),
      coalesce((p_master->>'requires_ai')::boolean, false),
      coalesce((p_master->>'include_in_forecasting')::boolean, true),
      coalesce((p_master->>'include_in_monthly_report')::boolean, false),
      p_master->>'admin_notes'
    )
    returning id into v_id;
  else
    v_id := p_id;
    select recommendation_code into v_code from action_recommendation_master where id = v_id;
    if v_code is null then
      raise exception 'admin_upsert_recommendation_atomic: recommendation id % does not exist', v_id using errcode = 'P0002';
    end if;

    update action_recommendation_master set
      trigger_type = case when p_master ? 'trigger_type' then p_master->>'trigger_type' else trigger_type end,
      forecast_category = case when p_master ? 'forecast_category' then p_master->>'forecast_category' else forecast_category end,
      forecast_status = case when p_master ? 'forecast_status' then p_master->>'forecast_status' else forecast_status end,
      pillar_code = case when p_master ? 'pillar_code' then p_master->>'pillar_code' else pillar_code end,
      score_band = case when p_master ? 'score_band' then p_master->>'score_band' else score_band end,
      sub_category = case when p_master ? 'sub_category' then p_master->>'sub_category' else sub_category end,
      scenario_name = case when p_master ? 'scenario_name' then p_master->>'scenario_name' else scenario_name end,
      scenario_description = case when p_master ? 'scenario_description' then p_master->>'scenario_description' else scenario_description end,
      variance_result = case when p_master ? 'variance_result' then p_master->>'variance_result' else variance_result end,
      severity = case when p_master ? 'severity' then p_master->>'severity' else severity end,
      action_type = case when p_master ? 'action_type' then p_master->>'action_type' else action_type end,
      action_title_template = case when p_master ? 'action_title_template' then p_master->>'action_title_template' else action_title_template end,
      action_content_template = case when p_master ? 'action_content_template' then p_master->>'action_content_template' else action_content_template end,
      financial_impact_template = case when p_master ? 'financial_impact_template' then p_master->>'financial_impact_template' else financial_impact_template end,
      calculation_method_code = case when p_master ? 'calculation_method_code' then p_master->>'calculation_method_code' else calculation_method_code end,
      priority_score = case when p_master ? 'priority_score' then (p_master->>'priority_score')::int else priority_score end,
      country_code = case when p_master ? 'country_code' then p_master->>'country_code' else country_code end,
      currency_code = case when p_master ? 'currency_code' then p_master->>'currency_code' else currency_code end,
      customer_segment = case when p_master ? 'customer_segment' then p_master->>'customer_segment' else customer_segment end,
      is_premium = case when p_master ? 'is_premium' then (p_master->>'is_premium')::boolean else is_premium end,
      is_active = case when p_master ? 'is_active' then (p_master->>'is_active')::boolean else is_active end,
      matches_unconditionally = case when p_master ? 'matches_unconditionally' then (p_master->>'matches_unconditionally')::boolean else matches_unconditionally end,
      requires_ai = case when p_master ? 'requires_ai' then (p_master->>'requires_ai')::boolean else requires_ai end,
      include_in_forecasting = case when p_master ? 'include_in_forecasting' then (p_master->>'include_in_forecasting')::boolean else include_in_forecasting end,
      include_in_monthly_report = case when p_master ? 'include_in_monthly_report' then (p_master->>'include_in_monthly_report')::boolean else include_in_monthly_report end,
      admin_notes = case when p_master ? 'admin_notes' then p_master->>'admin_notes' else admin_notes end,
      updated_at = now()
    where id = v_id;
  end if;

  -- Same conditions-row shape/defaults as migration 0107's
  -- admin_import_recommendation_conditions — kept structurally identical on
  -- purpose (see this function's header comment).
  if p_conditions is not null then
    if jsonb_typeof(p_conditions) <> 'array' then
      raise exception 'admin_upsert_recommendation_atomic: conditions must be a JSON array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_conditions) = 0 and not p_clear_conditions then
      raise exception 'admin_upsert_recommendation_atomic: % supplies zero conditions without explicit clear_conditions=true — refusing to guess', v_code
        using errcode = '22023';
    end if;
    if jsonb_array_length(p_conditions) > 200 then
      raise exception 'admin_upsert_recommendation_atomic: % conditions exceeds the maximum of 200 per recommendation', jsonb_array_length(p_conditions)
        using errcode = '22023';
    end if;

    delete from action_recommendation_conditions where recommendation_code = v_code;
    get diagnostics v_deleted_count = row_count;

    if jsonb_array_length(p_conditions) > 0 then
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
      from jsonb_array_elements(p_conditions) as c;
      get diagnostics v_inserted_count = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'recommendation_code', v_code,
    'created', v_is_create,
    'conditionsReplaced', v_deleted_count,
    'conditionsInserted', v_inserted_count,
    'conditionsTouched', p_conditions is not null
  );
end;
$$;

comment on function admin_upsert_recommendation_atomic(uuid, jsonb, jsonb, boolean) is
  'A0.2 Wave 1B: atomic create/update of one action_recommendation_master row plus (optionally) a full replace of its action_recommendation_conditions, in a single transaction. p_id NULL creates; non-NULL updates (partial — only keys present in p_master change). p_conditions NULL leaves conditions untouched; an array replaces (empty array requires p_clear_conditions=true). See migration 0109 header for the full contract and the active+zero-conditions invariant enforced by trg_recommendation_conditions_nonzero / trg_recommendation_master_nonzero_conditions.';

revoke all on function admin_upsert_recommendation_atomic(uuid, jsonb, jsonb, boolean) from public;
revoke all on function admin_upsert_recommendation_atomic(uuid, jsonb, jsonb, boolean) from anon;
revoke all on function admin_upsert_recommendation_atomic(uuid, jsonb, jsonb, boolean) from authenticated;
grant execute on function admin_upsert_recommendation_atomic(uuid, jsonb, jsonb, boolean) to service_role;
