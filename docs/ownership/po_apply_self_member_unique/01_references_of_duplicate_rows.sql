-- File 01: for each duplicate active self row, how many records point at it. READ ONLY.
-- Only needed when file 00 listed someone. A duplicate with every count at 0 can simply be deactivated.
-- A duplicate that is referenced must first be moved over to the oldest row (see the README).

with dup as (
  select id, user_id, created_at,
         row_number() over (partition by user_id order by created_at, id) as rank_in_user
    from public.household_members
   where relationship = 'self' and is_active
     and user_id in (select user_id
                       from public.household_members
                      where relationship = 'self' and is_active
                      group by user_id
                     having count(*) > 1)
)
select left(d.user_id::text, 8) as user8,
       left(d.id::text, 8) as member8,
       case when d.rank_in_user = 1 then 'KEEP (oldest)' else 'extra' end as role_of_row,
       (select count(*) from public.ii_accounts x where x.owner_member_id = d.id) as ii_accounts,
       (select count(*) from public.ii_ownership_allocation x where x.owner_member_id = d.id) as allocations,
       (select count(*) from public.ii_source_documents x where x.owner_member_id = d.id) as ii_documents,
       (select count(*) from public.fdh_statement_uploads x where x.owner_member_id = d.id) as bank_documents,
       (select count(*) from public.ii_fhip_publications x where x.owner_member_id = d.id) as publications,
       (select count(*) from public.user_goals x where x.owner_member_id = d.id or x.beneficiary_member_id = d.id) as goals
  from dup d
 order by user8, d.rank_in_user;
