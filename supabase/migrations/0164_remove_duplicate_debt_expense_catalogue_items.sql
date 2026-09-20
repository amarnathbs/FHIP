-- PO instruction, 2026-09-20: a mortgage's repayment is already captured via
-- the Liabilities register's own monthly_repayment/EMI logic, which already
-- feeds both Monthly Surplus and Net Worth (dashboard.ts). The Expense
-- catalogue's 'mortgage'/'car_loan_repayments' items looked like a second,
-- independent place to enter the same repayment -- confusing, and only
-- SAFE from actually double-counting today because of a separate guard
-- (lib/engines/debtServiceContext.ts's isDuplicateDebtServiceExpense) that
-- strips a matching Expense row once a same-family Liability with a real
-- repayment is on file. That guard is real and stays unchanged; it is not
-- what this migration touches.
--
-- This migration only removes the two Expense-catalogue items that
-- represent a debt repayment, so a user is never offered a data-entry point
-- that looks like a second, separate place to record what the Liabilities
-- register already tracks. This matches a standing Product Owner ruling
-- already in the codebase (PO-FI2-09, debtServiceContext.ts's own header:
-- "Do NOT add personal-loan or credit-card repayment items to the Expense
-- catalogue") -- this migration is the same ruling applied to the two
-- pre-existing items it never went back to remove.
--
-- Soft-disabled (is_active = false), not deleted: this table's own schema
-- (migration 0004) treats is_active as the intended on/off switch, the
-- dropdown query (lib/services/masterItems.ts) already filters on it, and
-- keeping the row lets this be reversed by a single UPDATE if ever needed.
-- Any expense row a user already entered against 'mortgage'/
-- 'car_loan_repayments' keeps its own stored expense_name and is
-- completely unaffected -- this only removes the two items from being
-- offered again to a NEW "Add Expense" selection.

-- Run BEFORE applying, and record the count (expect 2):
--   select category, item_key, item_label, is_active from master_financial_items
--   where category = 'expense' and item_key in ('mortgage', 'car_loan_repayments');

update master_financial_items
set is_active = false
where category = 'expense'
  and item_key in ('mortgage', 'car_loan_repayments');

-- Run AFTER applying, and confirm both rows now show is_active = false:
--   select category, item_key, item_label, is_active from master_financial_items
--   where category = 'expense' and item_key in ('mortgage', 'car_loan_repayments');
