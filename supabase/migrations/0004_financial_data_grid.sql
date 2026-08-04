-- Financial Data Grid: master item catalogue + owner/master-item linkage + category-specific columns.
-- Replaces the sequential "one item at a time" capture with a pre-populated, spreadsheet-style grid.

create table master_financial_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,          -- income|expense|asset|liability|investment|retirement|insurance
  item_key text not null,
  item_label text not null,
  sort_order int not null default 0,
  is_active boolean default true,
  unique (category, item_key)
);

alter table master_financial_items enable row level security;
create policy "read master items" on master_financial_items for select using (true);

create index idx_master_financial_items_category on master_financial_items(category, sort_order);

-- Owner is common to every register; allowed values enforced via check constraint.
-- master_item_key links a saved row back to its master item; null = user-defined custom row.
-- unique(user_id, master_item_key) lets an upsert resolve to "the row for this master item"
-- for a single POST call, while multiple NULLs (custom rows) stay unconstrained — Postgres
-- unique constraints never treat NULL as equal to NULL, so any number of custom rows is fine.

alter table income_sources
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column net_amount numeric(18,2) check (net_amount >= 0),
  add column is_taxable boolean not null default true,
  add column notes text,
  add constraint uq_income_sources_user_master unique (user_id, master_item_key);

alter table expense_items
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column is_essential boolean not null default false,
  add column notes text,
  add constraint uq_expense_items_user_master unique (user_id, master_item_key);

alter table assets
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column purchase_price numeric(18,2) check (purchase_price >= 0),
  add column purchase_date date,
  add column notes text,
  add constraint uq_assets_user_master unique (user_id, master_item_key);

alter table liabilities
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column lender text,
  add column notes text,
  add constraint uq_liabilities_user_master unique (user_id, master_item_key);

alter table investments
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column institution text,
  add column cost_base numeric(18,2) check (cost_base >= 0),
  add column annual_contribution numeric(18,2) check (annual_contribution >= 0),
  add column risk_profile text check (risk_profile in ('conservative','balanced','growth','high_growth','unknown')),
  add column notes text,
  add constraint uq_investments_user_master unique (user_id, master_item_key);

alter table retirement_accounts
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column employer_contribution numeric(18,2) check (employer_contribution >= 0),
  add column personal_contribution numeric(18,2) check (personal_contribution >= 0),
  add column contribution_frequency text,
  add column target_retirement_age int check (target_retirement_age > 0 and target_retirement_age < 120),
  add column notes text,
  add constraint uq_retirement_accounts_user_master unique (user_id, master_item_key);

alter table insurance_policies
  add column owner text not null default 'self'
    check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other')),
  add column master_item_key text,
  add column provider text,
  add column notes text,
  add constraint uq_insurance_policies_user_master unique (user_id, master_item_key);
