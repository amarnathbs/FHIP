-- Files 01 and 03 (same query): schema inventory for migration 0236, owner-before-upload. READ ONLY.
-- Run it BEFORE the migration (as file 01) and AFTER running it twice (as file 03).
-- Both files are the same query. The last row is a FINGERPRINT of everything above
-- it, so before and after can be compared by looking at one value.
-- Expected on a database that already has 0236: 12 column rows (11 new plus owner_member_id from 0032), 13 constraints, 2 triggers,
-- 2 functions, 4 owner foreign keys (3 new plus the one from 0032), and a row-security line for each of the 3 tables.
-- Paste the whole result grid back as text (it has no personal data).

with inv as (
  select 'column' as kind,
         c.table_name || '.' || c.column_name as name,
         c.data_type || ' / nullable=' || c.is_nullable as detail
    from information_schema.columns c
   where c.table_schema = 'public'
     and ((c.table_name = 'fdh_statement_uploads' and c.column_name in ('owner_member_id', 'owner_business_entity_id', 'owner_role', 'owner_selection_source', 'owner_allocation'))
       or (c.table_name = 'ii_source_documents' and c.column_name in ('owner_member_id', 'owner_business_entity_id', 'owner_role', 'owner_selection_source', 'owner_allocation', 'owner_review'))
       or (c.table_name = 'aie_document_intake' and c.column_name = 'owner_selection'))
  union all
  select 'constraint',
         k.conrelid::regclass::text || '.' || k.conname,
         pg_get_constraintdef(k.oid)
    from pg_constraint k
   where right(k.conname, 4) = '0236'
  union all
  select 'foreign_key',
         k.conrelid::regclass::text || '.' || k.conname,
         pg_get_constraintdef(k.oid)
    from pg_constraint k
   where k.contype = 'f'
     and k.conrelid in ('public.fdh_statement_uploads'::regclass, 'public.ii_source_documents'::regclass)
     and strpos(pg_get_constraintdef(k.oid), 'owner_') > 0
  union all
  select 'trigger',
         t.tgrelid::regclass::text || '.' || t.tgname,
         'enabled=' || t.tgenabled::text || ' / function=' || t.tgfoid::regproc::text
    from pg_trigger t
   where right(t.tgname, 10) = 'owner_0236'
     and not t.tgisinternal
  union all
  select 'function',
         p.proname,
         'volatility=' || p.provolatile::text || ' / security_definer=' || p.prosecdef::text
           || ' / config=' || coalesce(array_to_string(p.proconfig, ','), 'none')
           || ' / anon_can_run=' || has_function_privilege('anon', p.oid, 'execute')::text
           || ' / authenticated_can_run=' || has_function_privilege('authenticated', p.oid, 'execute')::text
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('owner_before_upload_allocation_ok', 'owner_before_upload_assert_owner')
  union all
  select 'rls',
         r.relname,
         'row_security=' || r.relrowsecurity::text || ' / policies=' || (select count(*) from pg_policies pp where pp.schemaname = 'public' and pp.tablename = r.relname)::text
    from pg_class r
   where r.relnamespace = 'public'::regnamespace
     and r.relname in ('fdh_statement_uploads', 'ii_source_documents', 'aie_document_intake')
  union all
  select 'index',
         i.tablename || '.' || i.indexname,
         'defined'
    from pg_indexes i
   where i.schemaname = 'public'
     and i.tablename in ('fdh_statement_uploads', 'ii_source_documents', 'aie_document_intake')
)
select kind, name, detail
  from inv
union all
select 'FINGERPRINT', 'md5 of every row above', md5(string_agg(kind || '|' || name || '|' || detail, chr(10) order by kind, name, detail))
  from inv
order by 1, 2;
