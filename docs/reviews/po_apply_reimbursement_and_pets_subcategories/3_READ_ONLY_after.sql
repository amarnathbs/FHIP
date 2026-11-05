-- READ ONLY. Changes nothing. Run after the apply, on the same project. Expected AFTER: exactly two rows, both active = true.
select c.category_key, s.subcategory_key, s.display_name, s.display_order, s.active
  from fdh_subcategories s
  join fdh_categories c on c.id = s.category_id
 where (c.category_key = 'refund_reversal' and s.subcategory_key = 'reimbursement')
    or (c.category_key = 'lifestyle' and s.subcategory_key = 'pets');
