-- B1 manual backup of the exact tables the synthetic production verification writes to.
-- Production has no managed backups, so this is the restore point. Run it BEFORE the first synthetic upload (not before
-- the three migrations: those only add new objects and change no existing table).
-- The copies live in the private schema, which the API never serves, and row level security is switched on with every
-- API privilege revoked, so a draft that is private in the real table is not exposed through the copy.
-- Safe to run twice: each copy is created only if it does not exist yet. To make a fresh copy, run B3_drop_backups.sql first.
-- Look at P0 section D first: it shows the size of the audit table. If resource_audit_log is larger than about 200 MB,
-- skip step 6 and tell the developer (the database is over its plan size and a big copy could hurt).

-- 1 of 6: the posts table (this is where the two synthetic drafts will be written)
create table if not exists private.bkp_bulkupload_resource_posts as table public.resource_posts;

-- 2 of 6: category links
create table if not exists private.bkp_bulkupload_resource_post_categories as table public.resource_post_categories;

-- 3 of 6: tag links
create table if not exists private.bkp_bulkupload_resource_post_tags as table public.resource_post_tags;

-- 4 of 6: sources (the verification adds two synthetic sources)
create table if not exists private.bkp_bulkupload_resource_sources as table public.resource_sources;

-- 5 of 6: post to source links
create table if not exists private.bkp_bulkupload_resource_post_sources as table public.resource_post_sources;

-- 6 of 6: the audit table (the apply adds rows, the cleanup removes only the synthetic ones)
create table if not exists private.bkp_bulkupload_resource_audit_log as table public.resource_audit_log;

-- Lock all six copies so that the API cannot reach them.
alter table private.bkp_bulkupload_resource_posts enable row level security;
alter table private.bkp_bulkupload_resource_post_categories enable row level security;
alter table private.bkp_bulkupload_resource_post_tags enable row level security;
alter table private.bkp_bulkupload_resource_sources enable row level security;
alter table private.bkp_bulkupload_resource_post_sources enable row level security;
alter table private.bkp_bulkupload_resource_audit_log enable row level security;
revoke all on private.bkp_bulkupload_resource_posts from public, anon, authenticated;
revoke all on private.bkp_bulkupload_resource_post_categories from public, anon, authenticated;
revoke all on private.bkp_bulkupload_resource_post_tags from public, anon, authenticated;
revoke all on private.bkp_bulkupload_resource_sources from public, anon, authenticated;
revoke all on private.bkp_bulkupload_resource_post_sources from public, anon, authenticated;
revoke all on private.bkp_bulkupload_resource_audit_log from public, anon, authenticated;
