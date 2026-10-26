-- B. BACKUP of every table the migrations or the cutover touch. Run in the PRODUCTION SQL editor AFTER A and BEFORE any migration.
-- Production has NO managed backups, so these copies are the safety net. Safe to run twice: it keeps the FIRST copy and never overwrites it.
-- The migrations only ADD columns, tables, functions and triggers and change no existing row, so the copies are a precaution. The cutover
-- (cutover folder) changes the SMSF rows and keeps its own exact-row copies as well (C1).
-- Every copy has row level security switched on with no policy, so nobody can read it through the app. Drop them once the release is accepted.
-- One transaction. If the database refuses to create a table (size limit), nothing is created and you must stop.

begin;

create table if not exists bk_er_20261026_smsf_funds as select * from smsf_funds;
create table if not exists bk_er_20261026_smsf_holdings as select * from smsf_holdings;
create table if not exists bk_er_20261026_smsf_fund_members as select * from smsf_fund_members;
create table if not exists bk_er_20261026_property_liability_links as select * from property_liability_links;
create table if not exists bk_er_20261026_business_entities as select * from business_entities;
create table if not exists bk_er_20261026_business_entity_assets as select * from business_entity_assets;
create table if not exists bk_er_20261026_business_entity_liabilities as select * from business_entity_liabilities;
create table if not exists bk_er_20261026_retirement_accounts as select * from retirement_accounts;
create table if not exists bk_er_20261026_user_financial_section_status as select * from user_financial_section_status;
create table if not exists bk_er_20261026_user_profiles_retirement_flag as select user_id, not_applicable_retirement from user_profiles;
create table if not exists bk_er_20261026_liabilities_tagged_smsf as select * from liabilities where owner = 'smsf';
create table if not exists bk_er_20261026_income_tagged_smsf as select * from income_sources where owner = 'smsf';
create table if not exists bk_er_20261026_expenses_tagged_smsf as select * from expense_items where owner = 'smsf';

alter table bk_er_20261026_smsf_funds enable row level security;
alter table bk_er_20261026_smsf_holdings enable row level security;
alter table bk_er_20261026_smsf_fund_members enable row level security;
alter table bk_er_20261026_property_liability_links enable row level security;
alter table bk_er_20261026_business_entities enable row level security;
alter table bk_er_20261026_business_entity_assets enable row level security;
alter table bk_er_20261026_business_entity_liabilities enable row level security;
alter table bk_er_20261026_retirement_accounts enable row level security;
alter table bk_er_20261026_user_financial_section_status enable row level security;
alter table bk_er_20261026_user_profiles_retirement_flag enable row level security;
alter table bk_er_20261026_liabilities_tagged_smsf enable row level security;
alter table bk_er_20261026_income_tagged_smsf enable row level security;
alter table bk_er_20261026_expenses_tagged_smsf enable row level security;

commit;

-- Read this: every copy and how many rows it holds against the live table (the two numbers must match on the first run).
select 'smsf_funds' as table_name, (select count(*) from smsf_funds) as live_rows, (select count(*) from bk_er_20261026_smsf_funds) as copied_rows
union all select 'smsf_holdings', (select count(*) from smsf_holdings), (select count(*) from bk_er_20261026_smsf_holdings)
union all select 'smsf_fund_members', (select count(*) from smsf_fund_members), (select count(*) from bk_er_20261026_smsf_fund_members)
union all select 'property_liability_links', (select count(*) from property_liability_links), (select count(*) from bk_er_20261026_property_liability_links)
union all select 'business_entities', (select count(*) from business_entities), (select count(*) from bk_er_20261026_business_entities)
union all select 'business_entity_assets', (select count(*) from business_entity_assets), (select count(*) from bk_er_20261026_business_entity_assets)
union all select 'business_entity_liabilities', (select count(*) from business_entity_liabilities), (select count(*) from bk_er_20261026_business_entity_liabilities)
union all select 'retirement_accounts', (select count(*) from retirement_accounts), (select count(*) from bk_er_20261026_retirement_accounts)
union all select 'user_financial_section_status', (select count(*) from user_financial_section_status), (select count(*) from bk_er_20261026_user_financial_section_status)
union all select 'user_profiles (retirement flag only)', (select count(*) from user_profiles), (select count(*) from bk_er_20261026_user_profiles_retirement_flag)
union all select 'liabilities tagged SMSF', (select count(*) from liabilities where owner = 'smsf'), (select count(*) from bk_er_20261026_liabilities_tagged_smsf)
union all select 'income tagged SMSF', (select count(*) from income_sources where owner = 'smsf'), (select count(*) from bk_er_20261026_income_tagged_smsf)
union all select 'expenses tagged SMSF', (select count(*) from expense_items where owner = 'smsf'), (select count(*) from bk_er_20261026_expenses_tagged_smsf);
