-- 06 FUNCTIONAL PROBE. Leaves NOTHING behind. Run only AFTER the apply file.
-- It asks the new function for two reservations for one existing user who has no spend today: the first must be
-- admitted and the second must be refused for the per-user cap. It then deliberately raises an error whose text is
-- the report, and that error rolls the whole block back, so no reservation row and no ledger change is kept.
-- THE RESULT YOU WANT is an error message that starts with PROBE OK. Any other text is a failure: send it back.
-- A message starting with PROBE FAILED shows what was seen. Nothing is written either way.

do $probe$
declare
  v_user uuid;
  v_first record;
  v_second record;
begin
  select u.id into v_user
  from auth.users u
  where not exists (
    select 1 from public.aie_ai_cost_attempt a
    where a.user_id = u.id and a.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  )
  limit 1;
  if v_user is null then
    raise exception 'PROBE FAILED: no user without spend today was found to probe with';
  end if;

  select * into v_first from public.aie_reserve_ai_cost_v2('global', 0.3, 10, 'probe-first-' || gen_random_uuid()::text, v_user, 0.5);
  select * into v_second from public.aie_reserve_ai_cost_v2('global', 0.3, 10, 'probe-second-' || gen_random_uuid()::text, v_user, 0.5);

  if v_first.reserved is true and v_second.reserved is false and v_second.refusal_reason = 'user_daily_cap' then
    raise exception 'PROBE OK: first reservation admitted, second refused for the per-user daily cap. Rolled back, nothing kept.';
  end if;
  raise exception using message = 'PROBE FAILED: first admitted=' || coalesce(v_first.reserved::text, 'null') || ', second admitted=' || coalesce(v_second.reserved::text, 'null') || ', second reason=' || coalesce(v_second.refusal_reason, 'null');
end
$probe$;
