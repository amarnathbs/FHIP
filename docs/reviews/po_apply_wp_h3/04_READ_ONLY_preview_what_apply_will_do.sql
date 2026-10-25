-- WP-H3 pack 04 (READ ONLY except for a temporary list that vanishes at the end of the session). Shows exactly what pack 05 will change.
-- Check every pair: the row to retire and the row to keep must be the same real line. The units, price and consistent_units columns
-- tell you which of the two was read correctly. If the row to keep is the wrongly read one, set retire_which to older and run again.
-- The rows are chosen by the same rule as in pack 03. Use the same config values.

create temp table wph3_chosen as
with config as (
  select
    lower('REPLACE_WITH_ACCOUNT_EMAIL') as email,
    timestamptz '2026-10-25 00:33:00+00' as window_start,
    timestamptz '2026-10-25 00:34:00+00' as window_end,
    'newer'::text as retire_which,
    20::int as max_rows
),
target as (
  select u.id as user_id from auth.users u, config c where lower(u.email) = c.email
),
live as (
  select t.*
  from ii_transactions t
  join target g on g.user_id = t.user_id
  where t.status <> 'reversed' and t.source_reference is null and t.source_document_id is not null
),
candidate as (
  select
    n.id as newer_id, o.id as older_id, n.user_id,
    row_number() over (partition by n.id order by o.created_at, o.id) as per_newer,
    row_number() over (partition by o.id order by n.created_at, n.id) as per_older
  from live n
  join live o
    on o.user_id = n.user_id and o.account_id = n.account_id and o.instrument_id = n.instrument_id
   and o.source_document_id = n.source_document_id and o.transaction_date = n.transaction_date
   and o.gross_amount = n.gross_amount and o.id <> n.id and o.created_at < n.created_at
   and o.parse_run_id is distinct from n.parse_run_id
  where n.created_at between (select window_start from config) and (select window_end from config)
),
paired as (
  select newer_id, older_id, user_id from candidate where per_newer = 1 and per_older = 1
)
select
  case when (select retire_which from config) = 'older' then p.older_id else p.newer_id end as retire_id,
  case when (select retire_which from config) = 'older' then p.newer_id else p.older_id end as keep_id,
  p.user_id,
  (select retire_which from config) as retire_which,
  (select max_rows from config) as max_rows
from paired p;

-- Result 1: the pairs.
select
  r.transaction_date, r.gross_amount, r.account_id,
  r.id as retire_id, r.created_at as retire_created, r.transaction_type as retire_type, r.units as retire_units, r.price_per_unit as retire_price,
  (r.units is not null and r.price_per_unit is not null and abs(r.units * r.price_per_unit - r.gross_amount) <= abs(r.gross_amount) * 0.005) as retire_consistent_units,
  k.id as keep_id, k.created_at as keep_created, k.transaction_type as keep_type, k.units as keep_units, k.price_per_unit as keep_price,
  (k.units is not null and k.price_per_unit is not null and abs(k.units * k.price_per_unit - k.gross_amount) <= abs(k.gross_amount) * 0.005) as keep_consistent_units
from wph3_chosen c
join ii_transactions r on r.id = c.retire_id
join ii_transactions k on k.id = c.keep_id
order by r.transaction_date, r.id;

-- Result 2: the effect on each position. Units and amount counted now and counted after the retirement. After you press Re-evaluate all
-- positions the units counted should reconcile to the statement closing balance.
select
  t.account_id, t.instrument_id,
  sum(t.units) filter (where t.status <> 'reversed') as units_counted_now,
  sum(t.units) filter (where t.status <> 'reversed' and t.id not in (select retire_id from wph3_chosen)) as units_counted_after,
  sum(t.gross_amount) filter (where t.status <> 'reversed') as amount_counted_now,
  sum(t.gross_amount) filter (where t.status <> 'reversed' and t.id not in (select retire_id from wph3_chosen)) as amount_counted_after,
  count(*) filter (where t.id in (select retire_id from wph3_chosen)) as rows_retired
from ii_transactions t
where (t.account_id, t.instrument_id) in (select x.account_id, x.instrument_id from ii_transactions x where x.id in (select retire_id from wph3_chosen))
group by t.account_id, t.instrument_id
order by rows_retired desc;

-- Result 3: the guard figures pack 05 enforces. pairs_chosen must be between 1 and max_rows.
select (select count(*) from wph3_chosen) as pairs_chosen, (select max(max_rows) from wph3_chosen) as max_rows;
