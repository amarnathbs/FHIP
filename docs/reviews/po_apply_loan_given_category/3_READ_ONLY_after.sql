-- READ ONLY. Changes nothing. Run after the apply, on the same project.
-- Expected AFTER: exactly one row, economic_type = transfer, active = true.
select category_key, display_name, economic_type, display_order, active
  from fdh_categories
 where category_key = 'loan_given';
