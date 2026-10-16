-- READ ONLY. Production. Counts only: no names, no ids, no emails. Run on its own.
-- How many households have necessity expense rows with Essential off, split by whether the row was ever edited after creation.
-- This is only to size a possible back-fill for OTHER households (a separate decision); nothing here changes any data.
select
  case
    when e.source_type = 'manual' and e.updated_at <= e.created_at + interval '10 seconds' then 'untouched_since_creation'
    else 'edited_since_creation_or_imported'
  end as grp,
  count(*) as rows_with_essential_off,
  count(distinct e.user_id) as households
from public.expense_items e
where e.is_active
  and not e.is_essential
  and coalesce(e.owner, 'self') <> 'smsf'
  and e.master_item_key in ('rent', 'mortgage', 'council_rates', 'water_rates', 'water', 'electricity', 'gas', 'groceries', 'health_insurance', 'medical', 'pharmacy', 'fuel', 'public_transport', 'home_insurance', 'body_corporate', 'internet')
group by 1
order by 1;
