-- 0282 -- Fund analytics: an aggregate-only count of statement lines held back because their ISIN and AMFI code point at two different funds.
--
-- Forward-only, additive, idempotent. HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply AFTER 0262 (any later point is fine).
--
-- WHY (release candidate, blocker B4). This release changes how EVERY statement is matched (item F1 of the fund analytics work, Product Owner decision of 04-10-2026): a
-- line whose ISIN identifies one fund and whose AMFI scheme code identifies a different fund is no longer matched silently to the ISIN fund.
-- It opens one review question (a reconciliation case of type ambiguous_instrument). The person who runs the release needs to SEE how many new
-- questions of that kind appear after it, so a surprising volume is noticed on the first day and not by a support request.
--
-- WHAT IT COUNTS. Cases of type ambiguous_instrument whose recorded reason says the two identifiers point at different instruments (that wording
-- exists only since this release, so every such case was opened by it). Counts: opened in the last 7 days, in the last 30 days, in the last 90
-- days and still open now. The number of distinct people is counted too. Every figure is passed through nav2_monitor_cell as user derived, so a
-- value below 5 is returned as suppressed (Insufficient data to display safely) and never as a bare zero. No user, no fund, no statement and no
-- name leaves the function.
--
-- AUTHORISATION. Inside the function: a signed-in caller with the existing reference data quality capability (is_pc6_reference_data_admin),
-- the same capability as the monitoring snapshot of 0262. Anyone else gets an authorisation error (42501), never an empty result.
--
-- ROLLBACK: drop the function nav2_ambiguity_case_summary.

create or replace function nav2_ambiguity_case_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_7d bigint;
  v_30d bigint;
  v_90d bigint;
  v_open bigint;
  v_people_90d bigint;
begin
  if auth.uid() is null or not public.is_pc6_reference_data_admin() then
    raise exception 'nav2 ambiguity summary: not authorised' using errcode = '42501';
  end if;
  select count(*) filter (where c.opened_at > now() - interval '7 days'),
         count(*) filter (where c.opened_at > now() - interval '30 days'),
         count(*),
         count(*) filter (where c.status in ('open', 'user_reviewing')),
         count(distinct c.user_id)
    into v_7d, v_30d, v_90d, v_open, v_people_90d
    from public.ii_reconciliation_cases c
   where c.discrepancy_type = 'ambiguous_instrument'
     and c.opened_at > now() - interval '90 days'
     and position('point at different instruments' in coalesce(c.discrepancy_details ->> 'reason', '')) > 0;
  return jsonb_build_object(
    'generated_at', now(),
    'opened_last_7_days', public.nav2_monitor_cell(v_7d, true),
    'opened_last_30_days', public.nav2_monitor_cell(v_30d, true),
    'opened_last_90_days', public.nav2_monitor_cell(v_90d, true),
    'still_open', public.nav2_monitor_cell(v_open, true),
    'people_affected_last_90_days', public.nav2_monitor_cell(v_people_90d, true)
  );
end $fn$;
revoke all on function nav2_ambiguity_case_summary() from public, anon;
grant execute on function nav2_ambiguity_case_summary() to authenticated, service_role;
