-- READ ONLY. Production. Lists every active income record behind the report income figures. Changes nothing.
-- Run this one statement on its own in the Supabase SQL editor (production project).
-- Output is masked: record id, name as shown on the Income page, no email, no personal identifiers.
-- Reporting currency is taken as AUD (as on the report). INR rows are converted at the live AUD/INR rate.
-- counted_in_report = yes when the record feeds the report gross figure (not SMSF-owned, not superseded by bank import, currency convertible).
-- net_known = no means take-home pay is blank on the record: it adds to gross but NOT to net income (this is the suspected cause).
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
),
r as (
  select i.*,
    case i.frequency
      when 'weekly' then 52.0/12 when 'fortnightly' then 26.0/12 when 'monthly' then 1
      when 'quarterly' then 1.0/3 when 'annually' then 1.0/12 when 'one_off' then 0 else null end as mult
  from income_sources i
  where i.user_id = (select id from u) and i.is_active
)
select
  r.id as record_id,
  r.source_name,
  r.master_item_key,
  r.income_type,
  coalesce(r.owner, 'self') as owner,
  r.source_type,
  r.frequency,
  r.currency_code,
  r.amount as gross_amount_per_period,
  r.net_amount as net_amount_per_period,
  round((case r.currency_code when 'AUD' then r.amount * r.mult when 'INR' then r.amount * r.mult / (select rate from fx) end)::numeric, 2) as gross_monthly_aud,
  round((case r.currency_code when 'AUD' then r.net_amount * r.mult when 'INR' then r.net_amount * r.mult / (select rate from fx) end)::numeric, 2) as net_monthly_aud,
  case when r.net_amount is null then 'no' else 'yes' end as net_known,
  case when coalesce(r.owner, 'self') = 'smsf' or r.superseded_by_bank_import or r.currency_code not in ('AUD', 'INR') or r.mult is null then 'no' else 'yes' end as counted_in_report,
  r.superseded_by_bank_import,
  r.updated_at::date as last_updated
from r
order by gross_monthly_aud desc nulls last;
