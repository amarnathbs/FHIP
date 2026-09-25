-- 0195 -- AIE-1 final production completion (2026-09-25): AI spend-cap
-- hardening + per-call provider evidence.
--
-- DEFECTS THIS CLOSES (all found by reading 0152 against its callers; the
-- replay defect is reproduced as a negative control in
-- scripts/aie1_0195_pglite_verification.mjs before this file is applied):
--
--   D1  REPLAY ADMITS AN UNMETERED CALL. 0152's aie_reserve_ai_cost answered
--       a replayed idempotency key with the STORED outcome
--       ("reserved_usd > 0"), whether or not that attempt had already been
--       settled. The document-fallback adapters key on the DOCUMENT id
--       ("payslip-ai-fallback:<documentId>"), and a failed document can be
--       re-processed, so every retry after the first AI attempt was admitted,
--       called the provider for real, and then settled as a no-op (the
--       attempt row was already settled). Real spend, never counted.
--   D2  CONCURRENT SAME-KEY RESERVES BOTH RESERVED. The replay probe was an
--       unlocked SELECT; two sessions could both miss it, both increment
--       reserved_usd, and only one attempt row survived (on conflict do
--       nothing) -- a permanently leaked reservation.
--   D5  NOTHING RELEASED A STALE RESERVATION. A settle that never happened
--       (crash, ignored RPC error) left reserved_usd held forever.
--   D7  THE CAP WAS CALLER-SUPPLIED. p_allowance_usd came from an app env var
--       on every call and overwrote the stored column, so the database was
--       never the authority for the hard cap.
--   EVIDENCE: no per-call record of model, provider request id, tokens or
--       outcome existed for any document-fallback path (only ledger totals).
--
-- DESIGN.
--   * aie_reserve_ai_cost keeps its EXACT signature and return shape, so the
--     code already deployed to production picks up the fix the moment this
--     file is applied, with no deploy ordering hazard. Its behaviour changes
--     in three ways: (1) the key is CLAIMED FIRST by inserting the attempt
--     row -- the primary key serialises concurrent same-key callers and any
--     existing row (settled or not) means "replay" and is NEVER admitted
--     again; (2) the effective allowance is least(p_allowance_usd,
--     ledger.allowance_usd), so the stored column is the ceiling and an app
--     env var can only LOWER it; the column is no longer overwritten; (3) a
--     non-positive reservation amount is refused.
--   * aie_settle_ai_cost_v2 settles by key using the reservation amount
--     STORED on the attempt row (never a caller-supplied figure) and records
--     the per-call evidence. Returns whether it settled, so the caller can
--     tell a no-op from a settlement. The 0152 aie_settle_ai_cost is kept
--     unchanged for code still deployed from before this migration.
--   * aie_release_stale_ai_cost_reservations settles any admitted attempt
--     older than the given age that was never settled, CONSERVATIVELY: the
--     full reserved amount is counted as spent and billing_uncertain = true.
--     It frees nothing that was not already accounted for; it only stops a
--     reservation from being held forever.
--
-- COMPATIBILITY WITH OLD (PRE-0195) APPLICATION CODE, deliberately stated:
-- old code keys a document's AI attempt on the document id, so after this
-- migration a SECOND AI attempt for the same document is refused
-- (budget_exhausted outcome, no provider call). That is fail-closed and is
-- exactly the behaviour D1 needed; new code uses a fresh key per attempt.
--
-- Additive only: new nullable columns on aie_ai_cost_attempt, one replaced
-- function body with an unchanged signature, two new functions. No CHECK
-- constraint is dropped or recreated. No per-environment data.

alter table aie_ai_cost_attempt
  add column if not exists admission_outcome text,
  add column if not exists model text,
  add column if not exists provider_request_ids text[],
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists call_outcome text,
  add column if not exists billing_uncertain boolean,
  add column if not exists settled_by text;

comment on column aie_ai_cost_attempt.admission_outcome is
  '0195: admitted | budget_exhausted. A replayed key never gets a second row and is never admitted.';
comment on column aie_ai_cost_attempt.provider_request_ids is
  '0195: OpenAI x-request-id of every HTTP attempt made under this reservation (retries included). Identifiers only, never content.';
comment on column aie_ai_cost_attempt.billing_uncertain is
  '0195: true when the provider may have billed without reporting usage (timeout/network error after send) or when a stale reservation was released conservatively.';

create or replace function aie_reserve_ai_cost(p_ledger_id text, p_amount_usd numeric, p_allowance_usd numeric, p_idempotency_key text)
returns table(reserved boolean, remaining_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row aie_ai_cost_ledger%rowtype;
  v_claimed integer;
  v_effective_allowance numeric;
begin
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'aie_reserve_ai_cost: reservation amount must be positive (got %)', p_amount_usd;
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'aie_reserve_ai_cost: idempotency key is required';
  end if;

  -- CLAIM THE KEY FIRST. A concurrent caller with the same key blocks on the
  -- primary key until this transaction ends, then conflicts. The foreign key
  -- to aie_ai_cost_ledger makes an unknown ledger id raise here (fail closed).
  insert into aie_ai_cost_attempt (idempotency_key, ledger_id, reserved_usd, remaining_usd_at_reserve, admission_outcome)
  values (p_idempotency_key, p_ledger_id, 0, 0, 'claimed')
  on conflict (idempotency_key) do nothing;
  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    -- REPLAY (settled, in flight, or previously refused): never admitted
    -- again, never reserves again. A caller that genuinely needs another
    -- provider call must use a new key, and that new key is metered.
    select * into v_row from aie_ai_cost_ledger where id = p_ledger_id;
    return query select false, greatest(coalesce(least(p_allowance_usd, v_row.allowance_usd), 0) - coalesce(v_row.reserved_usd, 0) - coalesce(v_row.settled_usd, 0), 0);
    return;
  end if;

  -- Lock the ledger row, then decide against the STORED ceiling.
  select * into v_row from aie_ai_cost_ledger where id = p_ledger_id for update;
  if not found then
    raise exception 'aie_reserve_ai_cost: unknown ledger id %', p_ledger_id;
  end if;
  v_effective_allowance := least(coalesce(p_allowance_usd, v_row.allowance_usd), v_row.allowance_usd);

  if (v_row.reserved_usd + v_row.settled_usd + p_amount_usd) <= v_effective_allowance then
    update aie_ai_cost_ledger
      set reserved_usd = reserved_usd + p_amount_usd,
          total_attempts = total_attempts + 1,
          updated_at = now()
      where id = p_ledger_id
      returning * into v_row;
    update aie_ai_cost_attempt
      set reserved_usd = p_amount_usd,
          remaining_usd_at_reserve = greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0),
          admission_outcome = 'admitted'
      where idempotency_key = p_idempotency_key;
    return query select true, greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0);
    return;
  end if;

  update aie_ai_cost_attempt
    set reserved_usd = 0,
        remaining_usd_at_reserve = greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0),
        admission_outcome = 'budget_exhausted'
    where idempotency_key = p_idempotency_key;
  return query select false, greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0);
end;
$$;

create or replace function aie_settle_ai_cost_v2(
  p_ledger_id text,
  p_idempotency_key text,
  p_actual_usd numeric,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_model text,
  p_provider_request_ids text[],
  p_call_outcome text,
  p_billing_uncertain boolean
)
returns table(settled boolean, already_settled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt aie_ai_cost_attempt%rowtype;
begin
  select * into v_attempt from aie_ai_cost_attempt
    where idempotency_key = p_idempotency_key and ledger_id = p_ledger_id
    for update;
  if not found then
    raise exception 'aie_settle_ai_cost_v2: no reservation exists for this key';
  end if;
  if v_attempt.admission_outcome is distinct from 'admitted' then
    raise exception 'aie_settle_ai_cost_v2: key was never admitted (%)', v_attempt.admission_outcome;
  end if;
  if v_attempt.settled_usd is not null then
    return query select false, true;
    return;
  end if;
  if p_actual_usd is null or p_actual_usd < 0 then
    raise exception 'aie_settle_ai_cost_v2: actual cost must be >= 0';
  end if;

  update aie_ai_cost_ledger
    set reserved_usd = greatest(reserved_usd - v_attempt.reserved_usd, 0),
        settled_usd = settled_usd + p_actual_usd,
        total_input_tokens = total_input_tokens + coalesce(p_input_tokens, 0),
        total_output_tokens = total_output_tokens + coalesce(p_output_tokens, 0),
        updated_at = now()
    where id = p_ledger_id;

  update aie_ai_cost_attempt
    set settled_usd = p_actual_usd,
        settled_at = now(),
        model = p_model,
        provider_request_ids = p_provider_request_ids,
        input_tokens = p_input_tokens,
        output_tokens = p_output_tokens,
        call_outcome = p_call_outcome,
        billing_uncertain = coalesce(p_billing_uncertain, false),
        settled_by = 'gateway'
    where idempotency_key = p_idempotency_key;

  return query select true, false;
end;
$$;

create or replace function aie_release_stale_ai_cost_reservations(p_older_than_minutes integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt aie_ai_cost_attempt%rowtype;
  v_count integer := 0;
begin
  if p_older_than_minutes is null or p_older_than_minutes < 5 then
    raise exception 'aie_release_stale_ai_cost_reservations: minimum age is 5 minutes';
  end if;
  for v_attempt in
    select * from aie_ai_cost_attempt
      where admission_outcome = 'admitted'
        and settled_usd is null
        and created_at < now() - make_interval(mins => p_older_than_minutes)
      for update skip locked
  loop
    -- Conservative: the whole reservation is counted as spent.
    update aie_ai_cost_ledger
      set reserved_usd = greatest(reserved_usd - v_attempt.reserved_usd, 0),
          settled_usd = settled_usd + v_attempt.reserved_usd,
          updated_at = now()
      where id = v_attempt.ledger_id;
    update aie_ai_cost_attempt
      set settled_usd = v_attempt.reserved_usd,
          settled_at = now(),
          billing_uncertain = true,
          call_outcome = coalesce(call_outcome, 'unsettled_released'),
          settled_by = 'stale_release'
      where idempotency_key = v_attempt.idempotency_key;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- PRIVILEGES. `revoke ... from public` (all that 0150/0152 did) does NOT
-- remove the EXPLICIT execute grants Supabase's default privileges give the
-- anon and authenticated roles on every new public function. Proven live in
-- DEV on 2026-09-25: an anon-key POST to /rest/v1/rpc/aie_settle_ai_cost
-- returned 204 (executed). With anon execute on aie_reserve_ai_cost, anyone
-- holding the public anon key could exhaust the AI allowance (denial of
-- service) or, under 0152's semantics, overwrite allowance_usd. Revoked here
-- from anon and authenticated explicitly, for the old and new functions.
revoke all on function aie_reserve_ai_cost(text, numeric, numeric, text) from public, anon, authenticated;
revoke all on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint, text) from public, anon, authenticated;
revoke all on function aie_settle_ai_cost_v2(text, text, numeric, bigint, bigint, text, text[], text, boolean) from public, anon, authenticated;
revoke all on function aie_release_stale_ai_cost_reservations(integer) from public, anon, authenticated;
grant execute on function aie_settle_ai_cost(text, numeric, numeric, bigint, bigint, text) to service_role;
grant execute on function aie_reserve_ai_cost(text, numeric, numeric, text) to service_role;
grant execute on function aie_settle_ai_cost_v2(text, text, numeric, bigint, bigint, text, text[], text, boolean) to service_role;
grant execute on function aie_release_stale_ai_cost_reservations(integer) to service_role;
