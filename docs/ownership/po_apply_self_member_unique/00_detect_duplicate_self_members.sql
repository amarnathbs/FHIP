-- File 00: which users have more than one ACTIVE self household member. READ ONLY.
-- Zero rows means migration 0276 can be applied. Any row is a user to fix by hand first (see the README).
-- Ids are cut to 8 characters, no names are shown.
-- The oldest row is listed first in ids8: it is the one the application keeps.

select left(user_id::text, 8) as user8,
       count(*) as active_self_rows,
       string_agg(left(id::text, 8), ' ' order by created_at, id) as ids8,
       min(created_at)::date as oldest_created,
       max(created_at)::date as newest_created
  from public.household_members
 where relationship = 'self' and is_active
 group by user_id
having count(*) > 1
 order by count(*) desc, user8;
