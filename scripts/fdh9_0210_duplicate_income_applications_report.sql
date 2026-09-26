-- 0210 PREFLIGHT -- duplicate Income applications per payroll event (GAP-04).
--
-- Run this BEFORE applying supabase/migrations/0210_fdh9_income_apply_guards.sql
-- in any environment (DEV, then production). 0210 creates a partial unique
-- index on fhip_import_applications(source_payroll_event_id) WHERE
-- target_domain = 'income', and refuses to run while a payroll event already
-- has two or more Income applications.
--
-- STEP 1 (read-only): the report. Zero rows = nothing to do; apply 0210.
select
  a.source_payroll_event_id,
  a.user_id,
  count(*)                                         as applications,
  array_agg(a.id order by a.applied_at)            as application_ids,
  array_agg(a.target_entity_id order by a.applied_at) as income_source_ids,
  array_agg(a.apply_mode order by a.applied_at)    as apply_modes,
  min(a.applied_at)                                as first_applied_at,
  max(a.applied_at)                                as last_applied_at
from fhip_import_applications a
where a.target_domain = 'income' and a.source_payroll_event_id is not null
group by a.source_payroll_event_id, a.user_id
having count(*) > 1
order by last_applied_at desc;

-- STEP 2 (read-only): the income rows involved, so the duplicate Salary row a
-- second add_new created can be identified and reviewed WITH THE USER. This
-- script never deletes an income row: whether the second row is a duplicate
-- or a genuinely different income is the user's call.
select s.id, s.user_id, s.source_name, s.employer_name, s.amount, s.net_amount, s.frequency,
       s.currency_code, s.owner, s.source_type, s.last_import_application_id, s.is_active, s.created_at
from income_sources s
where s.id in (
  select a.target_entity_id
  from fhip_import_applications a
  where a.target_domain = 'income' and a.source_payroll_event_id in (
    select source_payroll_event_id from fhip_import_applications
    where target_domain = 'income' and source_payroll_event_id is not null
    group by source_payroll_event_id having count(*) > 1
  )
)
order by s.user_id, s.created_at;

-- STEP 3 (the prepared cleanup -- a WRITE; the PO runs it, inside a
-- transaction, after reviewing steps 1-2). It keeps the EARLIEST application
-- of each payroll event as that event's Income application and detaches the
-- later ones from the payroll event (source_payroll_event_id -> null). Every
-- application row is kept (the audit trail is append-only in spirit); only the
-- event link of the later duplicates is removed, which is exactly what the
-- unique index needs. Expected row count = sum(applications - 1) from step 1.
--
-- begin;
-- with ranked as (
--   select id, row_number() over (partition by source_payroll_event_id order by applied_at, id) as rn
--   from fhip_import_applications
--   where target_domain = 'income' and source_payroll_event_id is not null
-- )
-- update fhip_import_applications a
--   set source_payroll_event_id = null
--   from ranked r
--   where a.id = r.id and r.rn > 1;
-- -- check the reported row count, then:
-- commit;
