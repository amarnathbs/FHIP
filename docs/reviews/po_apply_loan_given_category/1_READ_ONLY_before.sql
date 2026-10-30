-- READ ONLY. Changes nothing. Run first, on DEV (check the project in the address bar), then again on PRODUCTION (twwpnltizhtjxhamyoxt).
-- Expected BEFORE the migration: zero rows.
select category_key, display_name, economic_type, active
  from fdh_categories
 where category_key = 'loan_given';
