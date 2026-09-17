-- AIE-1 infrastructure-activation mission (section 14: "Duplicate
-- settlement protection... No accidental retries from multiple SDK/
-- application layers") -- migration 0150's aie_reserve_ai_cost/
-- aie_settle_ai_cost had NO idempotency protection at the DB layer at
-- all: only the gateway's own in-memory `inFlight` map
-- (lib/aie/provider/gateway.ts) de-duplicates concurrent calls sharing an
-- idempotencyKey, and that protection is process-local only -- it does
-- nothing for a genuine cross-process retry (e.g. a worker crash and
-- restart, or a client retry after its own request timed out even though
-- the server-side call actually completed).
--
-- CONFIRMED LIVE, THIS SESSION, BEFORE THIS FIX: calling
-- aie_settle_ai_cost twice with the same (reserved_usd, actual_usd)
-- params -- exactly what a naive retry would do -- doubled settled_usd
-- (1.50 -> 3.00) and doubled the recorded token counts. This is a real,
-- live-confirmed defect, not a theoretical one.
--
-- FIX: a small idempotency-attempt ledger,
-- aie_ai_cost_attempt(idempotency_key primary key), recording each
-- logical attempt's reserved amount and (once known) settled amount.
-- Both RPCs now take p_idempotency_key and consult this table first:
--   - aie_reserve_ai_cost: a repeat reservation under an
--     already-recorded key returns the SAME stored result without
--     reserving a second time against the ledger.
--   - aie_settle_ai_cost: a repeat settlement under an already-settled
--     key is a no-op -- the ledger is touched exactly once per logical
--     attempt, regardless of how many times the caller (or a retry)
--     calls it.
-- Same least-privilege discipline as 0150/0151: RLS enabled with zero
-- policies (service-role only, via the two SECURITY DEFINER functions),
-- no direct table grants.
create table if not exists aie_ai_cost_attempt (
  idempotency_key text primary key,
  ledger_id text not null references aie_ai_cost_ledger(id),
  reserved_usd numeric(12, 6) not null,
  settled_usd numeric(12, 6),
  remaining_usd_at_reserve numeric(12, 6) not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index idx_aie_ai_cost_attempt_ledger on aie_ai_cost_attempt (ledger_id);

alter table aie_ai_cost_attempt enable row level security;
-- No policy for the authenticated role at all (matches
-- aie_ai_cost_ledger's own "zero policies by design" precedent from
-- 0150) -- this table is never read or written by anything except the
-- service-role client, via the two functions below.

create or replace function aie_reserve_ai_cost(p_ledger_id text, p_amount_usd numeric, p_allowance_usd numeric, p_idempotency_key text)
returns table(reserved boolean, remaining_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row aie_ai_cost_ledger%rowtype;
  v_attempt aie_ai_cost_attempt%rowtype;
begin
  -- Idempotent replay: this exact attempt already reserved (or was
  -- already denied) once -- return the SAME stored outcome, never
  -- re-reserve against the ledger a second time for the same key.
  select * into v_attempt from aie_ai_cost_attempt where idempotency_key = p_idempotency_key;
  if found then
    return query select (v_attempt.reserved_usd > 0), v_attempt.remaining_usd_at_reserve;
    return;
  end if;

  update aie_ai_cost_ledger
    set reserved_usd = reserved_usd + p_amount_usd,
        allowance_usd = p_allowance_usd,
        total_attempts = total_attempts + 1,
        updated_at = now()
    where id = p_ledger_id
      and (reserved_usd + settled_usd + p_amount_usd) <= p_allowance_usd
    returning * into v_row;

  if found then
    insert into aie_ai_cost_attempt (idempotency_key, ledger_id, reserved_usd, remaining_usd_at_reserve)
    values (p_idempotency_key, p_ledger_id, p_amount_usd, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0))
    on conflict (idempotency_key) do nothing;
    return query select true, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0);
    return; -- also fixes 0150's missing-RETURN bug for this signature.
  end if;

  select * into v_row from aie_ai_cost_ledger where id = p_ledger_id;
  if not found then
    raise exception 'aie_reserve_ai_cost: unknown ledger id %', p_ledger_id;
  end if;
  update aie_ai_cost_ledger set allowance_usd = p_allowance_usd, updated_at = now() where id = p_ledger_id;
  insert into aie_ai_cost_attempt (idempotency_key, ledger_id, reserved_usd, remaining_usd_at_reserve)
  values (p_idempotency_key, p_ledger_id, 0, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0))
  on conflict (idempotency_key) do nothing;
  return query select false, greatest(p_allowance_usd - v_row.reserved_usd - v_row.settled_usd, 0);
end;
$$;

create or replace function aie_settle_ai_cost(p_ledger_id text, p_reserved_usd numeric, p_actual_usd numeric, p_input_tokens bigint, p_output_tokens bigint, p_idempotency_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_settled boolean;
begin
  select (settled_usd is not null) into v_already_settled
  from aie_ai_cost_attempt
  where idempotency_key = p_idempotency_key
  for update; -- lock this attempt row for the duration of this transaction, so two concurrent settle calls for the SAME key cannot both pass the check below.

  if v_already_settled is true then
    return; -- already settled once for this exact attempt -- no-op.
  end if;

  update aie_ai_cost_ledger
    set reserved_usd = greatest(reserved_usd - p_reserved_usd, 0),
        settled_usd = settled_usd + p_actual_usd,
        total_input_tokens = total_input_tokens + p_input_tokens,
        total_output_tokens = total_output_tokens + p_output_tokens,
        updated_at = now()
    where id = p_ledger_id;

  update aie_ai_cost_attempt
    set settled_usd = p_actual_usd, settled_at = now()
    where idempotency_key = p_idempotency_key;
  -- If no aie_ai_cost_attempt row exists for this key at all (a settle
  -- call with no matching prior reserve -- should not happen given the
  -- gateway's own call order, but not assumed away here), the ledger
  -- UPDATE above still applies (fail-open on the LEDGER side would be
  -- wrong the other way -- a real provider call that WAS genuinely
  -- attempted must still be recorded) while this UPDATE is simply a
  -- no-op affecting zero rows. A caller relying on idempotency for a
  -- key with no matching reservation gets no protection -- documented,
  -- not silently pretended away.
end;
$$;

revoke all on function aie_reserve_ai_cost(text, numeric, numeric, text) from public;
revoke all on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint, text) from public;
grant execute on function aie_reserve_ai_cost(text, numeric, numeric, text) to service_role;
grant execute on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint, text) to service_role;

-- The old 4-arg/5-arg signatures from 0150/0151 are superseded, not
-- dropped in the same migration as a safety margin against an
-- in-flight caller mid-deploy still holding the old signature; drop
-- them explicitly here since this is DEV-only and this session
-- controls both the DB and the only caller of these functions.
drop function if exists aie_reserve_ai_cost(text, numeric, numeric);
drop function if exists aie_settle_ai_cost(text, numeric, numeric, bigint, bigint);
