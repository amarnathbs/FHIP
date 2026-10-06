-- Files 04 and 08 (same query): the backfill PREVIEW counts as one visible grid. READ ONLY.
-- The shipped backfill script (file 05) prints these counts inside a transaction that ends
-- in ROLLBACK, and the SQL editor shows only the last result, so those counts are not visible
-- there. This query gives the same six numbers with the same conditions, changing nothing.
-- File 04 is run before the backfill. File 08 is the identical query run after it.
-- Expected on DEV today (read by Claude on 06-10-2026):
--   bank statements: total 6, will copy 0, will be marked legacy_unset 6
--   India CAS documents: total 4, will copy 2, will be marked legacy_unset 1
-- After the COMMIT (file 08): the three will-lines of each table must all be 0.

select 'fdh_statement_uploads: total' as what, count(*) as n
  from public.fdh_statement_uploads
union all
select 'fdh_statement_uploads: will copy the owner of the matched account', count(*)
  from public.fdh_statement_uploads u
  join public.fdh_financial_accounts a on a.id = u.financial_account_id and a.user_id = u.user_id
 where u.owner_selection_source is null and u.owner_role is null and a.owner_role is not null
union all
select 'fdh_statement_uploads: will be marked legacy_unset', count(*)
  from public.fdh_statement_uploads u
  left join public.fdh_financial_accounts a on a.id = u.financial_account_id and a.user_id = u.user_id
 where u.owner_selection_source is null and u.owner_role is null and a.owner_role is null
union all
select 'ii_source_documents: total', count(*)
  from public.ii_source_documents
union all
select 'ii_source_documents: will copy the owner member', count(*)
  from public.ii_source_documents d
  join public.household_members m on m.id = d.owner_member_id and m.user_id = d.user_id
 where d.owner_selection_source is null and d.owner_role is null
union all
select 'ii_source_documents: will be marked legacy_unset', count(*)
  from public.ii_source_documents d
 where d.owner_selection_source is null and d.owner_role is null and d.owner_member_id is null;
