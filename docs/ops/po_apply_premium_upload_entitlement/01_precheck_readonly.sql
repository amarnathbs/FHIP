-- Premium Upload Entitlement -- READ-ONLY pre-check (production or DEV). Changes nothing.
-- Run each statement on its own in the Supabase SQL editor and keep the output with the evidence.

-- 1. How many accounts are on each plan right now (counts only, no personal data).
select plan_tier, count(*) as accounts
  from public.user_entitlements
 group by plan_tier
 order by plan_tier;

-- 2. The shape the release relies on: one row per user, tier text, date window.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'user_entitlements'
   and column_name in ('user_id', 'plan_tier', 'effective_from', 'effective_to')
 order by column_name;

-- 3. The own-row read policy the capability depends on (it reads the caller's own row with the session client).
select policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename = 'user_entitlements';

-- 4. The customer document buckets are private and grant authenticated users no write.
select policyname, cmd
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and (qual like '%fdh-source-documents%' or qual like '%investment-source-documents%' or with_check like '%fdh-source-documents%' or with_check like '%investment-source-documents%');

-- 5. Baseline for the post-release comparison: customer documents admitted so far.
select count(*) as documents_total, max(created_at) as latest_document_at
  from public.fdh_statement_uploads;
