-- AIE-1 closure mission (section 8) — atomic AI-cost admission.
--
-- WHY A DB FUNCTION, NOT APPLICATION-LEVEL READ-THEN-WRITE. Mission
-- requirement: "prevent concurrent requests overspending the remaining
-- allowance." A read-then-write check in application code (SELECT current
-- spend, compare to allowance, then UPDATE) has a genuine race window under
-- real concurrent requests — this is the exact class of bug this
-- programme's own AIE-1.6 certification found and fixed for acceptance
-- concurrency (`accept.ts`'s CAS-style transition), and the identical
-- discipline applies here. `aie_reserve_ai_cost` does the check-and-
-- increment in ONE atomic `UPDATE ... WHERE ... RETURNING`, which Postgres
-- guarantees is atomic per row regardless of how many concurrent callers
-- invoke it — no advisory lock or `SELECT ... FOR UPDATE` needed.
--
-- SCOPE: one global row for AIE's own pilot allowance
-- (`AIE_AI_COST_ALLOWANCE_USD`, default US$10 — mission section 8). Not
-- per-tenant: the pilot allowance is an application-wide spend ceiling for
-- this whole feature during its pilot phase, matching the mission's own
-- framing ("US$10 application-enforced pilot allowance"), not a per-user
-- budget. A future per-user/per-tenant quota (also named in section 13:
-- "per-user quotas") is a distinct, additive concern this migration does
-- not attempt to solve in the same table.
--
-- LEAST PRIVILEGE: only the service-role can call either function (matches
-- every other AIE write path — no application component gets broad
-- permissions). `security definer` lets a caller with only EXECUTE (not
-- direct table UPDATE) still perform the reservation, matching this
-- migration's other trigger functions' own established pattern.
--
-- OPERATOR ACTION REQUIRED: same disclosed constraint as migrations 0135/
-- 0147 — this session has NO DDL execution channel against DEV/production.
-- Written, reviewed, ready; not applied anywhere by this closure mission.

create table if not exists aie_ai_cost_ledger (
  id text primary key,
  allowance_usd numeric(12, 6) not null check (allowance_usd > 0),
  reserved_usd numeric(12, 6) not null default 0 check (reserved_usd >= 0),
  settled_usd numeric(12, 6) not null default 0 check (settled_usd >= 0),
  -- Observability fields (mission section 8's tracked metrics) --
  -- deliberately COUNTS/TOTALS only, never per-call provider payload or
  -- document content (same "sensitive metadata" discipline as
  -- aie_audit_event.metadata).
  total_attempts bigint not null default 0,
  total_input_tokens bigint not null default 0,
  total_output_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- One row per pilot allowance scope. 'global' is the only scope this pass
-- creates (see header). Idempotent — replaying this migration never resets
-- an existing ledger's accumulated spend.
insert into aie_ai_cost_ledger (id, allowance_usd)
values ('global', 10.00)
on conflict (id) do nothing;

alter table aie_ai_cost_ledger enable row level security;
-- No policy for the authenticated role at all (matches aie_mask_token_map's
-- own "zero policies by design" precedent) — this table is never read or
-- written by anything except the service-role client, via the two
-- functions below.

-- ---------------------------------------------------------------------------
-- aie_reserve_ai_cost — atomic admission check. The ALLOWANCE ITSELF is
-- supplied by the caller (`p_allowance_usd`, sourced from
-- `lib/aie/config.ts#getAieCostAllowanceUsd()` — an app-config env var, so
-- changing the pilot cap is a one-line code/env change, never a separate
-- manual DB update) rather than trusted from the stored `allowance_usd`
-- column; the column is kept in sync as a side effect purely for audit/
-- dashboard visibility (mission section 8: "keep price configuration dated
-- and auditable"), never as the authority the WHERE clause checks against.
-- Reserves `p_amount_usd` in one atomic statement; returns whether the
-- reservation succeeded and the allowance remaining AFTER this call (for
-- the caller's own observability, never as an authority to retry past a
-- refusal).
-- ---------------------------------------------------------------------------
create or replace function aie_reserve_ai_cost(p_ledger_id text, p_amount_usd numeric, p_allowance_usd numeric)
returns table(reserved boolean, remaining_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row aie_ai_cost_ledger%rowtype;
begin
  update aie_ai_cost_ledger
    set reserved_usd = reserved_usd + p_amount_usd,
        allowance_usd = p_allowance_usd,
        total_attempts = total_attempts + 1,
        updated_at = now()
    where id = p_ledger_id
      and (reserved_usd + settled_usd + p_amount_usd) <= p_allowance_usd
    returning * into v_row;

  if found then
    return query select true, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0);
  end if;

  select * into v_row from aie_ai_cost_ledger where id = p_ledger_id;
  if not found then
    raise exception 'aie_reserve_ai_cost: unknown ledger id %', p_ledger_id;
  end if;
  update aie_ai_cost_ledger set allowance_usd = p_allowance_usd, updated_at = now() where id = p_ledger_id;
  return query select false, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- aie_settle_ai_cost — called exactly once per genuinely-attempted provider
-- call (success, failure, or timeout — never for a call the kill switch or
-- PII guard blocked before any reservation was made), releasing the
-- conservative RESERVATION and recording the ACTUAL observed cost/tokens.
-- `p_actual_usd` may be zero (e.g. the provider call failed before any
-- billable tokens were produced) — settling to zero is still required so
-- the reservation does not permanently shrink the remaining allowance for
-- a call that never actually spent anything (mission section 8: "handle
-- uncertain charges after timeouts conservatively" — an uncertain charge
-- is settled at the CONSERVATIVE reserved amount, not assumed zero, unless
-- the caller can prove zero actual spend).
-- ---------------------------------------------------------------------------
create or replace function aie_settle_ai_cost(p_ledger_id text, p_reserved_usd numeric, p_actual_usd numeric, p_input_tokens bigint, p_output_tokens bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update aie_ai_cost_ledger
    set reserved_usd = greatest(reserved_usd - p_reserved_usd, 0),
        settled_usd = settled_usd + p_actual_usd,
        total_input_tokens = total_input_tokens + p_input_tokens,
        total_output_tokens = total_output_tokens + p_output_tokens,
        updated_at = now()
    where id = p_ledger_id;
end;
$$;

revoke all on function aie_reserve_ai_cost(text, numeric, numeric) from public;
revoke all on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint) from public;
grant execute on function aie_reserve_ai_cost(text, numeric, numeric) to service_role;
grant execute on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint) to service_role;
