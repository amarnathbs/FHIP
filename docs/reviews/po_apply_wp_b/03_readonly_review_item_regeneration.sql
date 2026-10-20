-- WP-B pack 03 (READ ONLY, DEV first). Shows Review items that were dismissed and then raised again.
-- Before the fix, a dismissed item came back as a new open row on the next refresh. After the fix this returns no new rows.
-- Nothing is written. Replace the placeholder email, then run the whole file.

with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
)
select
  r.identity_key,
  count(*) as rows_for_this_item,
  count(*) filter (where r.status = 'dismissed') as dismissed_rows,
  count(*) filter (where r.status in ('open', 'acknowledged')) as live_rows,
  min(r.created_at) as first_raised,
  max(r.created_at) as last_raised
from ii_review_items r
join target t on t.user_id = r.user_id
where r.rule_key = 'reconciliation_open'
group by r.identity_key
having count(*) filter (where r.status = 'dismissed') > 0 and count(*) filter (where r.status in ('open', 'acknowledged')) > 0
order by rows_for_this_item desc;
