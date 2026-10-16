-- 0284 -- AIE per-user DAILY spend cap (Product Owner decision 16-10-2026).
--
-- WHY. The only AIE spend ceiling was ONE global ledger (US$10, 0150 and 0195).
-- With AI reading open to every Premium user (14-10-2026) a single account
-- could consume the whole of it. This adds a second ceiling, per user per day,
-- decided in the SAME atomic admission step as the global one.
--
-- DESIGN (smallest change that is correct).
--   * No new table and no counter. The spend of one user for one day is DERIVED
--     by adding up the attempt rows that already exist: for every attempt of
--     that user created on that UTC day, the settled amount when it has been
--     settled, otherwise the amount still reserved. So settlement (lower or
--     higher actual cost), stale-reservation recovery (0195) and refused
--     attempts (reserved = 0) are per-user-correct without touching those
--     functions, and there is no second number that could disagree with the
--     first.
--   * Two additive columns: user_id on the attempt row (who the reservation was
--     made for) and user_daily_cap_usd on the ledger row (the ceiling). The
--     stored column is the authority and is never caller-supplied. The caller
--     may pass a LOWER figure (an emergency brake set in application settings)
--     but never a higher one, exactly like the global allowance since 0195.
--   * New function aie_reserve_ai_cost_v2. The 0195 function keeps its exact
--     signature and behaviour so application code deployed before this change
--     keeps working during the roll-out. The application code that ships with
--     this change calls only the v2 function and refuses (fails closed) when it
--     is missing, so there is no path that silently skips the per-user check.
--   * Concurrency. The v2 function takes the ledger row lock FIRST (before even
--     claiming its key) and holds it until the end of the same transaction, so two
--     simultaneous requests for one user are decided one after the other and the
--     second one sees the first reservation. This is the same lock the global
--     check already needs. No extra lock and no new lock order.
--   * DAY BOUNDARY: the UTC calendar day (00:00:00 UTC to 23:59:59.999999 UTC).
--     Same definition Module 11 uses for its platform daily limit and the same
--     one the entitlement windows use. It never moves with daylight saving.
--     An attempt belongs to the day it was CLAIMED (created_at), even when it is
--     settled later.
--   * Replays. A key that has been seen before is never admitted and never
--     charged again (unchanged 0195 rule), and the user total ignores it.
--
-- Additive only. No CHECK constraint on an existing table is dropped or
-- recreated. Existing attempt rows keep user_id null and count for nobody.
-- The default cap (1.00) is mirrored by AIE_USER_DAILY_CAP_USD_DEFAULT in
-- lib/aie/config.ts and a test keeps the two equal.

alter table aie_ai_cost_ledger
  add column if not exists user_daily_cap_usd numeric(12, 6) not null default 1.000000 check (user_daily_cap_usd >= 0);

comment on column aie_ai_cost_ledger.user_daily_cap_usd is
  '0284: the most one user may have reserved or spent per UTC day. The authority. Application settings may only lower it.';

alter table aie_ai_cost_attempt
  add column if not exists user_id uuid references auth.users (id) on delete set null;

comment on column aie_ai_cost_attempt.user_id is
  '0284: the signed-in user the reservation was made for. Null for attempts recorded before this change. Never exposed to browsers.';

create index if not exists idx_aie_ai_cost_attempt_user_day
  on aie_ai_cost_attempt (user_id, created_at)
  where user_id is not null;

create or replace function aie_reserve_ai_cost_v2(
  p_ledger_id text,
  p_amount_usd numeric,
  p_allowance_usd numeric,
  p_idempotency_key text,
  p_user_id uuid,
  p_user_daily_cap_usd numeric
)
returns table(reserved boolean, remaining_usd numeric, refusal_reason text, user_remaining_usd numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row record;
  v_claimed integer;
  v_effective_allowance numeric;
  v_effective_user_cap numeric;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_user_used numeric;
  v_user_remaining numeric;
begin
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'aie_reserve_ai_cost_v2: reservation amount must be positive';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'aie_reserve_ai_cost_v2: idempotency key is required';
  end if;
  if p_user_id is null then
    raise exception 'aie_reserve_ai_cost_v2: a user id is required';
  end if;

  -- LOCK THE LEDGER ROW FIRST. The claim insert below references this row by
  -- foreign key, which takes a shared lock on it. Taking that shared lock and
  -- only then asking for the exclusive lock makes any two concurrent callers
  -- wait on each other (found on DEV 16-10-2026: 22 simultaneous requests
  -- admitted 2 and timed out 20). Locking first means callers simply queue.
  -- Everything below is decided under this lock, so the user total read next
  -- cannot be stale by the time it is acted on.
  select * into v_row from aie_ai_cost_ledger where id = p_ledger_id for update;
  if not found then
    raise exception 'aie_reserve_ai_cost_v2: unknown ledger id';
  end if;

  -- CLAIM THE KEY (as 0195 does). The primary key still refuses a second claim
  -- of the same key. The row carries the user so the total below can see it,
  -- and counts for nothing until it is admitted (reserved stays 0).
  insert into aie_ai_cost_attempt (idempotency_key, ledger_id, reserved_usd, remaining_usd_at_reserve, admission_outcome, user_id)
  values (p_idempotency_key, p_ledger_id, 0, 0, 'claimed', p_user_id)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    -- REPLAY: never admitted again, never reserves again, never charges again.
    select coalesce(sum(coalesce(a.settled_usd, a.reserved_usd)), 0) into v_user_used
      from aie_ai_cost_attempt a
     where a.user_id = p_user_id and a.created_at >= v_day_start;
    return query select
      false,
      greatest(coalesce(least(p_allowance_usd, v_row.allowance_usd), 0) - coalesce(v_row.reserved_usd, 0) - coalesce(v_row.settled_usd, 0), 0),
      'replay'::text,
      greatest(coalesce(least(p_user_daily_cap_usd, v_row.user_daily_cap_usd), v_row.user_daily_cap_usd, 0) - v_user_used, 0);
    return;
  end if;

  v_effective_allowance := least(coalesce(p_allowance_usd, v_row.allowance_usd), v_row.allowance_usd);
  v_effective_user_cap := greatest(least(coalesce(p_user_daily_cap_usd, v_row.user_daily_cap_usd), v_row.user_daily_cap_usd), 0);

  -- The spend of this user today: settled amount when settled, reserved otherwise.
  select coalesce(sum(coalesce(a.settled_usd, a.reserved_usd)), 0) into v_user_used
    from aie_ai_cost_attempt a
   where a.user_id = p_user_id and a.created_at >= v_day_start;
  v_user_remaining := greatest(v_effective_user_cap - v_user_used, 0);

  -- 1. PER-USER DAILY CAP. Equal to the cap is allowed. Beyond it is refused.
  if v_user_used + p_amount_usd > v_effective_user_cap then
    update aie_ai_cost_attempt
      set reserved_usd = 0,
          remaining_usd_at_reserve = greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0),
          admission_outcome = 'user_daily_cap_reached'
      where idempotency_key = p_idempotency_key;
    return query select false, greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0), 'user_daily_cap'::text, v_user_remaining;
    return;
  end if;

  -- 2. GLOBAL ALLOWANCE (unchanged since 0195).
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
    return query select true, greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0), null::text, greatest(v_user_remaining - p_amount_usd, 0);
    return;
  end if;

  update aie_ai_cost_attempt
    set reserved_usd = 0,
        remaining_usd_at_reserve = greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0),
        admission_outcome = 'budget_exhausted'
    where idempotency_key = p_idempotency_key;
  return query select false, greatest(v_effective_allowance - v_row.reserved_usd - v_row.settled_usd, 0), 'budget_exhausted'::text, v_user_remaining;
end;
$fn$;

-- Same privilege discipline as 0195. Only the service role may call it. Supabase
-- grants execute on new public functions to anon and authenticated by default,
-- and revoking public alone does not remove those explicit grants.
revoke all on function aie_reserve_ai_cost_v2(text, numeric, numeric, text, uuid, numeric) from public, anon, authenticated;
grant execute on function aie_reserve_ai_cost_v2(text, numeric, numeric, text, uuid, numeric) to service_role;
