-- Mandatory Country Confirmation, round 3 closure (Product Owner review) --
-- Gap 1 fix: migration 0105's enforce_country_confirmed() had
--   `if v_onboarding_completed is not true then return new; end if;`
-- as an UNSCOPED exemption applying to EVERY one of the 80 backstopped
-- tables whenever onboarding_completed=false -- a real, exploitable bypass:
-- a defective or malicious client could INSERT into ANY of income_sources,
-- expense_items, assets, liabilities, investments, retirement_accounts,
-- insurance_policies, user_goals, or any of the other 72 tables, for as
-- long as the caller's onboarding_completed stayed false. Confirmed
-- genuinely reproducible by reading the trigger source directly.
--
-- Fixed two ways, together:
--   1. The onboarding wizard's own optional "first goal" write -- the ONLY
--      reason the blanket exemption existed at all -- has been moved out
--      of onboarding entirely. app/(onboarding)/onboarding/OnboardingWizard.tsx
--      no longer calls POST /api/goals during onboarding; it stashes the
--      draft client-side (lib/constants.ts's PENDING_GOAL_STORAGE_KEY) and
--      app/(onboarding)/confirm-country/ConfirmCountryForm.tsx creates it
--      immediately AFTER the user genuinely confirms their country -- by
--      which point no exemption of any kind is needed, because the user
--      really is CONFIRMED.
--   2. The shared trigger function's exemption is narrowed from "any table,
--      whenever onboarding_completed=false" to EXACTLY ONE table and TWO
--      operations: `households`, INSERT and UPDATE only (never DELETE,
--      never household_members, never anything else) -- because
--      PUT /api/household is the one remaining onboarding-time write that
--      genuinely must run before country confirmation exists as a concept
--      for that user (spec section 10 hard-stop: blocking it would break
--      signup). Implemented via an explicit `if TG_TABLE_NAME = 'households'`
--      check, not a flag any table can trip.
--
-- Gap 2 fix: round 1/2 only ever proved INSERT protection. This migration
-- extends every trigger to cover UPDATE and DELETE too, but ONLY for
-- operations that scripts/mcc_crud_policy_inventory.mjs discovered an
-- authenticated/public RLS policy actually grants -- an operation with NO
-- authenticated policy is already blocked by RLS alone, so adding a
-- redundant trigger for it would not be "smallest safe". This is why the
-- generated trigger list below varies per table ("before insert or update
-- or delete", "before insert or update", "before insert", or "before
-- update" alone for the 3 UPDATE-only tables
-- ii_reconciliation_cases/ii_review_items/professional_profiles).
--
-- SELECT is deliberately NOT gated by any trigger -- Postgres has no
-- "before select" trigger mechanism at all; the only way to restrict a
-- SELECT is to modify the underlying RLS policy. This migration does not
-- do that. See the closure report (Gap 2's SELECT justification section)
-- for the live-tested reasoning: existing owner-only RLS
-- (auth.uid() = user_id) already prevents cross-tenant reads regardless of
-- country state, and spec section 5.6 explicitly permits (does not
-- require) continuing to allow read-only access to a user's own
-- already-existing preserved records once the approved application gate
-- (app/(app)/layout.tsx) already blocks the entire financial UI --
-- exactly this app's situation.
--
-- Also folds in 5 tables that reached this feature's classification net
-- for the first time this round: 2 from FDH-10 (merged from origin/main
-- since round 2 -- fdh_liability_statements, fdh_liability_statement_activities,
-- INSERT+UPDATE, no DELETE policy) and 3 that round 2's INSERT-only
-- discovery script never surfaced because their ONLY authenticated policy
-- is UPDATE, not INSERT (ii_reconciliation_cases, ii_review_items,
-- professional_profiles -- created by service-role processes, then
-- resolved/edited directly by their owning user).
--
-- Numbered 0107, not 0106 -- 0106 is claimed (unmerged) by
-- feature/fdh11-au-investment-statement-intelligence, discovered during
-- this round's origin/main reconciliation; reusing it would create a
-- future collision.

-- 1. Rewritten shared trigger function -- TG_OP-aware (INSERT/UPDATE/DELETE),
--    narrow households-only onboarding exemption -----------------------------
create or replace function public.enforce_country_confirmed()
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
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  v_user_id := case when TG_OP = 'DELETE' then old.user_id else new.user_id end;

  -- Round-3 fix for Gap 1: the ONLY table/operation pair ever exempted
  -- pre-onboarding-completion. Every other table on this trigger function
  -- gets NO onboarding exemption at all, regardless of onboarding_completed.
  if TG_TABLE_NAME = 'households' and TG_OP in ('INSERT', 'UPDATE') then
    select up.onboarding_completed into v_onboarding_completed
    from user_profiles up
    where up.user_id = v_user_id;

    if v_onboarding_completed is not true then
      if TG_OP = 'DELETE' then return old; else return new; end if;
    end if;
  end if;

  if not public.is_country_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', v_user_id
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

comment on function public.enforce_country_confirmed() is
  'Database-level backstop for direct-Supabase-client writes (INSERT/UPDATE/DELETE, whichever an authenticated RLS policy actually grants per table) that bypass the application API/route guard. The ONLY onboarding-time exemption is households INSERT/UPDATE (round-3 fix, migration 0107) -- every other table requires a genuinely confirmed country regardless of onboarding_completed.';

-- 2. Rewritten BESPOKE join trigger (financial_twin_insights /
--    financial_twin_metric_results) -- now TG_OP-aware too ------------------
create or replace function public.enforce_country_confirmed_via_twin_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_user_id uuid;
begin
  if auth.role() = 'service_role' then
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  v_run_id := case when TG_OP = 'DELETE' then old.financial_twin_run_id else new.financial_twin_run_id end;

  select r.user_id into v_user_id
  from financial_twin_runs r
  where r.id = v_run_id;

  if v_user_id is null then
    -- No matching parent run -- not this trigger's concern, the FK
    -- constraint on financial_twin_run_id owns that failure mode.
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  -- No onboarding exemption applies to this trigger at all -- these two
  -- tables are never written during onboarding, unlike households -- so,
  -- unlike the shared enforce_country_confirmed() function, there is no
  -- TG_TABLE_NAME/onboarding_completed check here to skip.
  if not public.is_country_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', v_user_id
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

-- professional_notes' bespoke owner-column function is UNCHANGED --
-- confirmed via scripts/mcc_crud_policy_inventory.mjs that the table has
-- no authenticated UPDATE/DELETE policy at all (RLS already blocks both),
-- so extending its trigger would be redundant, not "smallest safe".

-- 3. Re-apply the BESPOKE join trigger with the correct operation list
--    (INSERT/UPDATE/DELETE all have authenticated policies on both tables) --
drop trigger if exists trg_enforce_country_confirmed on financial_twin_insights;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_twin_insights
  for each row execute function public.enforce_country_confirmed_via_twin_run();

drop trigger if exists trg_enforce_country_confirmed on financial_twin_metric_results;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_twin_metric_results
  for each row execute function public.enforce_country_confirmed_via_twin_run();

-- 4. GENERIC tables -- re-applies every existing trigger with its correct,
--    discovered operation list, and adds the 5 newly-discovered tables for
--    the first time (82 tables total; see scripts/mcc_table_classification_v3.json
--    for the full machine-readable classification this was generated from) --
drop trigger if exists trg_enforce_country_confirmed on assets;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on assets
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on expense_items;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on expense_items
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_approved_financial_summaries;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_approved_financial_summaries
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_classification_history;
create trigger trg_enforce_country_confirmed
  before insert on fdh_classification_history
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_csv_mapping_templates;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_csv_mapping_templates
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_data_provenance;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_data_provenance
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_data_quality_results;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_data_quality_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_duplicate_candidates;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_duplicate_candidates
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_evidence_links;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_evidence_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_financial_accounts;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_financial_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_ingestion_jobs;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_ingestion_jobs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_liability_statement_activities;
create trigger trg_enforce_country_confirmed
  before insert or update on fdh_liability_statement_activities
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_liability_statements;
create trigger trg_enforce_country_confirmed
  before insert or update on fdh_liability_statements
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_payroll_components;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_payroll_components
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_payroll_events;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_payroll_events
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_reconciliation_results;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_reconciliation_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_recurring_transactions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_recurring_transactions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_review_items;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_review_items
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_statement_uploads;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_statement_uploads
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_allocations;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_transaction_allocations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_corrections;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_transaction_corrections
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transaction_links;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_transaction_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_transactions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_transactions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_upload_sessions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_upload_sessions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on fdh_user_classification_rules;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on fdh_user_classification_rules
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
  before insert or update on fhip_import_proposals
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_actions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_dna_actions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_drivers;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_dna_drivers
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_profile_scores;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_dna_profile_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_dna_profiles;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_dna_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_component_scores;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_health_component_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_recommendations;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_health_recommendations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_health_scores;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_health_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_snapshots;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_snapshots
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on financial_twin_runs;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on financial_twin_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_assumptions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_assumptions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_explanations;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_explanations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_profiles;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_results;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_results
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_runs;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on forecast_scenarios;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on forecast_scenarios
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on future_financial_commitments;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on future_financial_commitments
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_contributions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on goal_contributions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_forecasts;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on goal_forecasts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_funding_sources;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on goal_funding_sources
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_milestones;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on goal_milestones
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on goal_snapshots;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on goal_snapshots
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on health_check_ins;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on health_check_ins
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on household_members;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on household_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on households;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on households
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_accounts;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_document_parse_runs;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_document_parse_runs
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_fhip_publications;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_fhip_publications
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_goal_allocations;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_goal_allocations
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_insights;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_insights
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_portfolio_truth_status;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_portfolio_truth_status
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_reconciliation_cases;
create trigger trg_enforce_country_confirmed
  before update on ii_reconciliation_cases
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_review_items;
create trigger trg_enforce_country_confirmed
  before update on ii_review_items
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_source_documents;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_source_documents
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_tax_profiles;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_tax_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on ii_transaction_source_links;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on ii_transaction_source_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on income_sources;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on income_sources
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on insurance_policies;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on insurance_policies
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on investments;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on investments
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on liabilities;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on liabilities
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on professional_profiles;
create trigger trg_enforce_country_confirmed
  before update on professional_profiles
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on property_liability_links;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on property_liability_links
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_actions;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on resilience_actions
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_component_scores;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on resilience_component_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_risks;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on resilience_risks
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on resilience_scores;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on resilience_scores
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on retirement_accounts;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on retirement_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on retirement_members;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on retirement_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_fund_members;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on smsf_fund_members
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_funds;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on smsf_funds
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on smsf_holdings;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on smsf_holdings
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_financial_section_status;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on user_financial_section_status
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_goals;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on user_goals
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_recommendation_matches;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on user_recommendation_matches
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_recommendation_runs;
create trigger trg_enforce_country_confirmed
  before insert or update or delete on user_recommendation_runs
  for each row execute function public.enforce_country_confirmed();

