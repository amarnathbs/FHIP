-- 0276 -- At most ONE active self household member per user.
--
-- WHY. The owner selector calls POST /api/ownership/self when it opens. Two calls that start together
-- both looked for a self member, found none, and both inserted one: two rows 67 ms apart were seen on
-- DEV, and the selector then listed the user twice. The application now settles on the oldest row,
-- but only the database can make a duplicate impossible.
--
-- WHAT THIS DOES. Adds ONE partial unique index on (user_id), and ONLY for rows whose relationship
-- is self and which are active. Nothing else changes.
--   * Household size is NOT limited. Spouse, partner, child, parent, other_dependant and other rows
--     are outside the index, so a household of 6, 10 or more people works exactly as before.
--   * Removed members are untouched: removing a member sets is_active to false, and inactive rows
--     (self or not) are outside the index too, so any number of them may exist.
--   * No row is changed, merged or deleted by this migration.
--
-- SAFETY. If any user already has two or more active self rows, the guard below stops the migration
-- with a clear message and changes nothing. Run docs/ownership/po_apply_self_member_unique/00_detect
-- first (read only). Merging or deactivating duplicates is a deliberate human step, see the README
-- there: the extra rows may already be referenced by accounts, allocations or documents.
--
-- Additive, idempotent (safe to run twice), forward-only. No policy, trigger or column is touched.

do $guard$
begin
  if exists (
    select 1
      from public.household_members
     where relationship = 'self' and is_active
     group by user_id
    having count(*) > 1
  ) then
    raise exception '0276 refused: at least one user has more than one active self household member. Run the detection query, merge or deactivate the extra rows by hand, then run this migration again. Nothing was changed.';
  end if;
end
$guard$;

create unique index if not exists uq_household_members_one_active_self
  on public.household_members (user_id)
  where relationship = 'self' and is_active;

comment on index public.uq_household_members_one_active_self is
  'Owner-before-upload (0276): one active self household member per user. Other relationships and inactive rows are not restricted.';
