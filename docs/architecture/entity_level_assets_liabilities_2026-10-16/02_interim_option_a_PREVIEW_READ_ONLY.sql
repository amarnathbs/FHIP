-- 02 PREVIEW (READ ONLY) for interim option A: take the 503,000 SMSF fund row (owner self) out of the registers,
-- keep the 133,000 'Other Retirement Assets' row (owner smsf) as the fund's net balance.
-- Replace PUT_YOUR_LOGIN_EMAIL_HERE. Shows exactly the rows that 03_interim_option_a_APPLY.sql would archive.
-- Nothing is deleted by 03: rows are archived (is_active = false) and a full copy is kept for the rollback.
--
-- READ THIS FIRST: FHIP allows ONE SMSF fund row per person (unique user + master item 'smsf'). An archived fund
-- row therefore BLOCKS creating a new SMSF fund in the SMSF section until the planned fix (migration 0289 makes
-- fund creation reuse the archived row). Option B avoids that: set the fund's value to 0 in the SMSF section
-- (Retirement > SMSF > edit the summary value). It needs no SQL and is undone by typing the value back.
select r.id as retirement_row_id, r.account_name, r.owner, r.master_item_key, r.current_balance, r.currency_code, r.is_active,
       f.id as smsf_fund_id, f.mode, f.summary_balance, f.is_active as fund_active
from auth.users u
join retirement_accounts r on r.user_id = u.id
left join smsf_funds f on f.retirement_account_id = r.id
where lower(u.email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE')
  and r.master_item_key = 'smsf'
  and r.owner <> 'smsf'
  and r.is_active
order by r.created_at;
