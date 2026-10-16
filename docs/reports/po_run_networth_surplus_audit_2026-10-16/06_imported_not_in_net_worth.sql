-- READ ONLY. Production. Lists the imported holdings behind "Imported, not yet in Net Worth: 17 items, $14,406". Changes nothing.
-- Run this one statement on its own. Output is masked: snapshot id, instrument name, units, value, as-of date (dd/mm/yyyy).
-- A holding is listed here when its latest statement snapshot has units above zero AND no investments record carries the same
-- account and instrument AND no published bridge record covers it. These are on the Investments tab but not in Net Worth.
-- Holdings in an account owned (even partly) by a trust, HUF or company are excluded by the app and are excluded here too.
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
),
snap as (
  select s.*,
    row_number() over (partition by s.account_id, s.instrument_id order by s.as_of_date desc, s.created_at desc) as rn
  from ii_holding_snapshots s
  where s.user_id = (select id from u)
),
latest as (
  select * from snap where rn = 1 and units > 0
),
published_pairs as (
  select v.ii_canonical_account_id as account_id, v.ii_canonical_instrument_id as instrument_id
  from investments v
  where v.user_id = (select id from u) and v.is_active
    and v.ii_canonical_account_id is not null and v.ii_canonical_instrument_id is not null
  union
  select s.account_id, s.instrument_id
  from ii_fhip_publications p
  join ii_holding_snapshots s on s.id = p.canonical_position_id
  where p.user_id = (select id from u) and p.status = 'published'
),
entity_accounts as (
  select distinct o.ii_account_id as account_id
  from ii_ownership_allocation o
  where o.user_id = (select id from u) and o.status = 'active'
    and o.owner_business_entity_id is not null and o.ii_instrument_id is null
)
select
  l.id as snapshot_id,
  l.account_id,
  l.instrument_id,
  l.units,
  l.currency_code,
  l.value as value_native,
  round((case l.currency_code when 'AUD' then l.value when 'INR' then l.value / (select rate from fx) end)::numeric, 2) as value_aud,
  to_char(l.as_of_date, 'DD/MM/YYYY') as as_of
from latest l
where not exists (select 1 from published_pairs p where p.account_id = l.account_id and p.instrument_id = l.instrument_id)
  and not exists (select 1 from entity_accounts e where e.account_id = l.account_id)
order by value_aud desc nulls last;
