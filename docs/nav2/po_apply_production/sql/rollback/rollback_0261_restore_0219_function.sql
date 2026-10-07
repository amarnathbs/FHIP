-- ROLLBACK for 0261 step 1 of 2: put the 0219 version of the retention function back (the body is the text of migration 0219 byte for byte,
-- only the dollar quote tag is named for the SQL editor). Run this FIRST, then rollback_0261_drop_tables.sql.

create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $fn$
  with recursive merge_family(instrument_id, depth) as (
    select p_instrument_id, 0
    union
    select x.other, f.depth + 1
    from merge_family f
    cross join lateral (
      select i.merged_into_instrument_id as other from ii_instruments i
        where i.id = f.instrument_id and i.merged_into_instrument_id is not null
      union all
      select i.id from ii_instruments i where i.merged_into_instrument_id = f.instrument_id
      union all
      select s.merged_into_instrument_id from ii_scheme_master s
        where s.instrument_id = f.instrument_id and s.merged_into_instrument_id is not null
      union all
      select s.instrument_id from ii_scheme_master s
        where s.merged_into_instrument_id = f.instrument_id and s.instrument_id is not null
    ) x
    where f.depth < 8
  )
  select coalesce(not (
    p_price_date >= p_changeover_date
    or pc6_instrument_is_user_held(p_instrument_id)
    or exists (
      select 1 from ii_instrument_benchmarks ib where ib.instrument_id = p_instrument_id
    )
    or exists (
      select 1 from ii_report_nav_dependencies d
      where d.instrument_id = p_instrument_id
        and p_price_date <= d.nav_date_to
        and (d.nav_date_from is null or p_price_date >= d.nav_date_from)
    )
    or exists (
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
    or exists (
      select 1 from ii_nav_source_coverage_gaps g
      where g.instrument_id = p_instrument_id and g.resolved_at is null
        and p_price_date between g.gap_from and g.gap_to
    )
    or exists (
      select 1 from merge_family m
      where m.instrument_id is distinct from p_instrument_id
        and (
          pc6_instrument_is_user_held(m.instrument_id)
          or exists (select 1 from ii_instrument_benchmarks ib where ib.instrument_id = m.instrument_id)
          or exists (select 1 from ii_report_nav_dependencies d where d.instrument_id = m.instrument_id)
          or exists (
            select 1 from ii_nav_retention_holds h
            where h.instrument_id = m.instrument_id and h.released_at is null
              and (h.expires_at is null or h.expires_at > now())
          )
          or exists (
            select 1 from ii_nav_source_coverage_gaps g
            where g.instrument_id = m.instrument_id and g.resolved_at is null
          )
        )
    )
  ), false);
$fn$;

revoke execute on function pc6_nav_row_is_candidate(uuid, date, date) from public, anon, authenticated;
grant execute on function pc6_nav_row_is_candidate(uuid, date, date) to service_role;
