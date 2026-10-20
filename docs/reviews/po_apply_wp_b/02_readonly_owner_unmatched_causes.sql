-- WP-B pack 02 (READ ONLY, DEV first). Why are there so many owner unmatched rows, and how many will the app close by itself.
-- Nothing is written. Replace the placeholder email, then run the whole file. Three result sets come back in order.

-- Result 1: all owner unmatched cases by status and how they were closed.
with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
)
select c.status, coalesce(c.resolution_method, 'none') as resolution_method, count(*) as cases
from ii_reconciliation_cases c
join target t on t.user_id = c.user_id
where c.discrepancy_type = 'owner_unmatched'
group by c.status, coalesce(c.resolution_method, 'none')
order by cases desc;

-- Result 2: repeats. One account should carry one case per statement. More than one means reprocessing opened it again.
with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
)
select
  c.source_document_id,
  c.subject_id as account_id,
  count(*) as cases_for_this_account_and_statement,
  count(*) filter (where c.status in ('open', 'user_reviewing')) as still_open,
  min(c.opened_at) as first_opened,
  max(c.opened_at) as last_opened
from ii_reconciliation_cases c
join target t on t.user_id = c.user_id
where c.discrepancy_type = 'owner_unmatched'
group by c.source_document_id, c.subject_id
having count(*) > 1
order by cases_for_this_account_and_statement desc;

-- Result 3: OPEN owner unmatched cases split by whether a person already chose the owner of that account.
-- explicit_owner true means the app will close the case on the next Review open (method auto_resolved_existing_owner).
-- explicit_owner false means nobody chose yet, the case stays open, and nothing is ever guessed or set to Self.
with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
)
select
  (a.owner_member_id is not null
    or exists (
      select 1 from ii_ownership_allocation al
      where al.ii_account_id = a.id and al.status = 'active' and al.ii_instrument_id is null
    )) as explicit_owner,
  count(*) as open_cases,
  count(distinct c.subject_id) as distinct_accounts
from ii_reconciliation_cases c
join target t on t.user_id = c.user_id
left join ii_accounts a on a.id = c.subject_id
where c.discrepancy_type = 'owner_unmatched' and c.status in ('open', 'user_reviewing')
group by 1
order by 1 desc;
