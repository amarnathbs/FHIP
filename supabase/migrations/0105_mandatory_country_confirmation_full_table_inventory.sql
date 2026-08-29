-- Mandatory Country Confirmation, round 2 closure — item 3: complete the
-- direct-write inventory across EVERY table discoverable from the current
-- migration head (0001-0104), not just the 8 tables the Product Owner named
-- explicitly (which migration 0104 already backstopped). Generated and
-- verified via scripts/mcc_full_table_inventory.mjs (discovers every
-- public-schema table with an RLS policy granting `authenticated`/`public`
-- INSERT or ALL) and scripts/mcc_classify_tables.mjs (classifies each of the
-- 91 tables that inventory found into GENERIC / BESPOKE / EXCLUDED — see
-- scripts/mcc_table_classification.json for the machine-readable output
-- this migration was generated from).
--
-- Also fixes a real defect found while building this inventory: migration
-- 0104's enforce_country_confirmed() had no onboarding-completion exemption
-- at all, unlike the application-layer guard (lib/api.ts's
-- requireCountryConfirmedUser / lib/services/countryGate.ts's
-- countryConfirmationBlockResponse). The onboarding wizard's own optional
-- "first goal" step (app/(onboarding)/onboarding/OnboardingWizard.tsx) POSTs
-- to /api/goals BEFORE the user has ever seen a country-confirmation screen
-- — the API layer correctly exempts this (onboarding_completed is false),
-- but the round-1 DB trigger on user_goals did NOT, and would have rejected
-- that exact INSERT with a raw Postgres exception, breaking onboarding for
-- any user who filled in the optional goal field. Confirmed reproducible in
-- scripts/mcc_pglite_certification.mjs's own U2 fixture (onboarding_completed
-- defaults to false) coincidentally already exercised the buggy path without
-- the test noticing, because the test's assertion ("rejected") happened to
-- match the bug's behaviour for the wrong reason. Fixed here by making the
-- trigger function itself skip enforcement for any user who has not yet
-- completed onboarding, mirroring the API-layer rule exactly, in ONE place.
--
-- === Classification summary (91 tables reviewed) ===
--   69 GENERIC   — direct `user_id uuid` column, reuse the existing
--                  enforce_country_confirmed() function unchanged.
--    1 BESPOKE   — professional_notes (owner column is `author_user_id`,
--                  not `user_id` — a professional/advisor's own notes about
--                  a client; the acting writer is the professional, who is
--                  themself an authenticated FHIP user subject to the same
--                  compulsory-confirmation rule).
--    2 BESPOKE   — financial_twin_insights, financial_twin_metric_results
--                  (child rows of financial_twin_runs, no user_id of their
--                  own — owner resolved via a join to the parent run).
--   19 EXCLUDED, each with a stated reason (never silently skipped):
--      - user_profiles: signup bootstrap. handle_new_user() (0002) inserts
--        this exact row with no prior state to check — the trigger would
--        always reject the very row that would let is_country_confirmed()
--        ever return true for that user. Must never carry this trigger.
--      - consents: spec section 1.2 explicitly keeps "Privacy information"
--        and "Terms and required legal information" reachable regardless of
--        confirmation state; recording consent to those is the same class
--        of interaction, so it stays exempt on principle (it is also,
--        independently, not yet written by any application code path today
--        — grep confirms zero call sites — but that is not why it is
--        excluded).
--      - resource_authors, resource_categories, resource_context_links,
--        resource_ctas, resource_faqs, resource_media,
--        resource_post_categories, resource_post_faqs,
--        resource_post_sources, resource_post_tags, resource_post_versions,
--        resource_posts, resource_related_content, resource_settings,
--        resource_sources, resource_tags, resource_videos (17 tables):
--        Resources CMS shared content, not per-user financial data.
--        Ownership is role-based (resource_user_roles: resource_admin/
--        author/editor/compliance_reviewer/publisher/analyst), not
--        `auth.uid() = user_id` — most of these tables have no user_id
--        column at all. This surface is fully covered by the API-layer gate
--        instead (all 40 Resources admin write routes now call
--        countryConfirmationBlockResponse() — see the accompanying
--        application-code commit for MCC-2). A direct-PostgREST bypass by a
--        role-holding CMS staffer remains theoretically possible and is
--        disclosed as a residual, low-priority, out-of-scope gap (this is
--        shared editorial content, not financial data, and the Product
--        Owner's compulsory-confirmation rule is scoped to financial
--        modules and the user's own data) rather than silently ignored.
--
-- Numbered 0105 (not appended into 0104) so round 1 and round 2 of this
-- task stay independently auditable; 0104 is left completely unmodified.

-- 1. Fix the onboarding-exemption bug in the shared trigger function -------
create or replace function public.enforce_country_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_onboarding_completed boolean;
begin
  -- Service-role writes (background jobs, admin remediation, seed/migration
  -- scripts, the FDH/Investment-Intelligence pipelines) are not subject to
  -- this end-user gate — unchanged from migration 0104.
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Bootstrap exemption (NEW in 0105 — see migration header): mirrors
  -- lib/services/countryGate.ts's countryConfirmationBlockResponse() exactly
  -- — a user who has not yet completed onboarding is not subject to this
  -- gate yet, because country confirmation is a concept introduced only
  -- after onboarding completes. Reads onboarding_completed off the SAME
  -- user_profiles row is_country_confirmed() would otherwise read from; if
  -- no profile row exists at all this resolves to NULL, which `is not true`
  -- correctly treats as "not completed" (exempt), never as an error.
  select up.onboarding_completed into v_onboarding_completed
  from user_profiles up
  where up.user_id = new.user_id;

  if v_onboarding_completed is not true then
    return new;
  end if;

  if not public.is_country_confirmed(new.user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_country_confirmed() is
  'Database-level backstop for direct-Supabase-client writes that bypass the application API/route guard. Blocks INSERT only. Exempt for service_role and for any user who has not yet completed onboarding (mirrors the API-layer guard exactly — fixed in 0105, see migration header). Applied via GENERIC (direct user_id), BESPOKE (professional_notes, financial_twin_insights/metric_results) and EXCLUDED (documented) classification across every table discoverable from the current migration head — see 0105''s own header for the full breakdown.';

-- 2. Bespoke trigger: professional_notes (owner column is author_user_id) --
create or replace function public.enforce_country_confirmed_professional_notes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_onboarding_completed boolean;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  select up.onboarding_completed into v_onboarding_completed
  from user_profiles up
  where up.user_id = new.author_user_id;

  if v_onboarding_completed is not true then
    return new;
  end if;

  if not public.is_country_confirmed(new.author_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: professional % has not confirmed a supported country of residence', new.author_user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_country_confirmed on professional_notes;
create trigger trg_enforce_country_confirmed
  before insert on professional_notes
  for each row execute function public.enforce_country_confirmed_professional_notes();

-- 3. Bespoke trigger: financial_twin_insights / financial_twin_metric_results
--    (no user_id of their own — resolved via a join to the parent run) ----
create or replace function public.enforce_country_confirmed_via_twin_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_onboarding_completed boolean;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  select r.user_id into v_user_id
  from financial_twin_runs r
  where r.id = new.financial_twin_run_id;

  -- No matching parent run at all is a data-integrity problem the FK
  -- constraint on financial_twin_run_id already owns — this trigger only
  -- adds the country gate on top of a row that would otherwise be allowed
  -- to attempt insertion; if v_user_id is null here, fall through to let
  -- the FK constraint (not this trigger) produce the real error.
  if v_user_id is null then
    return new;
  end if;

  select up.onboarding_completed into v_onboarding_completed
  from user_profiles up
  where up.user_id = v_user_id;

  if v_onboarding_completed is not true then
    return new;
  end if;

  if not public.is_country_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', v_user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_country_confirmed on financial_twin_insights;
create trigger trg_enforce_country_confirmed
  before insert on financial_twin_insights
  for each row execute function public.enforce_country_confirmed_via_twin_run();

drop trigger if exists trg_enforce_country_confirmed on financial_twin_metric_results;
create trigger trg_enforce_country_confirmed
  before insert on financial_twin_metric_results
  for each row execute function public.enforce_country_confirmed_via_twin_run();

-- 4. GENERIC: apply the existing enforce_country_confirmed() function to
--    every table with a direct user_id column (69 tables) ----------------
drop trigger if exists trg_enforce_country_confirmed on fdh_approved_financial_summaries;
create trigger trg_enforce_country_confirmed
  before insert on fdh_approved_financial_summaries
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_classification_history;
create trigger trg_enforce_country_confirmed
  before insert on fdh_classification_history
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_csv_mapping_templates;
create trigger trg_enforce_country_confirmed
  before insert on fdh_csv_mapping_templates
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_data_provenance;
create trigger trg_enforce_country_confirmed
  before insert on fdh_data_provenance
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_data_quality_results;
create trigger trg_enforce_country_confirmed
  before insert on fdh_data_quality_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_duplicate_candidates;
create trigger trg_enforce_country_confirmed
  before insert on fdh_duplicate_candidates
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_evidence_links;
create trigger trg_enforce_country_confirmed
  before insert on fdh_evidence_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_financial_accounts;
create trigger trg_enforce_country_confirmed
  before insert on fdh_financial_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_ingestion_jobs;
create trigger trg_enforce_country_confirmed
  before insert on fdh_ingestion_jobs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_payroll_components;
create trigger trg_enforce_country_confirmed
  before insert on fdh_payroll_components
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_payroll_events;
create trigger trg_enforce_country_confirmed
  before insert on fdh_payroll_events
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_reconciliation_results;
create trigger trg_enforce_country_confirmed
  before insert on fdh_reconciliation_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_recurring_transactions;
create trigger trg_enforce_country_confirmed
  before insert on fdh_recurring_transactions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_review_items;
create trigger trg_enforce_country_confirmed
  before insert on fdh_review_items
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_statement_uploads;
create trigger trg_enforce_country_confirmed
  before insert on fdh_statement_uploads
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_allocations;
create trigger trg_enforce_country_confirmed
  before insert on fdh_transaction_allocations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_corrections;
create trigger trg_enforce_country_confirmed
  before insert on fdh_transaction_corrections
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_links;
create trigger trg_enforce_country_confirmed
  before insert on fdh_transaction_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transactions;
create trigger trg_enforce_country_confirmed
  before insert on fdh_transactions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_upload_sessions;
create trigger trg_enforce_country_confirmed
  before insert on fdh_upload_sessions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_user_classification_rules;
create trigger trg_enforce_country_confirmed
  before insert on fdh_user_classification_rules
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fhip_import_applications;
create trigger trg_enforce_country_confirmed
  before insert on fhip_import_applications
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fhip_import_proposal_fields;
create trigger trg_enforce_country_confirmed
  before insert on fhip_import_proposal_fields
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fhip_import_proposals;
create trigger trg_enforce_country_confirmed
  before insert on fhip_import_proposals
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_actions;
create trigger trg_enforce_country_confirmed
  before insert on financial_dna_actions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_drivers;
create trigger trg_enforce_country_confirmed
  before insert on financial_dna_drivers
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_profile_scores;
create trigger trg_enforce_country_confirmed
  before insert on financial_dna_profile_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_profiles;
create trigger trg_enforce_country_confirmed
  before insert on financial_dna_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_component_scores;
create trigger trg_enforce_country_confirmed
  before insert on financial_health_component_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_recommendations;
create trigger trg_enforce_country_confirmed
  before insert on financial_health_recommendations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_scores;
create trigger trg_enforce_country_confirmed
  before insert on financial_health_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_snapshots;
create trigger trg_enforce_country_confirmed
  before insert on financial_snapshots
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_twin_runs;
create trigger trg_enforce_country_confirmed
  before insert on financial_twin_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_assumptions;
create trigger trg_enforce_country_confirmed
  before insert on forecast_assumptions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_explanations;
create trigger trg_enforce_country_confirmed
  before insert on forecast_explanations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_profiles;
create trigger trg_enforce_country_confirmed
  before insert on forecast_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_results;
create trigger trg_enforce_country_confirmed
  before insert on forecast_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_runs;
create trigger trg_enforce_country_confirmed
  before insert on forecast_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_scenarios;
create trigger trg_enforce_country_confirmed
  before insert on forecast_scenarios
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on future_financial_commitments;
create trigger trg_enforce_country_confirmed
  before insert on future_financial_commitments
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_contributions;
create trigger trg_enforce_country_confirmed
  before insert on goal_contributions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_forecasts;
create trigger trg_enforce_country_confirmed
  before insert on goal_forecasts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_funding_sources;
create trigger trg_enforce_country_confirmed
  before insert on goal_funding_sources
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_milestones;
create trigger trg_enforce_country_confirmed
  before insert on goal_milestones
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_snapshots;
create trigger trg_enforce_country_confirmed
  before insert on goal_snapshots
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on health_check_ins;
create trigger trg_enforce_country_confirmed
  before insert on health_check_ins
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on household_members;
create trigger trg_enforce_country_confirmed
  before insert on household_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on households;
create trigger trg_enforce_country_confirmed
  before insert on households
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_accounts;
create trigger trg_enforce_country_confirmed
  before insert on ii_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_document_parse_runs;
create trigger trg_enforce_country_confirmed
  before insert on ii_document_parse_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_fhip_publications;
create trigger trg_enforce_country_confirmed
  before insert on ii_fhip_publications
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_goal_allocations;
create trigger trg_enforce_country_confirmed
  before insert on ii_goal_allocations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_insights;
create trigger trg_enforce_country_confirmed
  before insert on ii_insights
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_portfolio_truth_status;
create trigger trg_enforce_country_confirmed
  before insert on ii_portfolio_truth_status
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_source_documents;
create trigger trg_enforce_country_confirmed
  before insert on ii_source_documents
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_tax_profiles;
create trigger trg_enforce_country_confirmed
  before insert on ii_tax_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_transaction_source_links;
create trigger trg_enforce_country_confirmed
  before insert on ii_transaction_source_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on property_liability_links;
create trigger trg_enforce_country_confirmed
  before insert on property_liability_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_actions;
create trigger trg_enforce_country_confirmed
  before insert on resilience_actions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_component_scores;
create trigger trg_enforce_country_confirmed
  before insert on resilience_component_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_risks;
create trigger trg_enforce_country_confirmed
  before insert on resilience_risks
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_scores;
create trigger trg_enforce_country_confirmed
  before insert on resilience_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on retirement_members;
create trigger trg_enforce_country_confirmed
  before insert on retirement_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_fund_members;
create trigger trg_enforce_country_confirmed
  before insert on smsf_fund_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_funds;
create trigger trg_enforce_country_confirmed
  before insert on smsf_funds
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_holdings;
create trigger trg_enforce_country_confirmed
  before insert on smsf_holdings
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_financial_section_status;
create trigger trg_enforce_country_confirmed
  before insert on user_financial_section_status
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_recommendation_matches;
create trigger trg_enforce_country_confirmed
  before insert on user_recommendation_matches
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_recommendation_runs;
create trigger trg_enforce_country_confirmed
  before insert on user_recommendation_runs
  for each row execute function public.enforce_country_confirmed();
