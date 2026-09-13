-- AIE-1 infrastructure-activation follow-on -- fixes a real bug in
-- migration 0150's aie_reserve_ai_cost, found by live-testing it against
-- DEV immediately after 0150 was applied (not caught by reading the SQL
-- alone, which is exactly why this session re-verifies every migration
-- live rather than trusting a static read).
--
-- THE BUG. PL/pgSQL's `RETURN QUERY` appends rows to a set-returning
-- function's result and does NOT exit the function the way a plain
-- `RETURN` does. The original body was:
--   if found then
--     return query select true, ...;
--   end if;
--   -- (falls through here regardless of the branch above)
--   select * into v_row from aie_ai_cost_ledger where id = p_ledger_id;
--   ...
--   return query select false, ...;
--
-- On a SUCCESSFUL reservation, this emits the correct `(true, remaining)`
-- row from the `if found` branch, then falls through anyway and emits a
-- SECOND, contradictory `(false, remaining)` row from the code that was
-- only meant to run on denial. Confirmed live: a successful reservation
-- returned 2 rows; a denied one correctly returned 1.
--
-- REAL-WORLD IMPACT, precisely (not overstated). `lib/aie/cost/
-- costAdmission.ts#reserveConservativeAiCost` reads `data[0]` -- which
-- happens to be the correct `true` row, since PL/pgSQL emits rows in
-- execution order and the success branch runs first. The admission
-- decision and the ledger's own reserved_usd/total_attempts counters are
-- therefore NOT currently wrong (verified live: no double-counting). But
-- the function breaks its own declared `returns table(...)` single-row
-- contract, and any future caller using Supabase's `.single()` idiom
-- (used elsewhere in this codebase for exactly this RPC shape) would
-- throw "JSON object requested, multiple (or no) rows returned" on every
-- successful call. This is a real defect, fixed here, not a false alarm.
--
-- THE FIX: a bare `return;` immediately after the success branch's
-- `return query`, so the function genuinely stops there instead of
-- falling through. No other logic changed -- the atomic
-- UPDATE...WHERE...RETURNING admission check itself was always correct;
-- only the post-decision control flow was buggy.
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
    return; -- THE FIX: stop here on success, never fall through to the denial path below.
  end if;

  select * into v_row from aie_ai_cost_ledger where id = p_ledger_id;
  if not found then
    raise exception 'aie_reserve_ai_cost: unknown ledger id %', p_ledger_id;
  end if;
  update aie_ai_cost_ledger set allowance_usd = p_allowance_usd, updated_at = now() where id = p_ledger_id;
  return query select false, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0);
end;
$$;

-- Grants are unchanged by CREATE OR REPLACE FUNCTION on the same
-- signature, but re-asserted explicitly for auditability -- this
-- migration should be a complete, self-contained statement of the
-- function's final intended state, not require reading 0150 alongside it
-- to know who can call it.
revoke all on function aie_reserve_ai_cost(text, numeric, numeric) from public;
grant execute on function aie_reserve_ai_cost(text, numeric, numeric) to service_role;
