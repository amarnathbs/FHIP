-- A01 READ-ONLY. What database objects the AI document reading depends on, and whether they are present.
-- Run on DEV first (project ref vqycarelcoijzwlpkpcz), then on production (twwpnltizhtjxhamyoxt). Check the address bar.
-- Result: one row per check. Every present value should be true. A false row is a blocker for the named feature.
-- Returns booleans only. No personal data.

select check_name, present
  from (
    select 'user_entitlements has effective_from and effective_to (Premium window, 0231)' as check_name,
           (select count(*) = 2 from information_schema.columns
             where table_schema = 'public' and table_name = 'user_entitlements'
               and column_name in ('effective_from', 'effective_to')) as present
    union all
    select 'AIE cost ledger aie_ai_cost_ledger (0150)', to_regclass('public.aie_ai_cost_ledger') is not null
    union all
    select 'AIE cost attempts aie_ai_cost_attempt (0152)', to_regclass('public.aie_ai_cost_attempt') is not null
    union all
    select 'AIE settle function with call evidence aie_settle_ai_cost_v2 (0195)',
           exists (select 1 from pg_proc where proname = 'aie_settle_ai_cost_v2' and pronamespace = 'public'::regnamespace)
    union all
    select 'Per-user daily cap function aie_reserve_ai_cost_v2 (0284). If false and the new build is live, EVERY AI reading is refused',
           exists (select 1 from pg_proc where proname = 'aie_reserve_ai_cost_v2' and pronamespace = 'public'::regnamespace)
    union all
    select 'Per-user cap column aie_ai_cost_ledger.user_daily_cap_usd (0284)',
           exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_ledger' and column_name = 'user_daily_cap_usd')
    union all
    select 'Per-user attribution column aie_ai_cost_attempt.user_id (0284)',
           exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_attempt' and column_name = 'user_id')
    union all
    select 'Durable AI drafts fdh_ai_fallback_drafts (0197)', to_regclass('public.fdh_ai_fallback_drafts') is not null
    union all
    select 'Investment Intelligence AI reviews ii_ai_extraction_reviews (0160). If false, the II statement AI reading cannot save a review', to_regclass('public.ii_ai_extraction_reviews') is not null
    union all
    select 'Owner before upload fdh_statement_uploads.owner_allocation (0236)',
           exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fdh_statement_uploads' and column_name = 'owner_allocation')
    union all
    select 'Real malware scan columns on fdh_statement_uploads (0165)',
           (select count(*) >= 3 from information_schema.columns
             where table_schema = 'public' and table_name = 'fdh_statement_uploads'
               and column_name in ('malware_scan_status', 'malware_scan_object_ref', 'malware_scan_decided_at'))
    union all
    select 'Real malware scan columns on ii_source_documents (0196)',
           exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ii_source_documents' and column_name = 'malware_scan_status')
    union all
    select 'Audit vocabulary covers bank AI reading events (0180)',
           exists (select 1 from pg_constraint
                    where conname = 'fdh_document_audit_events_event_type_check'
                      and strpos(pg_get_constraintdef(oid), 'bank_statement_ai_fallback_draft_ready') > 0)
    union all
    select 'Audit vocabulary covers retirement AI reading events (0180)',
           exists (select 1 from pg_constraint
                    where conname = 'fdh_document_audit_events_event_type_check'
                      and strpos(pg_get_constraintdef(oid), 'retirement_statement_ai_fallback_not_usable') > 0)
    union all
    select 'Staff admin Premium entitlement source (0283)',
           exists (select 1 from pg_constraint where conname = 'user_entitlements_entitlement_source_check' and strpos(pg_get_constraintdef(oid), 'staff_admin') > 0)
  ) checks
 order by present, check_name;
