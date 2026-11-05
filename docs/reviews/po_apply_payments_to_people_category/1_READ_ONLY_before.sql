-- READ ONLY. Changes nothing. Run first, on DEV, then again on PRODUCTION (twwpnltizhtjxhamyoxt). Expected BEFORE the apply: zero rows.
select category_key, display_name, economic_type, active
  from fdh_categories
 where category_key = 'payments_to_people';
