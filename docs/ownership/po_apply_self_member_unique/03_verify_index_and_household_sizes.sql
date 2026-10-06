-- File 03: after applying 0276. READ ONLY.
-- Shows the new index and, as proof that household size is not limited, the five biggest households.
-- Expected: one index row with the definition, and household sizes that are whatever they were before.

select what, name, detail
  from (
    select 1 as ord, 0 as size, 'index' as what, indexname::text as name, indexdef::text as detail
      from pg_indexes
     where schemaname = 'public' and tablename = 'household_members' and indexname = 'uq_household_members_one_active_self'
    union all
    select 2, count(*)::int, 'largest household', left(user_id::text, 8),
           count(*)::text || ' active members, of which ' || (count(*) filter (where relationship = 'self'))::text || ' self'
      from public.household_members
     where is_active
     group by user_id
  ) t
 order by ord, size desc
 limit 6;
