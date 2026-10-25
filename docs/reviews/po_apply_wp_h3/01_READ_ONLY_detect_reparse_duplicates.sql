-- WP-H3 pack 01 (READ ONLY, production and DEV). Finds every group of transactions that look like a second copy of the same real line.
-- A group is: one statement, one account, one fund, one date, one amount, no provider reference, still counted in the figures,
-- and written by MORE THAN ONE processing run. Two genuine same-day purchases within a single run are not reported.
-- Nothing is written. Only identifiers, dates, amounts and units are returned.

-- Result 1: how many groups and how much extra money per account.
with groups as (
  select
    t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount,
    count(*) as counted_rows,
    count(distinct t.parse_run_id) as processing_runs
  from ii_transactions t
  where t.status <> 'reversed'
    and t.source_reference is null
    and t.source_document_id is not null
  group by t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount
  having count(*) > 1 and count(distinct t.parse_run_id) > 1
)
select
  user_id,
  account_id,
  count(*) as duplicate_groups,
  sum(counted_rows - 1) as extra_rows,
  sum((counted_rows - 1) * gross_amount) as extra_amount,
  min(transaction_date) as earliest_date,
  max(transaction_date) as latest_date
from groups
group by user_id, account_id
order by extra_rows desc;

-- Result 2: every row of every group, oldest first. Compare the rows of one group side by side.
-- consistent_units is true when units multiplied by the price matches the amount to within half a percent. A row whose units do not
-- agree with its own price was most likely read wrongly by an earlier parser.
with groups as (
  select
    t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount
  from ii_transactions t
  where t.status <> 'reversed'
    and t.source_reference is null
    and t.source_document_id is not null
  group by t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount
  having count(*) > 1 and count(distinct t.parse_run_id) > 1
)
select
  t.user_id,
  t.account_id,
  t.source_document_id,
  t.transaction_date,
  t.gross_amount,
  t.id as transaction_id,
  t.created_at,
  t.status,
  t.transaction_type,
  t.units,
  t.price_per_unit,
  (t.units is not null and t.price_per_unit is not null and abs(t.units * t.price_per_unit - t.gross_amount) <= abs(t.gross_amount) * 0.005) as consistent_units,
  left(t.transaction_fingerprint, 8) as fingerprint_start,
  t.parse_run_id
from ii_transactions t
join groups g
  on g.user_id = t.user_id and g.account_id = t.account_id and g.instrument_id = t.instrument_id
 and g.source_document_id = t.source_document_id and g.transaction_date = t.transaction_date and g.gross_amount = t.gross_amount
where t.status <> 'reversed'
  and t.source_reference is null
order by t.account_id, t.transaction_date, t.gross_amount, t.created_at, t.id;
