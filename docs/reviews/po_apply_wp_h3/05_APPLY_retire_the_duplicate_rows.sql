-- WP-H3 pack 05 (APPLY, DEV first). Retires the chosen rows by setting their status to reversed, the same soft and audited exclusion that
-- every ledger reader already honours. Nothing is deleted. The rows, their links and their history stay, and pack 07 puts them back.
-- Run pack 03 (backup) and pack 04 (preview) first, with the same config values. The code release that makes the unit check ignore
-- reversed rows must be deployed first. Everything runs in one transaction: if any guard fails nothing is changed.
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

do $wph3$
declare
  v_chosen int;
  v_max int;
  v_backed int;
  v_active int;
  v_changed int;
begin
  select count(*), coalesce(max(max_rows), 0) into v_chosen, v_max from wph3_chosen;
  if v_chosen = 0 then
    raise exception 'WP-H3: no rows match the rule, nothing was changed';
  end if;
  if v_chosen > v_max then
    raise exception using message = 'WP-H3: ' || v_chosen::text || ' rows match but the limit is ' || v_max::text || ', nothing was changed';
  end if;
  select count(*) into v_backed from ii_transactions_backup_wph3_20261025 b where b.id in (select retire_id from wph3_chosen);
  if v_backed <> v_chosen then
    raise exception using message = 'WP-H3: the backup does not hold every row to change (' || v_backed::text || ' of ' || v_chosen::text || '), run pack 03 first';
  end if;
  select count(*) into v_active from ii_transactions t where t.id in (select retire_id from wph3_chosen) and t.status <> 'reversed';
  if v_active <> v_chosen then
    raise exception 'WP-H3: some chosen rows are already reversed, nothing was changed';
  end if;

  update ii_transactions t set status = 'reversed' where t.id in (select retire_id from wph3_chosen) and t.status <> 'reversed';
  get diagnostics v_changed = row_count;
  if v_changed <> v_chosen then
    raise exception using message = 'WP-H3: changed ' || v_changed::text || ' rows but expected ' || v_chosen::text || ', rolled back';
  end if;

  insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, metadata)
  select c.user_id, 'admin_correction', 'ii_transactions', c.retire_id, 'admin',
         jsonb_build_object('kind', 'wph3_duplicate_retired', 'kept_transaction_id', c.keep_id, 'retired', c.retire_which, 'backup_table', 'ii_transactions_backup_wph3_20261025')
  from wph3_chosen c;
end
$wph3$;

commit;

-- Result: rows retired by this run.
select count(*) as rows_retired from ii_audit_events where event_type = 'admin_correction' and metadata ->> 'kind' = 'wph3_duplicate_retired' and created_at > now() - interval '5 minutes';
