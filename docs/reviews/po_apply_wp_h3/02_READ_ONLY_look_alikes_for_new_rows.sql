-- WP-H3 pack 02 (READ ONLY). For the rows written by one processing run, shows the older rows of the same statement that look like them.
-- Use it for a row that pack 01 did not report, such as the 2009 reversal of 1,000.00: if an older row exists with the same date and
-- the same amount but a different type, or the same date and fund with a different amount, the new row is the same line read differently.
-- If nothing older is shown, the new row is a line the earlier parse never captured and is genuinely new.
-- Replace the placeholder email and the two times with the window printed by the PO oracle. Nothing is written.

with config as (
  select
    lower('REPLACE_WITH_ACCOUNT_EMAIL') as email,
    timestamptz '2026-10-25 00:33:00+00' as window_start,
    timestamptz '2026-10-25 00:34:00+00' as window_end
),
target as (
  select u.id as user_id from auth.users u, config c where lower(u.email) = c.email
),
fresh as (
  select t.*
  from ii_transactions t
  join target g on g.user_id = t.user_id
  where t.created_at between (select window_start from config) and (select window_end from config)
)
select
  f.id as new_row_id,
  f.transaction_date,
  f.transaction_type as new_type,
  f.gross_amount as new_amount,
  f.units as new_units,
  o.id as older_row_id,
  o.created_at as older_created_at,
  o.transaction_type as older_type,
  o.gross_amount as older_amount,
  o.units as older_units,
  case
    when o.gross_amount = f.gross_amount and o.transaction_type = f.transaction_type then 'same date, amount and type'
    when o.gross_amount = f.gross_amount then 'same date and amount, different type'
    when abs(o.gross_amount) = abs(f.gross_amount) then 'same date, opposite sign'
    else 'same date and fund, different amount'
  end as relation
from fresh f
left join ii_transactions o
  on o.user_id = f.user_id and o.account_id = f.account_id and o.instrument_id = f.instrument_id
 and o.transaction_date = f.transaction_date and o.id <> f.id and o.created_at < f.created_at
order by f.transaction_date, f.id, o.created_at;
