-- P01  READ-ONLY  Production (twwpnltizhtjxhamyoxt) and DEV (vqycarelcoijzwlpkpcz)
-- Purpose: confirm the database objects the AI document reading and the Premium check depend on are present.
-- This change adds NO migration and writes NOTHING. Run once; every row should show present = true.
-- A false row is a blocker for the named feature, see 00_README step 2.
-- Hand-run hazard respected: no comment or string in this file uses the words that the SQL editor mis-parses.

select check_name, present
  from (
    select 'Premium window columns on user_entitlements (0231)' as check_name,
           (select count(*) = 2 from information_schema.columns
             where table_schema = 'public' and table_name = 'user_entitlements'
               and column_name in ('effective_from', 'effective_to')) as present
    union all
    select 'Module 11 controls table ai_platform_controls (0115)', to_regclass('public.ai_platform_controls') is not null
    union all
    select 'Module 11 function ai_entitlement_state (0115)',
           exists (select 1 from pg_proc where proname = 'ai_entitlement_state' and pronamespace = 'public'::regnamespace)
    union all
    select 'Module 11 function ai_admit_request (0115)',
           exists (select 1 from pg_proc where proname = 'ai_admit_request' and pronamespace = 'public'::regnamespace)
    union all
    select 'Standard question catalogue ai_standard_questions (0124)', to_regclass('public.ai_standard_questions') is not null
    union all
    select 'Contextual targets ai_contextual_explanation_targets (0126)', to_regclass('public.ai_contextual_explanation_targets') is not null
    union all
    select 'AIE cost ledger aie_ai_cost_ledger (0150)', to_regclass('public.aie_ai_cost_ledger') is not null
    union all
    select 'AIE cost attempts aie_ai_cost_attempt (0152)', to_regclass('public.aie_ai_cost_attempt') is not null
    union all
    select 'AIE settle v2 with call evidence (0195)',
           exists (select 1 from pg_proc where proname = 'aie_settle_ai_cost_v2' and pronamespace = 'public'::regnamespace)
    union all
    select 'AIE stale reservation release (0195)',
           exists (select 1 from pg_proc where proname = 'aie_release_stale_ai_cost_reservations' and pronamespace = 'public'::regnamespace)
    union all
    select 'Durable AI drafts fdh_ai_fallback_drafts (0197)', to_regclass('public.fdh_ai_fallback_drafts') is not null
    union all
    select 'Investment Intelligence AI reviews ii_ai_extraction_reviews (0160)', to_regclass('public.ii_ai_extraction_reviews') is not null
    union all
    select 'Audit vocabulary covers retirement AI fallback events (0180)',
           exists (select 1 from pg_constraint
                    where conname = 'fdh_document_audit_events_event_type_check'
                      and pg_get_constraintdef(oid) like '%retirement_statement_ai_fallback_not_usable%')
    union all
    select 'Audit vocabulary covers bank AI fallback events (0180)',
           exists (select 1 from pg_constraint
                    where conname = 'fdh_document_audit_events_event_type_check'
                      and pg_get_constraintdef(oid) like '%bank_statement_ai_fallback_attempted%')
    union all
    select 'Owner before upload: fdh_statement_uploads.owner_allocation (0236)',
           exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'fdh_statement_uploads' and column_name = 'owner_allocation')
    union all
    select 'Owner before upload: aie_document_intake.owner_selection (0236)',
           exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'aie_document_intake' and column_name = 'owner_selection')
  ) checks
 order by present, check_name;
