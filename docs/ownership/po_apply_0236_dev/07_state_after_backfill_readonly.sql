-- File 07: owner state of every document after the backfill. READ ONLY.
-- No personal data: ids are cut to the first 8 characters.
-- Expected on DEV (read by Claude on 06-10-2026, before the backfill):
--   fdh_statement_uploads: legacy_unset 6
--   ii_source_documents:   backfill_from_document 2 (role self), legacy_unset 1, user_selected 1 (role self, untouched)
-- Rules this proves: nothing is left unbackfilled, no document with no recorded owner became Self,
-- and the user_selected row is unchanged.

select 'fdh_statement_uploads' as tbl,
       coalesce(owner_selection_source, 'unbackfilled') as source,
       coalesce(owner_role, '(no role)') as role,
       count(*) as n,
       string_agg(left(id::text, 8), ' ' order by id) as first8_of_ids
  from public.fdh_statement_uploads
 group by 2, 3
union all
select 'ii_source_documents',
       coalesce(owner_selection_source, 'unbackfilled'),
       coalesce(owner_role, '(no role)'),
       count(*),
       string_agg(left(id::text, 8), ' ' order by id)
  from public.ii_source_documents
 group by 2, 3
order by 1, 2, 3;
