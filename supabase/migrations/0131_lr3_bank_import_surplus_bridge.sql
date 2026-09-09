-- LR-3 — Expenses/Income Bank Statement Workflow: surplus-calculation bridge.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Approved bank-statement transactions (fdh_transactions, approval_status =
-- 'approved') have had ZERO effect on Monthly Surplus, Net Worth or the
-- Dashboard until now — confirmed by direct discovery: dashboardData.ts and
-- lib/engines/dashboard.ts never read fdh_transactions at all. Wiring them
-- in (LR-3, Product Owner decision 2026-09-08) creates a real double-count
-- risk: a household that has BOTH a manually-entered "Groceries: $500/month"
-- row in expense_items AND real approved grocery-purchase transactions
-- flowing in from a linked bank account would otherwise have that same
-- real-world spending counted twice.
--
-- GUARD DESIGN — mirrors lib/engines/debtServiceContext.ts's own philosophy
-- exactly: an EXPLICIT, STRUCTURED, user-declared signal, never inferred
-- from free-text description/amount/fuzzy matching (the same rule PO-FI2-10
-- established for debt-service classification). A category-level automatic
-- reconciliation between individual dated bank transactions and recurring
-- budget-line items would require guessing which manual row corresponds to
-- which real-world merchant/category — exactly the kind of inference this
-- codebase's established rigor forbids. Instead: the user explicitly marks
-- a manual income_sources/expense_items row as "now tracked via bank import
-- instead" once they trust the bank feed for that category, and the
-- calculation excludes that row the moment the flag is set. Defaults FALSE
-- for every existing and new row, so no existing household's total changes
-- until they explicitly opt a row out.

alter table expense_items
  add column superseded_by_bank_import boolean not null default false;
comment on column expense_items.superseded_by_bank_import is
  'LR-3: true when the user has explicitly declared this manual budget-line item is now tracked via an approved bank-statement feed instead, so lib/engines/dashboard.ts must exclude it from totalMonthlyExpenses to avoid double-counting the same real-world spending. Never inferred — set only by explicit user action.';

alter table income_sources
  add column superseded_by_bank_import boolean not null default false;
comment on column income_sources.superseded_by_bank_import is
  'LR-3: true when the user has explicitly declared this manual income row is now tracked via an approved bank-statement/payslip feed instead, so income calculations must exclude it to avoid double-counting the same real-world income. Never inferred — set only by explicit user action.';
