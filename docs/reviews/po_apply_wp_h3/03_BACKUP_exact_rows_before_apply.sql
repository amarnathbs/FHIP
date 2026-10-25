-- WP-H3 pack 03 (BACKUP, writes only two new backup tables). Production has no managed backups: run this BEFORE pack 05.
-- It copies the exact rows that pack 05 will change, and the rows they are paired with, with all their columns and their source links.
-- The backup tables are named with the date. If a table already exists this file fails and changes nothing, which is intended.
--
-- The rows are chosen by RULE, not typed by hand. A newer row is chosen when an older row of the same statement, account, fund, date and
-- amount exists, both have no provider reference, both are still counted, they were written by different processing runs, and the newer
-- row was created inside the window below. Each older row is paired with at most one newer row, so two genuine same-day lines are never
-- both retired. Edit the config values (email, window, retire_which, max_rows) the same way in packs 03, 04 and 05.
-- retire_which is newer or older. Default newer: the rows the replacement run wrote are retired and the earlier rows stay.
begin;

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

create table ii_transactions_backup_wph3_20261025 as
select t.*, now() as backed_up_at
from ii_transactions t
where t.id in (select retire_id from wph3_chosen union select keep_id from wph3_chosen);

create table ii_transaction_source_links_backup_wph3_20261025 as
select l.*, now() as backed_up_at
from ii_transaction_source_links l
where l.transaction_id in (select retire_id from wph3_chosen union select keep_id from wph3_chosen);

commit;

-- Result: how many rows were saved. Expect twice the number of pairs in the transaction table.
select
  (select count(*) from wph3_chosen) as pairs_chosen,
  (select count(*) from ii_transactions_backup_wph3_20261025) as transaction_rows_saved,
  (select count(*) from ii_transaction_source_links_backup_wph3_20261025) as link_rows_saved;
