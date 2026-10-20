-- WP-C backup. Run on DEV first, then on production before the migrations.
-- Production has no managed backups, so this copy is the only safety net for these tables.
-- The migrations 0295 to 0297 only ADD columns, tables and triggers and change no existing row,
-- so this backup is a precaution, not a requirement of the migrations themselves.
-- Safe to run twice (it keeps the first copy and does not overwrite it).
-- Each copy has row level security switched on with no policy, so nobody can read it through the app.

create table if not exists backup_wpc_20261021_smsf_funds as select * from smsf_funds;
create table if not exists backup_wpc_20261021_smsf_holdings as select * from smsf_holdings;
create table if not exists backup_wpc_20261021_smsf_liabilities as select * from smsf_liabilities;
create table if not exists backup_wpc_20261021_business_entities as select * from business_entities;
create table if not exists backup_wpc_20261021_business_entity_assets as select * from business_entity_assets;
create table if not exists backup_wpc_20261021_business_entity_liabilities as select * from business_entity_liabilities;
create table if not exists backup_wpc_20261021_income_tagged_smsf as select * from income_sources where owner = 'smsf';
create table if not exists backup_wpc_20261021_expenses_tagged_smsf as select * from expense_items where owner = 'smsf';
create table if not exists backup_wpc_20261021_liabilities_tagged_smsf as select * from liabilities where owner = 'smsf';

alter table backup_wpc_20261021_smsf_funds enable row level security;
alter table backup_wpc_20261021_smsf_holdings enable row level security;
alter table backup_wpc_20261021_smsf_liabilities enable row level security;
alter table backup_wpc_20261021_business_entities enable row level security;
alter table backup_wpc_20261021_business_entity_assets enable row level security;
alter table backup_wpc_20261021_business_entity_liabilities enable row level security;
alter table backup_wpc_20261021_income_tagged_smsf enable row level security;
alter table backup_wpc_20261021_expenses_tagged_smsf enable row level security;
alter table backup_wpc_20261021_liabilities_tagged_smsf enable row level security;

select 'backup_wpc_20261021_smsf_funds' as copy, count(*)::text as rows_kept from backup_wpc_20261021_smsf_funds
union all select 'backup_wpc_20261021_smsf_holdings', count(*)::text from backup_wpc_20261021_smsf_holdings
union all select 'backup_wpc_20261021_smsf_liabilities', count(*)::text from backup_wpc_20261021_smsf_liabilities
union all select 'backup_wpc_20261021_business_entities', count(*)::text from backup_wpc_20261021_business_entities
union all select 'backup_wpc_20261021_business_entity_assets', count(*)::text from backup_wpc_20261021_business_entity_assets
union all select 'backup_wpc_20261021_business_entity_liabilities', count(*)::text from backup_wpc_20261021_business_entity_liabilities
union all select 'backup_wpc_20261021_income_tagged_smsf', count(*)::text from backup_wpc_20261021_income_tagged_smsf
union all select 'backup_wpc_20261021_expenses_tagged_smsf', count(*)::text from backup_wpc_20261021_expenses_tagged_smsf
union all select 'backup_wpc_20261021_liabilities_tagged_smsf', count(*)::text from backup_wpc_20261021_liabilities_tagged_smsf;
