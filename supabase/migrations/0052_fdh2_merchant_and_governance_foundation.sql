-- =============================================================================
-- Financial Data Hub (FDH) — FDH-2 Migration C (0052): merchant-master
-- extensions (recurrence metadata, provenance, confidence) and the
-- global-learning governance foundation.
-- =============================================================================
-- REUSE RULE. fdh_merchants already exists (migration 0045) with
-- canonical_name/display_name/country_code/merchant_type/default_category_id/
-- default_subcategory_id/mcc/subscription_possible/essential_discretionary/
-- verification_status/active. This migration only ADDS columns.
--
-- `canonical_name` is FDH-1's own documented "normalised machine form" and is
-- therefore already the merchant's stable machine key — see the FDH-1 column
-- comment in 0045_fdh_reference_foundation.sql. FDH-2 does not add a second,
-- competing key column; see FDH2_MERCHANT_MASTER.md section 2 for the
-- documented decision. Likewise `country_code IS NULL` already encodes
-- "global merchant" (uq_fdh_merchants_global_name); FDH-2 does not add a
-- redundant `global_or_local` column.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_merchants extensions.
--
-- RECURRENCE. `subscription_possible` already existed (FDH-1). `
-- recurring_possible` is added as the BROADER likelihood flag — a utility or
-- an insurer is recurring-possible without being subscription_possible in the
-- SaaS sense. Both are MERCHANT-LEVEL LIKELIHOOD metadata only; neither one,
-- alone or combined, ever means "this transaction IS recurring" — actual
-- detection is FDH-6.
--
-- CONFIDENCE. `mcc_confidence` uses the structured FDH_MCC_CONFIDENCE_STATES
-- vocabulary (verified/high/medium/low) — never a fabricated precise
-- percentage. It is only meaningful once `mcc` itself is populated, enforced
-- by chk_fdh_merchants_mcc_confidence_needs_mcc below.
-- ---------------------------------------------------------------------------
alter table fdh_merchants
  add column website_domain text,
  add column parent_company_name text,
  add column mcc_confidence text
    check (mcc_confidence is null or mcc_confidence in ('verified', 'high', 'medium', 'low')),
  add column recurring_possible boolean not null default false,
  add column typical_frequency text
    check (typical_frequency is null or typical_frequency in (
      'weekly', 'fortnightly', 'monthly', 'quarterly', 'annual', 'irregular'
    )),
  add column fixed_amount_expected boolean not null default false,
  add column variable_amount_possible boolean not null default false,
  add column recurring_type text
    check (recurring_type is null or recurring_type in (
      'subscription', 'utility', 'insurance', 'membership', 'loan_or_financial',
      'telecom', 'rent_or_housing', 'government', 'other_recurring',
      'not_normally_recurring', 'unknown'
    )),
  -- Distinguishes a payment PROCESSOR/gateway (PAYPAL, STRIPE, RAZORPAY, a
  -- UPI PSP) from an ultimate merchant, per specification section 38-43. A
  -- processor row must never be blindly classified into one economic
  -- category — the future engine is expected to look for a downstream
  -- descriptor instead.
  add column is_payment_processor boolean not null default false,
  add column source_key text references fdh_source_registry(source_key) on delete set null,
  add column source_checked_at date,
  add constraint chk_fdh_merchants_mcc_confidence_needs_mcc
    check (mcc_confidence is null or mcc is not null);

create index idx_fdh_merchants_source on fdh_merchants(source_key) where source_key is not null;
create index idx_fdh_merchants_recurring on fdh_merchants(recurring_possible) where recurring_possible;


-- ---------------------------------------------------------------------------
-- fdh_classification_rules / fdh_user_classification_rules rule_type
-- widening. Additive: adds 'narrative_pattern' (required/excluded-term
-- pattern matching used by the FDH-2 income/salary/government/transfer/fee/
-- interest/cash-withdrawal/refund/credit-card-payment/investment-transfer
-- seed library) and 'payment_rail_narrative' (payment-mechanism recognition,
-- kept structurally separate from economic classification — specification
-- section 38-43). No existing rule_type value is removed. See
-- lib/financial-data-hub/constants/enums.ts FDH_GLOBAL_RULE_TYPES and
-- lib/financial-data-hub/validation/classification.ts for the corresponding
-- match_definition/action_definition discriminated-union members.
-- ---------------------------------------------------------------------------
alter table fdh_classification_rules
  drop constraint if exists fdh_classification_rules_rule_type_check;
alter table fdh_classification_rules
  add constraint fdh_classification_rules_rule_type_check
    check (rule_type in (
      'merchant_exact', 'merchant_alias', 'mcc', 'description_contains',
      'institution_narrative', 'source_provided_category',
      'narrative_pattern', 'payment_rail_narrative'
    ));

alter table fdh_user_classification_rules
  drop constraint if exists fdh_user_classification_rules_rule_type_check;
alter table fdh_user_classification_rules
  add constraint fdh_user_classification_rules_rule_type_check
    check (rule_type in (
      'merchant_exact', 'merchant_alias', 'mcc', 'description_contains',
      'institution_narrative', 'source_provided_category', 'account_scoped_default',
      'narrative_pattern', 'payment_rail_narrative'
    ));


-- ---------------------------------------------------------------------------
-- fdh_global_learning_candidates — the global-learning governance workflow's
-- DATA MODEL (not the admin UI, which is FDH-13). A candidate represents
-- AGGREGATE evidence for a proposed global merchant alias, new merchant, or
-- classification rule — user correction -> user-specific rule -> potential
-- global-learning candidate -> PII screening -> evidence aggregation ->
-- admin_review -> approve/reject/merge.
--
-- PRIVACY (specification section 55-64/83-93). This table stores counts and
-- category identifiers only — never a bag of one user's raw transaction
-- descriptions. `pii_screening_status` must be 'passed' before a candidate
-- can reach 'approved' (chk_fdh_glc_pii_gate below) — a conservative,
-- explainable heuristic gate, not complex AI-based detection.
--
-- NO AUTOMATIC PROMOTION, EVER. This table has NO code path that writes
-- fdh_merchants or fdh_classification_rules directly; FDH-2 implements no
-- such promotion mechanism at all (documented contract only — see
-- lib/financial-data-hub/domain/globalLearningGovernance.ts and
-- FDH2_GLOBAL_LEARNING_GOVERNANCE.md).
--
-- ACCESS. Deliberately MORE RESTRICTED than the other master-data tables in
-- this migration set. A pending governance candidate is not settled public
-- reference data — even in aggregate form it can indirectly hint at
-- cross-household behaviour ("14 independent users correct COSTCO to
-- Household"), so it gets NO select/insert/update/delete policy for
-- anon/authenticated at all. RLS is enabled with zero permissive policies,
-- which denies every role except service_role (which bypasses RLS by
-- Postgres convention) — exactly the pattern already used for
-- admin-document-metadata-only surfaces in FDH-1
-- (docs/financial-data-hub/FDH1_RLS_SECURITY.md section 5).
-- ---------------------------------------------------------------------------
create table fdh_global_learning_candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_type text not null
    check (candidate_type in ('merchant_alias', 'merchant_new', 'classification_rule')),
  country_code char(2) references countries(country_code) on delete restrict,
  merchant_id uuid references fdh_merchants(id) on delete set null,
  proposed_alias_normalized text,
  current_category_id uuid references fdh_categories(id) on delete set null,
  proposed_category_id uuid references fdh_categories(id) on delete set null,
  proposed_subcategory_id uuid references fdh_subcategories(id) on delete set null,
  number_of_independent_users int not null default 0 check (number_of_independent_users >= 0),
  number_of_corrections int not null default 0 check (number_of_corrections >= 0),
  number_of_matching_aliases int not null default 0 check (number_of_matching_aliases >= 0),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  pii_screening_status text not null default 'not_screened'
    check (pii_screening_status in ('not_screened', 'passed', 'flagged', 'rejected')),
  pii_screening_notes text,
  status text not null default 'open'
    check (status in ('open', 'admin_review', 'approved', 'rejected', 'merged')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  constraint chk_fdh_glc_reviewed
    check (status not in ('approved', 'rejected', 'merged') or reviewed_at is not null),
  constraint chk_fdh_glc_pii_gate
    check (status <> 'approved' or pii_screening_status = 'passed'),
  -- A flagged/rejected-by-PII-screen candidate must never be approved by any
  -- later status transition without re-screening first — the gate above
  -- already blocks that, this is the mirror rule that rejected PII screening
  -- must not silently coexist with an approved governance status.
  constraint chk_fdh_glc_pii_rejected_not_approved
    check (pii_screening_status <> 'rejected' or status <> 'approved')
);
create index idx_fdh_glc_status on fdh_global_learning_candidates(status);
create index idx_fdh_glc_merchant on fdh_global_learning_candidates(merchant_id) where merchant_id is not null;

alter table fdh_global_learning_candidates enable row level security;
-- Deliberately no policy of any kind. See the comment block above.
