-- READ ONLY. Production. STEP 1 of 5 of the "necessities are Essential" back-fill for YOUR account only. Changes nothing.
-- The app does not record whether you ticked or unticked Essential on purpose, so this uses the only evidence there is:
--   group = untouched_since_creation : manual row, Essential still off, and never edited after it was created. These would be set.
--   group = edited_since_creation    : Essential off but the row was edited later. NOT changed (you may have decided on purpose).
-- Rows already Essential are listed as already_essential and are never touched. Look at the list before step 2.
-- would_change = yes only for untouched_since_creation. monthly_aud is the monthly amount after frequency and currency conversion.
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
)
select
  e.id as record_id,
  e.expense_name,
  e.master_item_key,
  e.frequency,
  e.currency_code,
  e.amount as amount_per_period,
  round((case e.currency_code when 'AUD' then e.amount when 'INR' then e.amount / (select rate from fx) end
    * case e.frequency when 'weekly' then 52.0 / 12 when 'fortnightly' then 26.0 / 12 when 'monthly' then 1 when 'quarterly' then 1.0 / 3 when 'annually' then 1.0 / 12 else 0 end)::numeric, 2) as monthly_aud,
  e.is_essential as essential_now,
  to_char(e.created_at, 'DD/MM/YYYY HH24:MI:SS') as created,
  to_char(e.updated_at, 'DD/MM/YYYY HH24:MI:SS') as last_edited,
  case
    when e.is_essential then 'already_essential'
    when e.source_type = 'manual' and e.updated_at <= e.created_at + interval '10 seconds' then 'untouched_since_creation'
    else 'edited_since_creation'
  end as grp,
  case when not e.is_essential and e.source_type = 'manual' and e.updated_at <= e.created_at + interval '10 seconds' then 'yes' else 'no' end as would_change
from expense_items e
where e.user_id = (select id from u)
  and e.is_active
  and coalesce(e.owner, 'self') <> 'smsf'
  and e.master_item_key in ('rent', 'mortgage', 'council_rates', 'water_rates', 'water', 'electricity', 'gas', 'groceries', 'health_insurance', 'medical', 'pharmacy', 'fuel', 'public_transport', 'home_insurance', 'body_corporate', 'internet')
order by would_change desc, monthly_aud desc nulls last;
