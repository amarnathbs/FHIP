-- =============================================================================
-- Owner-before-upload, PHASE 1 -- BACKFILL of the document-level owner.
--
-- STATUS: NOT APPLIED. Written for the Product Owner to REVIEW and RUN. Nothing
-- in the application runs this. It ends in ROLLBACK; change the last line to
-- COMMIT only after you have read the preview counts and the verification rows.
--
-- WHAT IT DOES (PO decision 5 -- no invention):
--   * fdh_statement_uploads (bank / credit card / loan statements): copies the
--     owner from the account the statement was matched to
--     (fdh_financial_accounts.owner_role, migration 0207). owner_member_id is
--     left NULL -- the account never recorded which member. Source is marked
--     'backfill_from_account'.
--   * ii_source_documents (India CAS): copies the owner from the document's
--     existing owner_member_id (household_members.relationship -> role, the same
--     mapping the application uses: self->self, spouse/partner->spouse,
--     child->child, anything else->other). Source is marked
--     'backfill_from_document'.
--   * Every document that still has no owner afterwards is marked 'legacy_unset'
--     so the next reader can tell "never recorded" from "not yet backfilled".
--
-- WHAT IT NEVER DOES: guess. A document whose account has no owner_role, or an
-- ii document with no owner_member_id, is NOT assigned to Self (or anyone); it
-- is marked legacy_unset and left for the user. It never touches an account, an
-- allocation, a reconciliation case or any financial row. Only rows that have
-- no owner_selection_source yet are touched, so it is safe to run twice (the
-- second run changes nothing) and it never overwrites a user-selected owner.
--
-- PRECONDITIONS: migration 0236 applied (owner columns exist) and migration 0207
-- applied (fdh_financial_accounts.owner_role exists). The guard below refuses to
-- run otherwise.
--
-- RUN IT ON DEV FIRST. Production is a separate, deliberate decision.
-- =============================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fdh_statement_uploads' and column_name = 'owner_selection_source')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ii_source_documents' and column_name = 'owner_selection_source') then
    raise exception 'backfill: migration 0236 (owner columns) is not applied -- stopping';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fdh_financial_accounts' and column_name = 'owner_role') then
    raise exception 'backfill: migration 0207 (fdh_financial_accounts.owner_role) is not applied -- stopping';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PREVIEW: what the backfill is about to do (read these before committing).
-- ---------------------------------------------------------------------------
select 'fdh_statement_uploads: total'                                   as what, count(*) as n from public.fdh_statement_uploads
union all
select 'fdh_statement_uploads: will copy owner from the matched account', count(*)
  from public.fdh_statement_uploads u
  join public.fdh_financial_accounts a on a.id = u.financial_account_id and a.user_id = u.user_id
 where u.owner_selection_source is null and u.owner_role is null and a.owner_role is not null
union all
select 'fdh_statement_uploads: will be marked legacy_unset', count(*)
  from public.fdh_statement_uploads u
  left join public.fdh_financial_accounts a on a.id = u.financial_account_id and a.user_id = u.user_id
 where u.owner_selection_source is null and u.owner_role is null and a.owner_role is null
union all
select 'ii_source_documents: total', count(*) from public.ii_source_documents
union all
select 'ii_source_documents: will copy owner from owner_member_id', count(*)
  from public.ii_source_documents d
  join public.household_members m on m.id = d.owner_member_id and m.user_id = d.user_id
 where d.owner_selection_source is null and d.owner_role is null
union all
select 'ii_source_documents: will be marked legacy_unset', count(*)
  from public.ii_source_documents d
 where d.owner_selection_source is null and d.owner_role is null and d.owner_member_id is null;

-- ---------------------------------------------------------------------------
-- 1. fdh_statement_uploads: owner from the matched account.
-- ---------------------------------------------------------------------------
update public.fdh_statement_uploads u
   set owner_role = a.owner_role,
       owner_selection_source = 'backfill_from_account'
  from public.fdh_financial_accounts a
 where a.id = u.financial_account_id
   and a.user_id = u.user_id
   and u.owner_selection_source is null
   and u.owner_role is null
   and a.owner_role is not null;

-- 2. fdh_statement_uploads: whatever is still without an owner is legacy_unset.
update public.fdh_statement_uploads
   set owner_selection_source = 'legacy_unset'
 where owner_selection_source is null
   and owner_role is null;

-- ---------------------------------------------------------------------------
-- 3. ii_source_documents: owner from the document's own owner_member_id.
-- ---------------------------------------------------------------------------
update public.ii_source_documents d
   set owner_role = case m.relationship
                      when 'self'    then 'self'
                      when 'spouse'  then 'spouse'
                      when 'partner' then 'spouse'
                      when 'child'   then 'child'
                      else 'other'
                    end,
       owner_selection_source = 'backfill_from_document'
  from public.household_members m
 where m.id = d.owner_member_id
   and m.user_id = d.user_id
   and d.owner_selection_source is null
   and d.owner_role is null;

-- 4. ii_source_documents: whatever is still without an owner is legacy_unset.
update public.ii_source_documents
   set owner_selection_source = 'legacy_unset'
 where owner_selection_source is null
   and owner_role is null;

-- ---------------------------------------------------------------------------
-- VERIFY: expect 'unbackfilled' = 0 on both tables.
-- ---------------------------------------------------------------------------
select 'fdh_statement_uploads' as tbl, coalesce(owner_selection_source, 'unbackfilled') as source, count(*) as n
  from public.fdh_statement_uploads group by 2
union all
select 'ii_source_documents', coalesce(owner_selection_source, 'unbackfilled'), count(*)
  from public.ii_source_documents group by 2
order by 1, 2;

-- Change to COMMIT only after reviewing the output above.
rollback;
