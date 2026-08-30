-- =============================================================================
-- FDH-12 — RETIREMENT STATEMENT INTELLIGENCE
--
-- Australian superannuation + India retirement statement evidence, canonical
-- Retirement integration via the generic import bridge, and strict
-- SMSF / Investment-Intelligence boundaries.
--
-- -----------------------------------------------------------------------------
-- MIGRATION NUMBER GOVERNANCE (spec section 164)
-- -----------------------------------------------------------------------------
-- Migration-number collisions are a recurring, serious problem in this project
-- (seven prior occurrences; see docs/architecture/ADR_MIGRATION_LINEAGE_
-- RECONCILIATION.md). This file was originally authored, PGlite-certified
-- and numbered 0111. On 2026-08-30, after that certification, a real
-- collision surfaced: `feature/mandatory-country-confirmation-beta-cleanup`
-- (commit `8621968`, unpushed) independently committed its own
-- `0111_mandatory_country_confirmation_delete_cascade_fix.sql` (MCC-14), and
-- the Product Owner had already been told that MCC-14's 0111 is next in line
-- for DEV application. FDH-12 was renumbered to 0112 instead — an EIGHTH
-- occurrence of the collision class. The SQL body below is unchanged from
-- the certified 0111 version; only the filename and this header's
-- self-references moved.
--
-- The number was originally chosen after scanning, fresh:
--
--   * every commit reachable from every local branch and every origin remote
--     ref (`git log --all --name-only -- 'supabase/migrations/*.sql'`);
--   * the working directory of every `git worktree list` entry, including
--     uncommitted files;
--   * `origin/main` @ 9e3cdec (top of chain there is 0106).
--
-- That scan found these numbers ALREADY CLAIMED above main's 0106:
--   0107  admin_recommendations_conditions_import_integrity   (unmerged)
--   0107  mandatory_country_confirmation_crud_and_onboarding  (unmerged — a
--         SEVENTH occurrence of the collision class, already present in the
--         repository's history before FDH-12 existed; resolved on that branch
--         by renumbering to 0108)
--   0108  mandatory_country_confirmation_crud_and_onboarding_fix (unmerged)
--   0109  admin_recommendation_upsert_atomicity              (unmerged)
--   0110  module11_ai_foundation                             (unmerged)
--
-- NOTE: `scripts/check-migration-versions.mjs` reports "next version is 0107"
-- because it only sees this branch. That is NOT the safe number. At the time
-- of the original scan, 0111 appeared to be the lowest number claimed by no
-- branch, no worktree and no remote ref — but the country-confirmation
-- branch above committed its own unpushed 0111 shortly afterward, invisible
-- to that scan. A fresh scan on 2026-08-30 confirmed 0112 is genuinely free
-- across every local branch, every worktree and every origin ref.
--
-- Recorded in docs/architecture/MIGRATION_REGISTRY.md.
--
-- -----------------------------------------------------------------------------
-- ADDITIVE ONLY
-- -----------------------------------------------------------------------------
-- This migration creates three new tables, widens two existing CHECK
-- constraints, adds three provenance columns and two functions. It drops no
-- table, drops no column, and changes no existing row's meaning.
--
-- -----------------------------------------------------------------------------
-- ARCHITECTURE — THE ONE FACT THAT SHAPES EVERYTHING BELOW
-- -----------------------------------------------------------------------------
-- Canonical Retirement in FHIP is a SUMMARY-BALANCE register. It has no event
-- ledger: no rollover table, no withdrawal table, no contribution history, no
-- fee/tax/insurance column anywhere. `retirement_accounts.current_balance` is
-- a directly-stored numeric that `lib/engines/dashboard.ts:582` sums into net
-- worth, and that is the entire canonical retirement value model.
--
-- Consequences, each of which is a spec requirement satisfied STRUCTURALLY
-- rather than by convention:
--
--   * spec 58-59: balance is a direct canonical field, so a safe field update
--     is the correct (and only possible) canonical application method.
--   * spec 60: the double-apply hazard ("import the +$10,000 contribution AND
--     separately raise the balance by $10,000") is unreachable, because
--     statement activities have NO canonical destination. There is exactly one
--     canonical write path — fdh12_apply_retirement_proposal() below — and it
--     writes only the columns in its own v_allowed array.
--   * spec 12-13, 40, 71: statement investment holdings land in
--     fdh_retirement_statement_positions and stop there. No apply function
--     accepts a position row. Net worth therefore cannot double-count.
--   * spec 41-42, 75-76: an internal super fee / insurance premium / rollover
--     / earning cannot become a household expense or income, because FDH-12
--     has no write path to income_sources, expenses, or fdh_transactions.
--
-- The complete authority model is docs/financial-data-hub/
-- FDH12_AUTHORITY_AND_MUTATION_MODEL.md.
--
-- -----------------------------------------------------------------------------
-- SMSF BOUNDARY (spec sections 10-11, 72-73) — DEFENCE IN DEPTH
-- -----------------------------------------------------------------------------
-- FHIP already owns SMSF (migrations 0084/0089/0090). FDH-12 must never import
-- an SMSF statement as ordinary super. Three independent refusals:
--
--   1. Detection — lib/financial-data-hub/retirement/smsfDetection.ts routes a
--      confidently-SMSF statement to ROUTE_TO_SMSF and an ambiguous one to
--      REVIEW_REQUIRED, before a proposal can exist.
--   2. This migration — fdh12_apply_retirement_proposal() refuses outright if
--      the target row has master_item_key = 'smsf' or an smsf_funds row,
--      returning SMSF_ACCOUNT_NOT_IMPORTABLE.
--   3. Migration 0090 — retirement_accounts_smsf_balance_guard() raises 42501
--      on ANY current_balance write to such a row outside the
--      fhip.smsf_balance_write='certified' window, which FDH-12 never opens.
--
-- Refusal 3 alone is sufficient; 1 and 2 exist so the user sees a routing
-- message rather than a raw Postgres error, and so the boundary is legible.
--
-- -----------------------------------------------------------------------------
-- GUARD MECHANISM — WHY BOTH KINDS APPEAR IN ONE MIGRATION
-- -----------------------------------------------------------------------------
-- This project has two established same-tenant authority guards, and they are
-- NOT interchangeable:
--
--   * FDH-11 (0106) gates on `auth.role() <> 'authenticated'`, correct when the
--     legitimate writer is a service-role client that bypasses RLS by
--     construction.
--   * FDH-9/FDH-10 (0091/0096) gate on
--     `current_setting('fhip.import_bridge_internal_write')`, correct when the
--     legitimate writer is a SECURITY DEFINER function that can set the GUC.
--
-- FDH-12 has both kinds of writer, so it uses both guards, each where it is
-- correct: the FDH-11 style on its three evidence tables (written by the
-- service-role processing service), and the FDH-9/10 GUC style inside
-- fdh12_apply_retirement_proposal() (a definer RPC).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- PART A — WIDEN EXISTING CLOSED VOCABULARIES (additive only)
--
-- fdh_document_audit_events.event_type. The full historical list is retained
-- and commented by originating migration, exactly as 0091/0096/0106 did. The
-- TS mirror is FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED in
-- lib/financial-data-hub/constants/enums.ts; tests/unit/fdh12SchemaContract.
-- test.ts asserts the two lists are identical.
-- ---------------------------------------------------------------------------

alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058).
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064).
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions (migration 0068).
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created',
      -- FDH-5 additions (migration 0071).
      'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
      'pdf_native_extraction_started', 'pdf_native_extraction_completed',
      'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
      'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed',
      -- FDH-7 additions (migration 0076).
      'transaction_split_created', 'transaction_approved', 'statement_approved',
      'statement_reopened', 'bulk_review_action_completed',
      -- FDH-9 additions (migration 0091).
      'payslip_extraction_completed', 'payslip_extraction_failed',
      'payroll_event_approved', 'income_proposal_generated',
      'income_proposal_applied', 'income_proposal_dismissed',
      -- FDH-10 additions (migration 0096).
      'liability_statement_extraction_completed',
      'liability_statement_extraction_failed',
      'liability_statement_approved',
      'liability_bank_match_completed',
      'liability_proposal_generated',
      'liability_proposal_applied',
      'liability_proposal_dismissed',
      -- FDH-11 additions (migration 0106).
      'investment_statement_extraction_completed',
      'investment_statement_extraction_failed',
      'investment_statement_account_matched',
      'investment_statement_security_matched',
      'investment_statement_reconciled',
      'investment_statement_bank_match_completed',
      'investment_statement_approved',
      'investment_statement_applied',
      'investment_statement_apply_rejected_stale',
      -- FDH-12 additions (spec sections 56, 95, 137).
      'retirement_statement_extraction_completed',
      'retirement_statement_extraction_failed',
      'retirement_statement_account_matched',
      'retirement_statement_payslip_matched',
      'retirement_statement_reconciled',
      'retirement_statement_bank_match_completed',
      'retirement_statement_routed_to_smsf',
      'retirement_statement_approved',
      'retirement_proposal_generated',
      'retirement_proposal_applied',
      'retirement_proposal_dismissed'
    ));


-- retirement_accounts.source_type — widened for import provenance (spec
-- section 103). Existing values are untouched; 'retirement_statement_import'
-- is added. Original CHECK was created by migration 0042 Part (II R3
-- publishing bridge).
alter table retirement_accounts
  drop constraint if exists retirement_accounts_source_type_check;
alter table retirement_accounts
  add constraint retirement_accounts_source_type_check
    check (source_type in (
      'manual',
      'investment_intelligence_published',
      'retirement_statement_import'
    ));


-- ---------------------------------------------------------------------------
-- PART B — fdh_retirement_statements: statement-level evidence
-- (spec sections 20, 50).
--
-- EVIDENCE, NOT A SECOND SOURCE OF RETIREMENT TRUTH (spec section 3). Nothing
-- reads this table to compute net worth, a projection, or a household total.
-- `canonical_account_id` is a plain uuid deliberately: a nullable FK would
-- imply this row co-owns the canonical account, and it does not. Ownership is
-- proven instead by fdh12_assert_retirement_statement_owner() below, which is
-- stricter than an FK because it checks the OWNER, not merely existence.
--
-- FIELD SELECTION (spec section 20's "do not blindly add every listed field").
-- Every money column below corresponds to a line that really appears on
-- Australian member statements and India EPF/NPS statements. Two fields from
-- the spec's illustrative list are deliberately ABSENT:
--   * a separate `distributions` column — on a super member statement,
--     internal distributions are indistinguishable from and reported within
--     investment earnings; a second column would invite the exact subtotal
--     double-count spec section 117 forbids. DISTRIBUTION survives as an
--     activity_type on the activity rows, where it belongs.
--   * a separate `interest` column — same reasoning; India EPF interest is
--     recorded as an INTEREST activity and rolls into investment_earnings.
-- ---------------------------------------------------------------------------

create table fdh_retirement_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,

  statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,

  -- Nullable: unresolved until account matching (spec 16-19) runs, or the user
  -- picks ADD NEW at review time. Plain uuid — see the header note above.
  canonical_account_id uuid,
  -- Nullable for the same reason. Which household member the statement belongs
  -- to (spec 15, 101, 112). Never inferred from balance or filename.
  retirement_member_id uuid,

  statement_type text not null check (statement_type in (
    'super_member_statement', 'super_annual_statement',
    'super_transaction_statement', 'super_contribution_statement',
    'account_based_pension_statement', 'retirement_statement_csv',
    'epf_passbook_statement', 'nps_transaction_statement'
  )),

  -- AU or IN. Spec 69-70: the statement's jurisdiction is a property of the
  -- ACCOUNT, never of the user's residence. A user living in Australia may
  -- legitimately hold an Indian EPF account and vice versa; nothing in FDH-12
  -- consults country_of_residence to accept or reject a statement.
  retirement_jurisdiction char(2) not null
    references countries(country_code) on delete restrict,

  -- What kind of retirement vehicle. Mirrors the canonical catalogue's
  -- vocabulary rather than inventing one (spec 21's "map into existing
  -- canonical vocabularies wherever available").
  account_type text not null check (account_type in (
    'industry_super', 'retail_super', 'defined_benefit',
    'account_based_pension', 'allocated_pension', 'transition_to_retirement',
    'annuity', 'overseas_pension', 'retirement_savings',
    'epf', 'ppf', 'nps',
    'unknown'
  )),

  fund_name text,
  -- Masked/last-digits only (spec 89). The CHECK is a mechanical backstop
  -- against a parser regression persisting a full member number, mirroring
  -- fdh_investment_statements' identical constraint (0106).
  masked_account_identifier text,
  nickname text,

  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  statement_date date,
  statement_start_date date,
  statement_end_date date,

  -- Balances. numeric(20,4) throughout — EXACT DECIMAL, never binary float
  -- (spec 142). Nullable because a statement that shows only a closing balance
  -- is valid evidence (spec 49) and must not be forced to invent an opening.
  opening_balance numeric(20,4),
  closing_balance numeric(20,4),

  -- Period movement totals, as PRINTED on the statement. These are SUMMARY
  -- figures (spec 118) and are never added to the activity rows — the
  -- reconciliation oracle consumes one or the other, never both, and
  -- lib/financial-data-hub/retirement/reconciliation.ts is where that rule
  -- lives. Same discipline as FDH-9's current-period-vs-YTD separation.
  employer_contributions numeric(20,4),
  personal_contributions numeric(20,4),
  salary_sacrifice numeric(20,4),
  government_contributions numeric(20,4),
  rollovers_in numeric(20,4),
  rollovers_out numeric(20,4),
  withdrawals numeric(20,4),
  pension_payments numeric(20,4),
  investment_earnings numeric(20,4),
  fees numeric(20,4),
  insurance_premiums numeric(20,4),
  tax numeric(20,4),

  -- Year-to-date / financial-year-to-date evidence, held in its own clearly
  -- named columns and NEVER added to the period columns above (spec 114-116).
  -- This is FDH-9's certified YTD discipline, applied verbatim: a parser that
  -- confuses the two produces an obviously wrong ytd_* figure rather than a
  -- silently doubled contribution.
  ytd_employer_contributions numeric(20,4),
  ytd_personal_contributions numeric(20,4),

  parser text,
  parser_version text,
  extraction_confidence numeric(5,4)
    check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),
  extraction_status text not null default 'pending'
    check (extraction_status in (
      'pending', 'extracted', 'extraction_failed',
      'ocr_required', 'password_required', 'manual_mapping_required'
    )),

  -- spec 47: never forced. A statement that omits activity detail is
  -- insufficient_data, not a false RECONCILED.
  reconciliation_status text not null default 'insufficient_data'
    check (reconciliation_status in ('reconciled', 'variance', 'insufficient_data')),
  reconciliation_variance numeric(20,4),

  -- Account matching outcome (spec 16-18).
  account_match_status text not null default 'not_attempted'
    check (account_match_status in (
      'matched', 'no_match', 'multiple_candidates', 'not_attempted', 'new_account_confirmed'
    )),
  account_match_candidates jsonb,

  -- SMSF routing (spec 10-11). 'routed_to_smsf' is terminal for FDH-12: such a
  -- statement never becomes an ordinary-super proposal.
  smsf_classification text not null default 'not_smsf'
    check (smsf_classification in ('not_smsf', 'possible_smsf', 'routed_to_smsf')),
  smsf_evidence jsonb,

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,

  -- Duplicate/revision provenance (spec 51, 54). Whole-document byte dedup is
  -- fdh_statement_uploads.file_hash, reused rather than duplicated.
  duplicate_of_statement_id uuid references fdh_retirement_statements(id) on delete set null,
  supersedes_statement_id uuid references fdh_retirement_statements(id) on delete set null,

  source_provenance text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_retirement_statements_masked_identifier
    check (masked_account_identifier is null or masked_account_identifier !~ '[0-9]{7,}'),
  constraint chk_fdh_retirement_statements_period
    check (statement_end_date is null or statement_start_date is null
           or statement_end_date >= statement_start_date),
  constraint chk_fdh_retirement_statements_approved_at
    check (approved_at is null or approval_status = 'approved'),
  constraint chk_fdh_retirement_statements_no_self_duplicate
    check (duplicate_of_statement_id is null or duplicate_of_statement_id <> id),
  constraint chk_fdh_retirement_statements_no_self_supersede
    check (supersedes_statement_id is null or supersedes_statement_id <> id),
  constraint chk_fdh_retirement_statements_jurisdiction
    check (retirement_jurisdiction in ('AU', 'IN'))
);

create index idx_fdh_retirement_statements_user on fdh_retirement_statements(user_id);
create index idx_fdh_retirement_statements_account on fdh_retirement_statements(canonical_account_id)
  where canonical_account_id is not null;
create index idx_fdh_retirement_statements_member on fdh_retirement_statements(retirement_member_id)
  where retirement_member_id is not null;
create index idx_fdh_retirement_statements_upload on fdh_retirement_statements(statement_upload_id);
create index idx_fdh_retirement_statements_match on fdh_retirement_statements(user_id, account_match_status)
  where account_match_status in ('no_match', 'multiple_candidates');

alter table fdh_retirement_statements enable row level security;
create policy "read own fdh_retirement_statements" on fdh_retirement_statements
  for select using (auth.uid() = user_id);
create policy "insert own fdh_retirement_statements" on fdh_retirement_statements
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_retirement_statements" on fdh_retirement_statements
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No DELETE policy, deliberately — same shape as 0106. Evidence is purged
-- through the FDH-3 lifecycle, not deleted ad hoc by the client.


-- ---------------------------------------------------------------------------
-- PART C — fdh_retirement_statement_activities: line-level evidence
-- (spec section 21).
--
-- These rows are the statement's own account of what happened inside the fund.
-- They have NO canonical destination (see header). They exist to be
-- reconciled, matched to payslip and bank evidence, displayed, and retained.
--
-- AMOUNT IS A POSITIVE MAGNITUDE. Direction is a property of activity_type,
-- not of the sign — the same discipline as fdh_investment_statement_activities
-- (0106). A FEE of 100.00 reduces the balance; the row does not store -100.
-- ---------------------------------------------------------------------------

create table fdh_retirement_statement_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_id uuid not null references fdh_retirement_statements(id) on delete cascade,

  -- The complete spec-section-21 vocabulary. UNKNOWN is retained rather than
  -- guessed at (spec 143: rows must fail safely, never silently become zero or
  -- get forced into a wrong bucket).
  activity_type text not null check (activity_type in (
    'EMPLOYER_CONTRIBUTION', 'PERSONAL_CONTRIBUTION', 'SALARY_SACRIFICE',
    'GOVERNMENT_CONTRIBUTION', 'ROLLOVER_IN', 'ROLLOVER_OUT',
    'INVESTMENT_EARNINGS', 'INTEREST', 'DISTRIBUTION',
    'FEE', 'INSURANCE_PREMIUM', 'TAX',
    'PENSION_PAYMENT', 'WITHDRAWAL', 'ADJUSTMENT', 'OTHER', 'UNKNOWN'
  )),

  activity_date date,
  -- Distinct from activity_date: super contributions commonly settle in the
  -- fund days or weeks after the payroll date they relate to (spec 25, 67).
  -- Keeping both is what lets the reconciliation window be bounded and
  -- defensible instead of requiring same-day equality.
  effective_period_start date,
  effective_period_end date,

  amount numeric(20,4) not null check (amount >= 0),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  description_raw text,
  -- Employer attribution for contribution rows, folded for matching. Spec 26
  -- forbids matching on amount alone; this is the column that makes employer a
  -- required part of the key.
  employer_name_raw text,
  employer_normalised text,

  -- IS THIS ROW A SUMMARY TOTAL? (spec 118, 116). An annual statement often
  -- prints "Total employer contributions 12,000.00" alongside twelve monthly
  -- lines. Marking the total as a summary row is what stops the reconciliation
  -- oracle and the dedup engine from treating it as a thirteenth event.
  is_summary_total boolean not null default false,
  -- IS THIS ROW A YEAR-TO-DATE FIGURE? (spec 114-115). FDH-9's certified
  -- discipline, same column name and same meaning.
  is_year_to_date boolean not null default false,

  -- Payslip reconciliation (spec 23-27, 64-67).
  payslip_match_status text not null default 'not_attempted'
    check (payslip_match_status in (
      'matched', 'no_match', 'multiple_candidates', 'not_attempted',
      'payslip_evidence_not_available', 'variance_review_required'
    )),
  matched_payroll_event_id uuid references fdh_payroll_events(id) on delete set null,
  payslip_match_variance numeric(20,4),
  payslip_match_candidates jsonb,

  -- Bank reconciliation (spec 77-81).
  bank_match_status text not null default 'not_attempted'
    check (bank_match_status in (
      'matched', 'no_match', 'multiple_candidates', 'not_attempted',
      'bank_evidence_not_available', 'not_expected'
    )),
  linked_transaction_id uuid references fdh_transactions(id) on delete set null,
  bank_match_candidates jsonb,

  -- Rollover pairing (spec 33-35). Links a ROLLOVER_OUT on one fund's
  -- statement to the ROLLOVER_IN on another's, so the UI can show one transfer
  -- rather than two unrelated movements, and so the harness can prove the
  -- household total did not change.
  rollover_counterpart_activity_id uuid references fdh_retirement_statement_activities(id) on delete set null,
  rollover_match_status text not null default 'not_attempted'
    check (rollover_match_status in ('matched', 'no_match', 'multiple_candidates', 'not_attempted')),

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),

  -- Stable per-row identity for deduplication across overlapping and
  -- annual-vs-monthly statements (spec 52-53). Derived from the economic
  -- content of the row, never from a row number.
  activity_fingerprint text,
  duplicate_of_activity_id uuid references fdh_retirement_statement_activities(id) on delete set null,

  source_row_number int check (source_row_number is null or source_row_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_fdh_retirement_activities_no_self_counterpart
    check (rollover_counterpart_activity_id is null or rollover_counterpart_activity_id <> id),
  constraint chk_fdh_retirement_activities_no_self_duplicate
    check (duplicate_of_activity_id is null or duplicate_of_activity_id <> id),
  constraint chk_fdh_retirement_activities_period
    check (effective_period_end is null or effective_period_start is null
           or effective_period_end >= effective_period_start)
);

create index idx_fdh_retirement_activities_user on fdh_retirement_statement_activities(user_id);
create index idx_fdh_retirement_activities_statement on fdh_retirement_statement_activities(statement_id);
create index idx_fdh_retirement_activities_type on fdh_retirement_statement_activities(statement_id, activity_type);
create index idx_fdh_retirement_activities_payslip on fdh_retirement_statement_activities(user_id, payslip_match_status)
  where payslip_match_status in ('no_match', 'multiple_candidates', 'variance_review_required');
create index idx_fdh_retirement_activities_bank on fdh_retirement_statement_activities(user_id, bank_match_status)
  where bank_match_status in ('no_match', 'multiple_candidates');
create index idx_fdh_retirement_activities_payroll_event on fdh_retirement_statement_activities(matched_payroll_event_id)
  where matched_payroll_event_id is not null;
create index idx_fdh_retirement_activities_linked_txn on fdh_retirement_statement_activities(linked_transaction_id)
  where linked_transaction_id is not null;

-- DEDUPLICATION (spec 51-53). One fingerprint identifies one economic activity
-- per user. Partial, because a row whose fingerprint could not be derived must
-- not collide with every other such row. This unique index is the DB-level
-- backstop behind the application's own dedup: it makes "duplicate activities
-- = 0" a structural guarantee rather than a code path that could regress.
create unique index uq_fdh_retirement_activities_fingerprint
  on fdh_retirement_statement_activities(user_id, activity_fingerprint)
  where activity_fingerprint is not null;

-- ONE PAYSLIP CONTRIBUTION IS EVIDENCE FOR AT MOST ONE FUND CONTRIBUTION
-- (spec 22, 64, 120). Without this, two fund activity rows could each claim
-- the same payslip, which is one of the two ways $1,000 + $1,000 could become
-- $2,000. The other way — posting both to canonical — is impossible by
-- construction (see header).
create unique index uq_fdh_retirement_activities_payroll_event
  on fdh_retirement_statement_activities(matched_payroll_event_id)
  where matched_payroll_event_id is not null;

-- Likewise one bank transaction corroborates at most one retirement activity
-- (spec 38, 78).
create unique index uq_fdh_retirement_activities_bank_txn
  on fdh_retirement_statement_activities(linked_transaction_id)
  where linked_transaction_id is not null;

alter table fdh_retirement_statement_activities enable row level security;
create policy "read own fdh_retirement_statement_activities" on fdh_retirement_statement_activities
  for select using (auth.uid() = user_id);
create policy "insert own fdh_retirement_statement_activities" on fdh_retirement_statement_activities
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_retirement_statement_activities" on fdh_retirement_statement_activities
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART D — fdh_retirement_statement_positions: investment holdings shown
-- INSIDE a retirement account (spec sections 12-13, 40, 71).
--
-- THIS TABLE IS TERMINAL. There is no apply function that accepts a position
-- row, no allow-list that names one, and no canonical column anywhere that a
-- position could be written to. It exists so the user can SEE what their super
-- is invested in, and so the review UI can show it — nothing more.
--
-- That is the whole answer to spec section 13's highest-risk net-worth rule:
-- super account $200,000 + statement holdings $200,000 contributes $200,000,
-- because only retirement_accounts.current_balance is ever summed and these
-- rows have no path to it. Deliberately NO apply_status column: a status
-- column would imply a destination.
-- ---------------------------------------------------------------------------

create table fdh_retirement_statement_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_id uuid not null references fdh_retirement_statements(id) on delete cascade,

  option_name_raw text not null,
  -- Investment option / asset class as printed. Free text: super funds name
  -- their options idiosyncratically ("High Growth", "Balanced (MySuper)") and
  -- FDH-12 does not attempt to map them to a canonical instrument.
  asset_class_raw text,
  ticker_raw text,
  isin text,

  units numeric(20,6),
  unit_price numeric(20,6),
  market_value numeric(20,4),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,
  valuation_date date,

  source_row_number int check (source_row_number is null or source_row_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_fdh_retirement_positions_user on fdh_retirement_statement_positions(user_id);
create index idx_fdh_retirement_positions_statement on fdh_retirement_statement_positions(statement_id);

alter table fdh_retirement_statement_positions enable row level security;
create policy "read own fdh_retirement_statement_positions" on fdh_retirement_statement_positions
  for select using (auth.uid() = user_id);
create policy "insert own fdh_retirement_statement_positions" on fdh_retirement_statement_positions
  for insert with check (auth.uid() = user_id);
create policy "update own fdh_retirement_statement_positions" on fdh_retirement_statement_positions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- PART E — SAME-TENANT OWNERSHIP GUARDS (spec sections 97-102).
--
-- RLS proves the ROW belongs to the caller. These triggers prove every row it
-- REFERENCES does too. `security definer` so the function can read rows RLS
-- would hide from the caller — which is the entire point: without it, a
-- cross-tenant reference would look like a non-existent one and the check
-- would be indistinguishable from an FK.
-- ---------------------------------------------------------------------------

create or replace function fdh12_assert_retirement_statement_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.statement_upload_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statements: statement_upload_id % does not exist', new.statement_upload_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statements: cross-tenant reference — document % belongs to a different user', new.statement_upload_id;
    end if;
  end if;

  -- spec 98: Tenant A's statement must never target Tenant B's retirement
  -- account. canonical_account_id has no FK (see PART B header), so this
  -- trigger is the ONLY thing standing between a forged uuid and a
  -- cross-tenant apply. It is deliberately stricter than an FK would be.
  if new.canonical_account_id is not null then
    select user_id into ref_owner from retirement_accounts where id = new.canonical_account_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statements: canonical_account_id % does not exist', new.canonical_account_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statements: cross-tenant reference — retirement account % belongs to a different user (spec section 98)', new.canonical_account_id;
    end if;
  end if;

  -- spec 101: nor attach a statement to another user's Self/Spouse member row.
  if new.retirement_member_id is not null then
    select user_id into ref_owner from retirement_members where id = new.retirement_member_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statements: retirement_member_id % does not exist', new.retirement_member_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statements: cross-tenant reference — retirement member % belongs to a different user (spec section 101)', new.retirement_member_id;
    end if;
  end if;

  if new.duplicate_of_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.duplicate_of_statement_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statements: duplicate_of_statement_id % does not exist', new.duplicate_of_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statements: cross-tenant reference — statement % belongs to a different user', new.duplicate_of_statement_id;
    end if;
  end if;

  if new.supersedes_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.supersedes_statement_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statements: supersedes_statement_id % does not exist', new.supersedes_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statements: cross-tenant reference — statement % belongs to a different user', new.supersedes_statement_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_statements_owner
  before insert or update of user_id, statement_upload_id, canonical_account_id,
                             retirement_member_id, duplicate_of_statement_id,
                             supersedes_statement_id
  on fdh_retirement_statements
  for each row execute function fdh12_assert_retirement_statement_owner();


create or replace function fdh12_assert_retirement_activity_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_retirement_statements where id = new.statement_id;
  if ref_owner is null then
    raise exception 'fdh_retirement_statement_activities: statement_id % does not exist', new.statement_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fdh_retirement_statement_activities: cross-tenant reference — statement % belongs to a different user', new.statement_id;
  end if;

  -- spec 100: Tenant A's retirement statement must never link Tenant B's
  -- payslip.
  if new.matched_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.matched_payroll_event_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statement_activities: matched_payroll_event_id % does not exist', new.matched_payroll_event_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statement_activities: cross-tenant reference — payslip % belongs to a different user (spec section 100)', new.matched_payroll_event_id;
    end if;
  end if;

  -- spec 99: nor link Tenant B's bank transaction.
  if new.linked_transaction_id is not null then
    select user_id into ref_owner from fdh_transactions where id = new.linked_transaction_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statement_activities: linked_transaction_id % does not exist', new.linked_transaction_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statement_activities: cross-tenant reference — bank transaction % belongs to a different user (spec section 99)', new.linked_transaction_id;
    end if;
  end if;

  if new.rollover_counterpart_activity_id is not null then
    select user_id into ref_owner from fdh_retirement_statement_activities where id = new.rollover_counterpart_activity_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statement_activities: rollover_counterpart_activity_id % does not exist', new.rollover_counterpart_activity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statement_activities: cross-tenant reference — activity % belongs to a different user', new.rollover_counterpart_activity_id;
    end if;
  end if;

  if new.duplicate_of_activity_id is not null then
    select user_id into ref_owner from fdh_retirement_statement_activities where id = new.duplicate_of_activity_id;
    if ref_owner is null then
      raise exception 'fdh_retirement_statement_activities: duplicate_of_activity_id % does not exist', new.duplicate_of_activity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fdh_retirement_statement_activities: cross-tenant reference — activity % belongs to a different user', new.duplicate_of_activity_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_activities_owner
  before insert or update of user_id, statement_id, matched_payroll_event_id,
                             linked_transaction_id, rollover_counterpart_activity_id,
                             duplicate_of_activity_id
  on fdh_retirement_statement_activities
  for each row execute function fdh12_assert_retirement_activity_owner();


create or replace function fdh12_assert_retirement_position_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_retirement_statements where id = new.statement_id;
  if ref_owner is null then
    raise exception 'fdh_retirement_statement_positions: statement_id % does not exist', new.statement_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fdh_retirement_statement_positions: cross-tenant reference — statement % belongs to a different user', new.statement_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_positions_owner
  before insert or update of user_id, statement_id
  on fdh_retirement_statement_positions
  for each row execute function fdh12_assert_retirement_position_owner();


-- ---------------------------------------------------------------------------
-- PART F — AUTHORITATIVE-WRITE HARDENING (spec section 96).
--
-- "Owning the row must not let the user forge RECONCILED, account matched,
-- payslip matched, approved system contribution, applied canonical state via
-- direct REST."
--
-- FDH-11 pattern (`auth.role() <> 'authenticated'`), because these three
-- tables' legitimate writer is the service-role processing service in
-- lib/financial-data-hub/services/retirementStatementProcessingService.ts,
-- which bypasses RLS and this trigger by construction.
--
-- What is LEFT writable by the authenticated role is deliberate and is the
-- user-correctable surface (spec 95): fund_name, nickname,
-- masked_account_identifier, the statement dates, review_status,
-- supersedes_statement_id, source_provenance. Those are the fields a user may
-- legitimately correct on their own evidence.
-- ---------------------------------------------------------------------------

create or replace function fdh12_retirement_statements_assert_authoritative_write() returns trigger as $$
begin
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.canonical_account_id is distinct from old.canonical_account_id
     or new.retirement_member_id is distinct from old.retirement_member_id
     or new.statement_type is distinct from old.statement_type
     or new.retirement_jurisdiction is distinct from old.retirement_jurisdiction
     or new.account_type is distinct from old.account_type
     or new.currency_code is distinct from old.currency_code
     or new.opening_balance is distinct from old.opening_balance
     or new.closing_balance is distinct from old.closing_balance
     or new.employer_contributions is distinct from old.employer_contributions
     or new.personal_contributions is distinct from old.personal_contributions
     or new.salary_sacrifice is distinct from old.salary_sacrifice
     or new.government_contributions is distinct from old.government_contributions
     or new.rollovers_in is distinct from old.rollovers_in
     or new.rollovers_out is distinct from old.rollovers_out
     or new.withdrawals is distinct from old.withdrawals
     or new.pension_payments is distinct from old.pension_payments
     or new.investment_earnings is distinct from old.investment_earnings
     or new.fees is distinct from old.fees
     or new.insurance_premiums is distinct from old.insurance_premiums
     or new.tax is distinct from old.tax
     or new.ytd_employer_contributions is distinct from old.ytd_employer_contributions
     or new.ytd_personal_contributions is distinct from old.ytd_personal_contributions
     or new.parser is distinct from old.parser
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.extraction_status is distinct from old.extraction_status
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.account_match_status is distinct from old.account_match_status
     or new.account_match_candidates is distinct from old.account_match_candidates
     or new.smsf_classification is distinct from old.smsf_classification
     or new.smsf_evidence is distinct from old.smsf_evidence
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.duplicate_of_statement_id is distinct from old.duplicate_of_statement_id
  then
    raise exception 'fdh_retirement_statements: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_statements_authoritative_write
  before update on fdh_retirement_statements
  for each row execute function fdh12_retirement_statements_assert_authoritative_write();


create or replace function fdh12_retirement_activities_assert_authoritative_write() returns trigger as $$
begin
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.activity_type is distinct from old.activity_type
     or new.amount is distinct from old.amount
     or new.currency_code is distinct from old.currency_code
     or new.activity_date is distinct from old.activity_date
     or new.effective_period_start is distinct from old.effective_period_start
     or new.effective_period_end is distinct from old.effective_period_end
     or new.employer_normalised is distinct from old.employer_normalised
     or new.is_summary_total is distinct from old.is_summary_total
     or new.is_year_to_date is distinct from old.is_year_to_date
     or new.payslip_match_status is distinct from old.payslip_match_status
     or new.matched_payroll_event_id is distinct from old.matched_payroll_event_id
     or new.payslip_match_variance is distinct from old.payslip_match_variance
     or new.payslip_match_candidates is distinct from old.payslip_match_candidates
     or new.bank_match_status is distinct from old.bank_match_status
     or new.linked_transaction_id is distinct from old.linked_transaction_id
     or new.bank_match_candidates is distinct from old.bank_match_candidates
     or new.rollover_counterpart_activity_id is distinct from old.rollover_counterpart_activity_id
     or new.rollover_match_status is distinct from old.rollover_match_status
     or new.activity_fingerprint is distinct from old.activity_fingerprint
     or new.duplicate_of_activity_id is distinct from old.duplicate_of_activity_id
  then
    raise exception 'fdh_retirement_statement_activities: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_activities_authoritative_write
  before update on fdh_retirement_statement_activities
  for each row execute function fdh12_retirement_activities_assert_authoritative_write();


create or replace function fdh12_retirement_positions_assert_authoritative_write() returns trigger as $$
begin
  if auth.role() <> 'authenticated' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.statement_id is distinct from old.statement_id
     or new.units is distinct from old.units
     or new.unit_price is distinct from old.unit_price
     or new.market_value is distinct from old.market_value
     or new.currency_code is distinct from old.currency_code
     or new.valuation_date is distinct from old.valuation_date
  then
    raise exception 'fdh_retirement_statement_positions: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_retirement_positions_authoritative_write
  before update on fdh_retirement_statement_positions
  for each row execute function fdh12_retirement_positions_assert_authoritative_write();


-- ---------------------------------------------------------------------------
-- PART G — GENERIC IMPORT BRIDGE EXTENSION (spec section 104).
--
-- `target_domain = 'retirement'` and `source_kind = 'retirement_statement'`
-- have been permitted by fhip_import_proposals' and fhip_import_applications'
-- CHECK constraints since migration 0091 — reserved deliberately, never used.
-- FDH-12 is that later use. What is added here is only the provenance column,
-- following the FDH-10 `source_liability_statement_id` precedent exactly: a
-- named nullable FK per source kind, never a polymorphic (type, id) pair, so
-- a real same-tenant ownership trigger remains possible.
-- ---------------------------------------------------------------------------

alter table fhip_import_proposals
  add column if not exists source_retirement_statement_id uuid
    references fdh_retirement_statements(id) on delete set null;
create index if not exists idx_fhip_import_proposals_retirement_statement
  on fhip_import_proposals(source_retirement_statement_id)
  where source_retirement_statement_id is not null;

alter table fhip_import_applications
  add column if not exists source_retirement_statement_id uuid
    references fdh_retirement_statements(id) on delete set null;

-- Canonical provenance columns (spec 103). Mirrors income_sources (0091 Part C)
-- and liabilities (0096) exactly. `source_type` was widened in PART A.
alter table retirement_accounts
  add column if not exists last_import_application_id uuid
    references fhip_import_applications(id) on delete set null;
alter table retirement_accounts
  add column if not exists last_imported_at timestamptz;


-- ---------------------------------------------------------------------------
-- EXTEND THE BRIDGE'S OWN CROSS-TENANT GUARDS FOR THE RETIREMENT DOMAIN.
--
-- `fdh9_assert_proposal_owner()` and `fdh9_assert_application_owner()`
-- (migration 0091, extended by 0096 for liability) FAIL CLOSED on an
-- unrecognised `target_domain`:
--
--     raise exception 'fhip_import_proposals: target_domain % has no
--                      implemented target guard', new.target_domain;
--
-- 0091's own comment states the intent exactly: "a future adapter cannot ship
-- a target without also extending this guard. Failing CLOSED is deliberate."
-- FDH-12 is that future adapter, so it extends the guard rather than working
-- around it. Without this, every retirement proposal carrying a target would
-- be rejected outright — which is the correct behaviour of the existing
-- design, and is how this omission was caught (by
-- `scripts/fdh12_certification.mjs` section 6, not by inspection).
--
-- Both functions are re-created WHOLE, retaining the income and liability
-- branches byte-for-byte, with a `retirement` branch added — the same shape
-- 0096 used when it added `liability`. A single guard function per table is
-- deliberate: a second, parallel FDH-12-only trigger would leave two places to
-- keep correct, and the fail-closed `else` would still have rejected us.
-- ---------------------------------------------------------------------------

create or replace function fdh9_assert_proposal_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_payroll_event_id % does not exist', new.source_payroll_event_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_liability_statement_id % does not exist', new.source_liability_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  -- FDH-12 addition.
  if new.source_retirement_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.source_retirement_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_retirement_statement_id % does not exist', new.source_retirement_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — retirement statement % belongs to a different user', new.source_retirement_statement_id;
    end if;
  end if;

  if new.target_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in income_sources', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in liabilities', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
      end if;
    -- FDH-12 addition. This is spec section 98's "Tenant A statement targeting
    -- Tenant B retirement account: BLOCKED" enforced at the bridge as well as
    -- on the statement row itself.
    elsif new.target_domain = 'retirement' then
      select user_id into ref_owner from retirement_accounts where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in retirement_accounts', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — retirement account % belongs to a different user (forged retirement target — spec section 98)', new.target_entity_id;
      end if;
    else
      raise exception 'fhip_import_proposals: target_domain % has no implemented target guard', new.target_domain;
    end if;
  end if;

  if new.duplicate_of_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate income entry % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate liability % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'retirement' then
      select user_id into ref_owner from retirement_accounts where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate retirement account % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- The trigger must also fire on the new column.
drop trigger if exists trg_fhip_import_proposals_owner on fhip_import_proposals;
create trigger trg_fhip_import_proposals_owner
  before insert or update of user_id, source_payroll_event_id, source_liability_statement_id,
                             source_retirement_statement_id, target_entity_id, target_domain,
                             duplicate_of_entity_id
  on fhip_import_proposals
  for each row execute function fdh9_assert_proposal_owner();


create or replace function fdh9_assert_application_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_applications: proposal_id % does not exist', new.proposal_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fhip_import_applications: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;

  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  -- FDH-12 addition.
  if new.source_retirement_statement_id is not null then
    select user_id into ref_owner from fdh_retirement_statements where id = new.source_retirement_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — retirement statement % belongs to a different user', new.source_retirement_statement_id;
    end if;
  end if;

  if new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in income_sources', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
    end if;
  elsif new.target_domain = 'liability' then
    select user_id into ref_owner from liabilities where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in liabilities', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
    end if;
  -- FDH-12 addition.
  elsif new.target_domain = 'retirement' then
    select user_id into ref_owner from retirement_accounts where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in retirement_accounts', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — retirement account % belongs to a different user (forged retirement target — spec section 98)', new.target_entity_id;
    end if;
  else
    raise exception 'fhip_import_applications: target_domain % has no implemented target guard', new.target_domain;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fhip_import_applications_owner on fhip_import_applications;
create trigger trg_fhip_import_applications_owner
  before insert or update on fhip_import_applications
  for each row execute function fdh9_assert_application_owner();


-- ---------------------------------------------------------------------------
-- PART H — fdh12_approve_retirement_statement(): the ONE legitimate way to
-- move a retirement statement's approval_status to 'approved' (spec 56).
--
-- Canonical Retirement is untouched by this call. Approving EVIDENCE is not
-- applying it — that distinction is the whole of spec section 56, and this
-- function is where it is enforced: it writes to fdh_retirement_statements and
-- to nothing else.
-- ---------------------------------------------------------------------------

create or replace function fdh12_approve_retirement_statement(p_statement_id uuid)
returns jsonb as $$
declare
  v_uid uuid;
  v_stmt record;
  v_unresolved int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh12_approve_retirement_statement: authentication required';
  end if;

  select * into v_stmt from fdh_retirement_statements
    where id = p_statement_id and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'That retirement statement could not be found.');
  end if;

  if v_stmt.approval_status = 'approved' then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_APPROVED');
  end if;

  -- spec 11: an SMSF-routed statement is terminal for FDH-12.
  if v_stmt.smsf_classification = 'routed_to_smsf' then
    return jsonb_build_object('ok', false, 'code', 'ROUTED_TO_SMSF',
      'error', 'This looks like a self-managed super fund statement. Manage it in the SMSF section instead.');
  end if;
  if v_stmt.smsf_classification = 'possible_smsf' then
    return jsonb_build_object('ok', false, 'code', 'SMSF_REVIEW_REQUIRED',
      'error', 'We could not tell whether this is a self-managed super fund statement. Confirm before continuing.');
  end if;

  if v_stmt.extraction_status <> 'extracted' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EXTRACTED',
      'error', 'This statement has not been read successfully yet.');
  end if;

  -- Unresolved review items block approval (spec 27, 66, 80).
  select count(*) into v_unresolved from fdh_retirement_statement_activities
    where statement_id = p_statement_id
      and (payslip_match_status in ('multiple_candidates', 'variance_review_required')
           or bank_match_status = 'multiple_candidates'
           or review_status in ('pending', 'in_review'));
  if v_unresolved > 0 then
    return jsonb_build_object('ok', false, 'code', 'REVIEW_REQUIRED',
      'error', format('%s item(s) still need your review before this statement can be approved.', v_unresolved));
  end if;

  update fdh_retirement_statements
    set approval_status = 'approved', approved_at = now(), approved_by = v_uid,
        review_status = case when review_status in ('pending', 'in_review') then 'resolved' else review_status end,
        updated_at = now()
    where id = p_statement_id and user_id = v_uid and approval_status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPROVED', 'error', 'This statement was already approved.');
  end if;

  return jsonb_build_object('ok', true, 'code', 'APPROVED');
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh12_approve_retirement_statement(uuid) from public;
grant execute on function fdh12_approve_retirement_statement(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- PART I — fdh12_apply_retirement_proposal(): THE ONLY PATH BY WHICH A
-- RETIREMENT STATEMENT CAN EVER CHANGE CANONICAL RETIREMENT (spec 56, 103-111).
--
-- Modelled on fdh10_apply_liability_proposal() (migration 0096 Part I), with
-- four retirement-specific additions:
--
--   1. SMSF REFUSAL (spec 10, 72). Refuses before any write if the target is
--      an SMSF row. Migration 0090's guard would refuse anyway; this one
--      refuses with a routing message instead of a raw 42501.
--   2. TARGET RETIREMENT AGE IS NOT IN v_allowed (spec 61, 113). Neither
--      retirement_members.target_retirement_age nor the legacy
--      retirement_accounts.target_retirement_age can be reached from here.
--      A forged proposal naming either is refused FORBIDDEN_FIELD.
--   3. ADD NEW CREATES A CUSTOM ROW. master_item_key is forced NULL, which
--      (a) keeps the row outside uq_retirement_accounts_user_master so Self
--      and Spouse can each hold their own funds (documented gap GAP-R1), and
--      (b) makes it structurally impossible for an import to create an SMSF
--      row, since SMSF is identified solely by master_item_key = 'smsf'.
--   4. STATEMENT ACTIVITIES ARE NEVER POSTED. This function writes exactly the
--      columns in v_allowed on exactly one retirement_accounts row. It touches
--      no activity, no position, no income row, no expense row, no
--      transaction. That is spec section 60's double-apply control, enforced
--      by the absence of any code that could do otherwise.
--
-- ATOMICITY (spec 105): this is a FUNCTION, not a PROCEDURE. It has no COMMIT
-- of its own, so an exception at any point aborts the whole enclosing
-- transaction and undoes every write it made, including the proposal claim.
-- ---------------------------------------------------------------------------

create or replace function fdh12_apply_retirement_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_account record;
  v_is_smsf boolean;
  -- THE SECURITY ALLOW-LIST. Mirrors RETIREMENT_APPLICABLE_FIELDS in
  -- lib/import-bridge/adapters/retirementAdapter.ts. Note what is ABSENT:
  -- target_retirement_age (spec 61), master_item_key, is_active, user_id,
  -- retirement_member_id, source_type, ii_publication_id, notes.
  v_allowed constant text[] := array[
    'account_name', 'account_type', 'current_balance', 'currency_code',
    'country_code', 'owner', 'employer_contribution', 'personal_contribution',
    'contribution_frequency'
  ];
  v_kinds constant jsonb := jsonb_build_object(
    'account_name', 'text', 'account_type', 'enum', 'current_balance', 'money',
    'currency_code', 'enum', 'country_code', 'enum', 'owner', 'enum',
    'employer_contribution', 'money', 'personal_contribution', 'money',
    'contribution_frequency', 'enum'
  );
  v_selected text[];
  v_forbidden text[];
  v_known text[];
  v_field record;
  v_live_text text;
  v_set_parts text[] := array[]::text[];
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_applied_fields text[] := array[]::text[];
  v_previous jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_target_id uuid;
  v_application_id uuid;
  v_member_id uuid;
  v_kind text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh12_apply_retirement_proposal: authentication required';
  end if;
  if p_decision not in ('add_new', 'update_existing', 'apply_selected_fields', 'keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  -- Same answer for "does not exist" and "belongs to someone else" — a
  -- cross-tenant probe learns nothing from the response.
  if not found or v_proposal.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'retirement' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is for a part of your data this function does not handle.');
  end if;

  -- KEEP EXISTING (spec 110): no canonical write of any kind.
  if p_decision = 'keep_existing' then
    if v_proposal.status <> 'ready' then
      return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is no longer open.');
    end if;
    perform set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set status = 'dismissed', dismissed_at = now() where id = p_proposal_id;
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', true, 'outcome', 'kept_existing');
  end if;

  if v_proposal.status <> 'ready' then
    return jsonb_build_object(
      'ok', false,
      'code', case when v_proposal.status = 'applied' then 'ALREADY_APPLIED' else 'PROPOSAL_NOT_ACTIONABLE' end,
      'error', case when v_proposal.status = 'applied'
        then 'This proposal has already been applied to your retirement accounts.'
        else 'That proposal is no longer open.' end
    );
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing retirement account to update.');
  end if;

  -- NO SILENT APPLY (spec 56): the underlying statement evidence must have
  -- been approved by the user first. A proposal alone is not authority.
  if v_proposal.source_retirement_statement_id is not null then
    perform 1 from fdh_retirement_statements
      where id = v_proposal.source_retirement_statement_id
        and user_id = v_uid
        and approval_status = 'approved';
    if not found then
      return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_APPROVED',
        'error', 'Approve the statement evidence before applying it to your retirement accounts.');
    end if;
  end if;

  if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := coalesce(p_selected_fields, array[]::text[]);
  end if;
  if v_selected is null then v_selected := array[]::text[]; end if;

  -- ALLOW-LIST, checked before anything touches a field name (spec 104's
  -- "never use unrestricted dynamic table writes").
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_allowed));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields cannot be changed by an import.', 'fields', to_jsonb(v_forbidden));
  end if;

  select array_agg(field_name) into v_known from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  if v_known is null then v_known := array[]::text[]; end if;
  select array_agg(f) into v_forbidden from unnest(v_selected) f where not (f = any(v_known));
  if v_forbidden is not null and array_length(v_forbidden, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD', 'error', 'One or more selected fields are not part of this proposal.', 'fields', to_jsonb(v_forbidden));
  end if;
  if array_length(v_selected, 1) is null or array_length(v_selected, 1) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_FIELDS_SELECTED', 'error', 'Choose at least one detail to apply.');
  end if;

  if p_decision = 'add_new' then
    if not ('account_name' = any(v_selected)) or not ('current_balance' = any(v_selected))
       or not ('currency_code' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new retirement account needs a name, a balance and a currency.');
    end if;
  end if;

  if p_decision <> 'add_new' then
    select * into v_account from retirement_accounts
      where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The retirement account this proposal refers to could not be found.');
    end if;

    -- SMSF REFUSAL (spec 10, 72). Checked before any staleness work so the
    -- user gets the routing message rather than a confusing STALE result.
    select (v_account.master_item_key = 'smsf')
           or exists (select 1 from smsf_funds sf where sf.retirement_account_id = v_account.id)
      into v_is_smsf;
    if v_is_smsf then
      return jsonb_build_object('ok', false, 'code', 'SMSF_ACCOUNT_NOT_IMPORTABLE',
        'error', 'This is a self-managed super fund. Update it in the SMSF section, which owns its balance.');
    end if;

    -- STALENESS (spec 108). The live row is re-read and every SELECTED field
    -- compared against the snapshot taken when the proposal was generated.
    -- The mapping below is hard-coded per column on purpose: no dynamic column
    -- name from proposal data ever reaches SQL.
    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'account_name'            then v_account.account_name
        when 'account_type'            then v_account.account_type
        when 'currency_code'           then v_account.currency_code
        when 'country_code'            then v_account.country_code
        when 'owner'                   then v_account.owner
        when 'contribution_frequency'  then v_account.contribution_frequency
        when 'current_balance'         then case when v_account.current_balance is null then null else round(v_account.current_balance, 2)::text end
        when 'employer_contribution'   then case when v_account.employer_contribution is null then null else round(v_account.employer_contribution, 2)::text end
        when 'personal_contribution'   then case when v_account.personal_contribution is null then null else round(v_account.personal_contribution, 2)::text end
        else null
      end;
      if v_field.value_kind in ('text', 'enum') then
        v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
      end if;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object(
          'ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your retirement details changed after this proposal was prepared, so it was not applied.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text
        );
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  for v_field in
    select pf.field_name, pf.value_kind, pf.proposed_value
    from fhip_import_proposal_fields pf
    where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
  loop
    v_kind := v_kinds ->> v_field.field_name;
    if v_field.proposed_value is null then
      v_set_parts := array_append(v_set_parts, format('%I = NULL', v_field.field_name));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, 'NULL');
    elsif v_kind = 'money' then
      v_set_parts := array_append(v_set_parts, format('%I = %L::numeric', v_field.field_name, v_field.proposed_value));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L::numeric', v_field.proposed_value));
    else
      v_set_parts := array_append(v_set_parts, format('%I = %L', v_field.field_name, v_field.proposed_value));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L', v_field.proposed_value));
    end if;
    v_new := v_new || jsonb_build_object(v_field.field_name, v_field.proposed_value);
    v_applied_fields := array_append(v_applied_fields, v_field.field_name);
    if p_decision = 'add_new' then
      v_previous := v_previous || jsonb_build_object(v_field.field_name, null);
    end if;
  end loop;

  -- COMPARE-AND-SWAP CLAIM (spec 106, 107). Done before the write, so two
  -- concurrent applies cannot both proceed. The unique (proposal_id) constraint
  -- on fhip_import_applications is the second, database-level guarantee.
  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now()
    where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your retirement accounts.');
  end if;

  -- Which household member this account belongs to. Taken from the statement's
  -- own resolved member (set only by explicit evidence or user confirmation —
  -- spec 15, 112), never inferred here.
  if v_proposal.source_retirement_statement_id is not null then
    select retirement_member_id into v_member_id from fdh_retirement_statements
      where id = v_proposal.source_retirement_statement_id and user_id = v_uid;
  end if;

  if p_decision = 'add_new' then
    -- master_item_key is deliberately NOT prepended: a NULL key makes this a
    -- custom row (see header note 3). is_active/source_type/user_id/
    -- retirement_member_id are system-set, never proposal-driven.
    v_cols := array_cat(array['user_id', 'is_active', 'source_type', 'last_imported_at', 'retirement_member_id'], v_cols);
    v_vals := array_cat(array[
      format('%L::uuid', v_uid), 'true', format('%L', 'retirement_statement_import'),
      'now()', case when v_member_id is null then 'NULL' else format('%L::uuid', v_member_id) end
    ], v_vals);
    execute format('insert into retirement_accounts (%s) values (%s) returning id',
      array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update retirement_accounts set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid',
      array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_retirement_statement_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'retirement', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_retirement_statement_id, v_uid
  ) returning id into v_application_id;

  update retirement_accounts
    set source_type = 'retirement_statement_import',
        last_import_application_id = v_application_id,
        last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id,
    'applied_fields', to_jsonb(v_applied_fields)
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh12_apply_retirement_proposal(uuid, text, text[]) from public;
grant execute on function fdh12_apply_retirement_proposal(uuid, text, text[]) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- PART J — COMMENTS (the durable, in-database record of the boundaries above)
-- ---------------------------------------------------------------------------

comment on table fdh_retirement_statements is
  'FDH-12 statement-level retirement evidence. NOT a canonical retirement record: nothing sums these balances into net worth. Canonical retirement truth remains retirement_accounts.current_balance (spec section 3).';
comment on table fdh_retirement_statement_activities is
  'FDH-12 line-level retirement evidence (contributions, rollovers, fees, insurance premiums, tax, earnings, withdrawals). These rows have NO canonical destination: canonical Retirement has no event ledger, so an activity is never posted to income, expense, a bank transaction or a balance. It is reconciled, matched and displayed only (spec sections 21, 41, 60, 75-76).';
comment on table fdh_retirement_statement_positions is
  'FDH-12 evidence of investments held INSIDE a retirement account. Terminal by design: no apply function accepts a position row and no canonical column can receive one, so a super balance and its underlying holdings can never both enter net worth (spec sections 12-13, 71).';
comment on column fdh_retirement_statement_activities.is_summary_total is
  'True for a printed subtotal (e.g. an annual statement''s "Total employer contributions") rather than an individual economic activity. Summary rows are excluded from activity-level reconciliation and dedup so a total is never counted alongside the lines it totals (spec sections 116-118).';
comment on column fdh_retirement_statement_activities.is_year_to_date is
  'True for a year-to-date figure. Never added to current-period figures — FDH-9''s certified YTD discipline (spec sections 114-115).';
comment on column fdh_retirement_statement_activities.matched_payroll_event_id is
  'The FDH-9 payslip that evidences this same economic contribution. Uniquely indexed: one payslip can evidence at most one fund contribution, so payslip $1,000 + fund $1,000 remains ONE contribution (spec sections 22, 64, 120).';
comment on function fdh12_apply_retirement_proposal(uuid, text, text[]) is
  'The ONLY path from retirement statement evidence to canonical Retirement. Writes at most the nine columns in its v_allowed array, on exactly one retirement_accounts row. Cannot write target_retirement_age (spec 61), cannot touch an SMSF row (spec 10), cannot post a statement activity anywhere (spec 60).';
