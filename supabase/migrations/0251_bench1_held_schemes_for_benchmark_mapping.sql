-- 0251 - BENCH-1: "held schemes needing a benchmark" aggregate for the Market Index Data > Mappings tab.
--
-- WHY A MIGRATION. The held-instrument population lives in user-scoped tables (ii_transactions is
-- row-level-secured per user). An admin's own session cannot read other users' rows, and the Admin
-- API routes may never use the service-role client. The approved pattern (Admin Architecture
-- Standard section 6) is a narrow, aggregate-only SECURITY DEFINER RPC with an internal capability
-- check. This is that RPC. ADDITIVE and IDEMPOTENT: one new function, nothing dropped, no
-- constraint or existing object touched. It writes nothing.
--
-- WHAT IT RETURNS (output-column allow-list; one row per instrument, never per user or per row):
--   instrument_id, instrument_name, amc_name, amfi_scheme_code, sub_category, category_header_raw,
--   holder_count (distinct holders, a number only) and first_held_date (earliest non-reversed
--   transaction date across all holders) - BOTH NULL when fewer than 10 people hold the scheme
--   (Admin Standard section 7.2 minimum distinct-person count; enforced here, inside the database),
--   mapped, proposal_waiting. A scheme held by fewer than 10 people STILL APPEARS in the list (mapping
--   needs no counts); only its count and date are withheld.
-- NEVER returned: user_id, account, folio, units, amounts, any per-user value.
--
-- HELD means: at least one transaction whose status is neither 'reversed' nor 'review_required'
-- (the same exclusion the analytics loaders and the demand aggregation apply).
--
-- CAPABILITY: is_benchmark_data_viewer() (the existing read-only 'view' capability, 0241), checked
-- INSIDE the function from auth.uid(); an unauthorised or anonymous caller gets an explicit 42501
-- error, never an empty set. EXECUTE is revoked from PUBLIC/anon and granted to authenticated.
--
-- ADMIN STANDARD NOTE: holder_count and first_held_date are behavioural aggregates, so the section 7.2
-- minimum of 10 distinct people applies and is enforced below. NO exception to section 7 was requested or
-- approved (section 16.1 not invoked). v_min_holders is the single constant. The result is not ordered by
-- holder count, so the order itself cannot disclose a suppressed count.

create or replace function public.benchmark_held_schemes()
returns table (
  instrument_id uuid,
  instrument_name text,
  amc_name text,
  amfi_scheme_code text,
  sub_category text,
  category_header_raw text,
  holder_count integer,
  first_held_date date,
  mapped boolean,
  proposal_waiting boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_min_holders constant integer := 10;
begin
  if auth.uid() is null or not public.is_benchmark_data_viewer() then
    raise exception 'benchmark held schemes: benchmark data view capability required' using errcode = '42501';
  end if;
  return query
  with held as (
    select t.instrument_id as iid, count(distinct t.user_id)::integer as holders, min(t.transaction_date) as first_date
      from public.ii_transactions t
     where t.instrument_id is not null
       and coalesce(t.status, '') not in ('reversed', 'review_required')
     group by t.instrument_id
  )
  select h.iid,
         i.instrument_name::text,
         coalesce(nullif(btrim(m.amc_name), ''), nullif(btrim(i.amc_name), ''))::text,
         m.amfi_scheme_code::text,
         m.sub_category::text,
         m.category_header_raw::text,
         case when h.holders >= v_min_holders then h.holders else null end,
         case when h.holders >= v_min_holders then h.first_date else null end,
         exists (select 1 from public.ii_instrument_benchmarks b
                  where b.instrument_id = h.iid and b.relationship_type = 'primary' and b.quality_status is distinct from 'superseded'),
         exists (select 1 from public.ii_benchmark_mapping_proposals p
                  where p.instrument_id = h.iid and p.status = 'proposed')
    from held h
    join public.ii_instruments i on i.id = h.iid
    left join lateral (
      select sm.amc_name, sm.amfi_scheme_code, sm.sub_category, sm.category_header_raw
        from public.ii_scheme_master sm
       where sm.instrument_id = h.iid and sm.effective_to is null
       order by sm.effective_from desc
       limit 1
    ) m on true
   order by i.instrument_name, h.iid;
end $$;

revoke all on function public.benchmark_held_schemes() from public, anon;
grant execute on function public.benchmark_held_schemes() to authenticated;

comment on function public.benchmark_held_schemes() is
  'BENCH-1 (0251): aggregate-only list of held instruments with mapping state, for the Mappings tab. Holder count and first held date are returned only where at least 10 people hold the scheme (else null). View capability checked inside; no user id, account, unit or amount is ever returned.';
