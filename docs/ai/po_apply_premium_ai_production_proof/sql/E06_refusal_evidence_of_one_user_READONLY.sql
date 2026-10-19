-- E06 READ-ONLY. For a Free (or lapsed, or former-pilot) account: proof that nothing was stored, scanned or charged.
-- Replace the all-zero id with the user id of the Free proof account. Expected for a Free account blocked at upload:
-- uploads 0, drafts 0, cost_attempts 0, ai_events 0. For a lapsed account that uploaded while Premium: a not_usable
-- event with reason premium_required, drafts 0 and cost_attempts 0.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as user_id)
select (select count(*) from fdh_statement_uploads u where u.user_id = p.user_id) as uploads,
       (select count(*) from fdh_ai_fallback_drafts d where d.user_id = p.user_id) as drafts,
       (select count(*) from aie_ai_cost_attempt a where a.user_id = p.user_id) as cost_attempts,
       (select count(*) from fdh_document_audit_events e where e.user_id = p.user_id and strpos(e.event_type, 'ai_fallback') > 0) as ai_events,
       (select string_agg(distinct coalesce(e.metadata ->> 'reason', e.metadata ->> 'outcome', '-'), ', ')
          from fdh_document_audit_events e where e.user_id = p.user_id and right(e.event_type, 10) = 'not_usable') as refusal_reasons,
       (select e2.plan_tier || ' ' || coalesce(e2.effective_from::text, '-') || ' to ' || coalesce(e2.effective_to::text, '-') || ' source ' || coalesce(e2.entitlement_source, '-')
          from user_entitlements e2 where e2.user_id = p.user_id) as entitlement
  from p;
