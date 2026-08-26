-- FDH-9 — Payslip & Income Intelligence.
--
-- Two structurally separate concerns in one file, in dependency order:
--
--   PART A  fdh_payroll_events / fdh_payroll_components
--           Payroll EVIDENCE extracted from a payslip. Lives in the FDH
--           namespace, owned by the Financial Data Hub, and names no Input
--           Data register anywhere.
--
--   PART B  fhip_import_proposals / fhip_import_proposal_fields /
--           fhip_import_applications
--           The GENERIC Input Data import bridge (spec section 7). Deliberately
--           NOT `fdh_`-prefixed: this is a platform service that Income
--           (FDH-9), and later Expenses, Investments, Liabilities and
--           Retirement, all share. `target_domain` is a COLUMN, not a table
--           name, so adding Expenses later is one adapter + one enum value —
--           not a schema redesign.
--
--   PART C  income_sources provenance columns.
--
-- MIGRATION NUMBER. Originally written as 0089 while that number still
-- looked free (`main` at the time held only up to 0078 and 0085; unmerged
-- sibling branches claimed 0079-0081 (App Review remainder) and
-- 0082/0083/0086/0087/0088 (II-R11)). Before this file was committed, SMSF's
-- own then-active collision (its Detailed->Summary switch-back RPC, also
-- originally 0087, colliding with II-R11's higher-priority live-security fix)
-- was independently resolved by renumbering SMSF's migration to 0089 — which
-- collided with THIS file. Per the same established precedent (whichever
-- migration is already applied/verified live keeps the number), SMSF's 0089
-- was already applied to DEV and live-verified before this file was ever
-- committed anywhere, so it keeps 0089. This file renumbers to **0091**
-- (0090 is also taken — SMSF's current_balance integrity guard) — the first
-- genuinely free number, re-verified by scanning current main plus every
-- active sibling worktree at the time of this renumber.
--
-- ADDITIVE ONLY. No existing column, constraint, index, policy or row is
-- removed. The one ALTER on an existing check constraint
-- (`fdh_document_audit_events.event_type`) drops and recreates it with a
-- STRICT SUPERSET of the previously-allowed values, following the widening
-- discipline established by 0064/0068/0071/0076.
--
-- WHY NO `updated_at` TRIGGER. Migration 0049's header records the house
-- convention: no DB-level `updated_at` trigger exists anywhere; every service
-- sets it in the application layer. FDH-9 follows that convention and detects
-- a stale proposal by VALUE COMPARISON instead (see PART B), which is sound
-- regardless of which write path edited the row.
--
-- Governing docs: docs/financial-data-hub/FDH9_REUSE_AND_GAP_AUDIT.md,
-- docs/architecture/FDH_CONTEXTUAL_IMPORT_ARCHITECTURE.md.


-- ===========================================================================
-- PART A — PAYROLL EVIDENCE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fdh_payroll_events — one row per PAY RUN read from one payslip document.
--
-- MONEY. numeric(20,4), matching every other FDH money column (see
-- lib/financial-data-hub/domain/money.ts's FDH_MONEY_SCALE). Amounts are
-- stored as read; all arithmetic happens in integer minor units.
--
-- YTD IS EVIDENCE, NOT ANOTHER PAYMENT (spec section 35). The year-to-date
-- figures live in their own clearly-named columns and are NEVER added to the
-- current-period figures by anything. Keeping them in the same row as the
-- period figures but under distinct names is the whole point: a parser that
-- confuses the two produces an obviously wrong `ytd_gross` rather than a
-- silently doubled `gross_pay`.
--
-- NO STATUTORY RATES (spec section 17). There is no tax-rate, super-rate or
-- PF-rate column anywhere here, and the extraction code derives none. Every
-- figure is READ FROM THE DOCUMENT.
-- ---------------------------------------------------------------------------
create table fdh_payroll_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,

  -- The payslip this evidence came from. ON DELETE SET NULL, not CASCADE:
  -- once the raw payslip is purged per the FDH-3 privacy lifecycle the
  -- payroll EVIDENCE must survive (spec section 52, section 71) — the Income
  -- entry it supports must never depend on raw payslip availability.
  statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,

  -- --- Employer / period ---------------------------------------------------
  employer_name text,
  -- Case/punctuation-folded form used for matching and duplicate detection.
  -- Never shown to the user.
  employer_normalised text,
  country_code char(2) not null references countries(country_code) on delete restrict,
  currency_code char(3) not null references currencies(currency_code) on delete restrict,

  pay_period_start date,
  pay_period_end date,
  payment_date date,

  -- 'unknown' is a CORRECT, deliberate value (spec section 27: one payslip may
  -- not provide enough evidence to infer frequency). It is never silently
  -- resolved to 'monthly'.
  pay_frequency text not null default 'unknown'
    check (pay_frequency in (
      'weekly', 'fortnightly', 'semimonthly', 'monthly',
      'quarterly', 'annual', 'irregular', 'unknown'
    )),
  pay_frequency_source text not null default 'unknown'
    check (pay_frequency_source in ('stated_on_payslip', 'derived_from_period', 'derived_from_history', 'user_confirmed', 'unknown')),

  -- --- Current-period earnings --------------------------------------------
  gross_pay numeric(20,4) check (gross_pay is null or gross_pay >= 0),
  base_pay numeric(20,4) check (base_pay is null or base_pay >= 0),
  overtime_pay numeric(20,4) check (overtime_pay is null or overtime_pay >= 0),
  bonus_pay numeric(20,4) check (bonus_pay is null or bonus_pay >= 0),
  commission_pay numeric(20,4) check (commission_pay is null or commission_pay >= 0),
  allowances_total numeric(20,4) check (allowances_total is null or allowances_total >= 0),
  -- Kept STRUCTURALLY SEPARATE from earnings (spec section 38): a
  -- reimbursement is the return of money the employee already spent, and must
  -- never inflate recurring income.
  reimbursements_total numeric(20,4) check (reimbursements_total is null or reimbursements_total >= 0),
  other_earnings numeric(20,4) check (other_earnings is null or other_earnings >= 0),

  -- --- Current-period deductions -------------------------------------------
  -- AU PAYG withholding / India TDS. Extracted, never used to compute an
  -- annual tax liability, and NEVER placed into an Income amount (spec 36).
  tax_withheld numeric(20,4) check (tax_withheld is null or tax_withheld >= 0),
  employee_deductions_total numeric(20,4) check (employee_deductions_total is null or employee_deductions_total >= 0),
  -- AU: salary sacrifice (a PRE-tax deduction, structurally distinct from an
  -- ordinary post-tax deduction, which is why it is not folded into
  -- employee_deductions_total).
  salary_sacrifice numeric(20,4) check (salary_sacrifice is null or salary_sacrifice >= 0),
  -- India: professional tax — a state levy, not income tax. Separate column
  -- so it is never mistaken for TDS.
  professional_tax numeric(20,4) check (professional_tax is null or professional_tax >= 0),

  -- --- Retirement contributions --------------------------------------------
  -- AU employer/employee super; India employer/employee PF and NPS.
  -- EXTRACTED AND HELD AS EVIDENCE ONLY. FDH-9 creates and updates NO
  -- retirement balance (spec section 37) — a later retirement bridge owns
  -- that. Employer contributions are also NEVER added to take-home cash
  -- income (spec section 39).
  employer_retirement_contribution numeric(20,4) check (employer_retirement_contribution is null or employer_retirement_contribution >= 0),
  employee_retirement_contribution numeric(20,4) check (employee_retirement_contribution is null or employee_retirement_contribution >= 0),
  employer_nps_contribution numeric(20,4) check (employer_nps_contribution is null or employer_nps_contribution >= 0),
  employee_nps_contribution numeric(20,4) check (employee_nps_contribution is null or employee_nps_contribution >= 0),

  -- --- Net -----------------------------------------------------------------
  net_pay numeric(20,4) check (net_pay is null or net_pay >= 0),

  -- --- Year to date (EVIDENCE ONLY — never summed with the above) -----------
  ytd_gross numeric(20,4) check (ytd_gross is null or ytd_gross >= 0),
  ytd_tax numeric(20,4) check (ytd_tax is null or ytd_tax >= 0),
  ytd_net numeric(20,4) check (ytd_net is null or ytd_net >= 0),
  ytd_employer_retirement numeric(20,4) check (ytd_employer_retirement is null or ytd_employer_retirement >= 0),
  ytd_employee_retirement numeric(20,4) check (ytd_employee_retirement is null or ytd_employee_retirement >= 0),

  -- --- Parser provenance ---------------------------------------------------
  parser_name text,
  parser_version text,
  extraction_confidence numeric(5,4)
    check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),

  -- --- Gross-to-net reconciliation (spec section 19) ------------------------
  -- INSUFFICIENT_DATA is a first-class outcome, not a failure: a payslip that
  -- does not disclose every deduction line cannot be reconciled, and saying so
  -- is correct behaviour. A 0.01 discrepancy MUST surface as 'variance' —
  -- certified by tests/unit/fdh9ReconciliationOracle.test.ts.
  reconciliation_status text not null default 'insufficient_data'
    check (reconciliation_status in ('reconciled', 'variance', 'insufficient_data')),
  reconciliation_variance numeric(20,4),

  -- --- Bank salary match (spec sections 20-22) ------------------------------
  -- THE HIGHEST-RISK RULE IN FDH-9: a matched payslip and salary deposit are
  -- TWO PIECES OF EVIDENCE FOR ONE INCOME EVENT. This column records that the
  -- deposit corroborates this payroll event. It NEVER creates a second income
  -- amount, and nothing in the platform sums a payroll event's net_pay with
  -- its matched transaction's amount.
  bank_match_status text not null default 'not_attempted'
    check (bank_match_status in ('matched', 'no_match', 'multiple_candidates', 'not_attempted')),
  bank_match_transaction_id uuid references fdh_transactions(id) on delete set null,
  bank_match_confidence numeric(5,4)
    check (bank_match_confidence is null or (bank_match_confidence >= 0 and bank_match_confidence <= 1)),

  -- --- Review / approval (reuses FDH-7 principles, spec section 42) ---------
  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,

  -- --- Revision / supersession (spec section 35) ----------------------------
  -- A REVISED payslip supersedes its predecessor rather than becoming a second
  -- pay run. Self-referencing; the same-tenant trigger below covers it.
  superseded_by_payroll_event_id uuid references fdh_payroll_events(id) on delete set null,
  -- Deterministic content fingerprint (employer + period + payment date +
  -- gross + net). Used to recognise the SAME payslip uploaded twice.
  payslip_fingerprint text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A period that ends before it starts is a parse error, not data.
  constraint fdh_payroll_events_period_order
    check (pay_period_start is null or pay_period_end is null or pay_period_end >= pay_period_start),
  -- approved_at and approval_status cannot disagree.
  constraint fdh_payroll_events_approval_coherent
    check ((approval_status = 'approved') = (approved_at is not null)),
  -- A match must name the transaction it matched.
  constraint fdh_payroll_events_match_coherent
    check ((bank_match_status = 'matched') = (bank_match_transaction_id is not null)),
  -- A payroll event may never supersede itself.
  constraint fdh_payroll_events_no_self_supersede
    check (superseded_by_payroll_event_id is null or superseded_by_payroll_event_id <> id)
);

create index idx_fdh_payroll_events_user on fdh_payroll_events(user_id);
create index idx_fdh_payroll_events_document on fdh_payroll_events(statement_upload_id);
create index idx_fdh_payroll_events_employer on fdh_payroll_events(user_id, employer_normalised);
create index idx_fdh_payroll_events_payment_date on fdh_payroll_events(user_id, payment_date);
create index idx_fdh_payroll_events_bank_match on fdh_payroll_events(bank_match_transaction_id);

-- Duplicate payslip detection at the DATABASE level (spec section 34, FAIL
-- condition "duplicate payslips create duplicate salary records"). The same
-- user cannot hold two payroll events with the same content fingerprint. A
-- REVISED payslip has different content, so it produces a different
-- fingerprint and is correctly allowed through — it is then linked via
-- superseded_by_payroll_event_id rather than blocked here.
create unique index uq_fdh_payroll_events_fingerprint
  on fdh_payroll_events(user_id, payslip_fingerprint)
  where payslip_fingerprint is not null;

-- One bank transaction can corroborate at most ONE payroll event. This is a
-- structural guard against the same salary deposit being used as evidence for
-- two different pay runs (which would be the double-count failure wearing a
-- different hat).
create unique index uq_fdh_payroll_events_bank_match
  on fdh_payroll_events(bank_match_transaction_id)
  where bank_match_transaction_id is not null;


-- ---------------------------------------------------------------------------
-- fdh_payroll_components — the per-LINE detail of a payslip.
--
-- WHY THIS TABLE EXISTS. Indian payslips vary enormously between employers
-- (Basic / HRA / DA / special allowance / conveyance / LTA / arrears / N
-- employer-invented lines), and AU payslips carry an open-ended set of
-- allowance lines. Modelling those as columns would mean either 40 bespoke
-- nullable columns or silent data loss. A component table keeps the header
-- totals exact while preserving every line actually read, which is also what
-- makes component-aware gross-to-net reconciliation possible (spec 19).
--
-- PRIVACY (spec section 13). `label_raw` holds the earning/deduction label
-- only ("Basic", "HRA", "Overtime"). Employee ID, address, TFN/PAN and bank
-- account are NEVER extracted into any column here or anywhere else in FDH-9.
-- ---------------------------------------------------------------------------
create table fdh_payroll_components (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payroll_event_id uuid not null references fdh_payroll_events(id) on delete cascade,

  -- Which side of the payslip this line sits on.
  component_side text not null check (component_side in ('earning', 'deduction', 'employer_contribution', 'informational')),

  -- The canonical meaning FDH-9 resolved this line to. 'unknown' is a correct
  -- outcome for an unrecognised employer-specific line — the line is still
  -- preserved with its raw label rather than dropped (spec section 18: do not
  -- assume every Indian employer uses the same layout).
  component_type text not null default 'unknown'
    check (component_type in (
      -- earnings
      'base', 'overtime', 'bonus', 'commission', 'allowance', 'reimbursement',
      'arrears', 'other_earning',
      -- India-specific earnings kept individually identifiable
      'basic', 'hra', 'dearness_allowance', 'special_allowance', 'conveyance', 'lta',
      -- deductions
      'income_tax_withheld', 'professional_tax', 'salary_sacrifice',
      'employee_retirement', 'employee_nps', 'other_deduction',
      -- employer side
      'employer_retirement', 'employer_nps',
      'unknown'
    )),

  label_raw text,
  amount numeric(20,4) not null,
  -- Distinguishes a current-period line from a year-to-date column on the same
  -- row of the payslip, so the two can never be conflated (spec section 35).
  is_year_to_date boolean not null default false,

  created_at timestamptz not null default now()
);

create index idx_fdh_payroll_components_event on fdh_payroll_components(payroll_event_id);
create index idx_fdh_payroll_components_user on fdh_payroll_components(user_id);


-- ===========================================================================
-- PART B — THE GENERIC INPUT DATA IMPORT BRIDGE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fhip_import_proposals — a PROPOSAL to change an Input Data register.
--
-- A proposal is INERT. Creating one, approving the evidence behind it, and
-- even marking it 'ready' change NOTHING in any canonical register. Only an
-- explicit apply — recorded in fhip_import_applications — mutates Input Data
-- (spec sections 6, 31, 58).
--
-- GENERIC BY CONSTRUCTION (spec section 7). `target_domain` is a column. The
-- compare/selected-field/staleness/idempotency machinery below is entirely
-- domain-agnostic; Income is simply the first adapter.
-- ---------------------------------------------------------------------------
create table fhip_import_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The Input Data domain this proposal targets. Adding 'expense' etc. later
  -- is a check-constraint widening plus an adapter — not a new table.
  target_domain text not null
    check (target_domain in ('income', 'expense', 'asset', 'liability', 'investment', 'retirement')),

  -- What kind of evidence produced it.
  source_kind text not null
    check (source_kind in ('payslip', 'bank_statement', 'investment_statement', 'loan_statement', 'retirement_statement')),

  -- Source evidence FK, one nullable column per source kind. A future kind
  -- adds its own nullable FK column so that a real, enforceable same-tenant
  -- trigger can exist for it — deliberately NOT a polymorphic
  -- (source_type, source_id) pair, which no foreign key and no tenant trigger
  -- could ever constrain.
  source_payroll_event_id uuid references fdh_payroll_events(id) on delete cascade,

  currency_code char(3) references currencies(currency_code) on delete restrict,

  -- --- Target ---------------------------------------------------------------
  -- NULL target_entity_id = "add as a new entry". Non-null = "update this
  -- existing row". Which register the id points into is determined by
  -- target_domain; the same-tenant trigger below resolves and enforces it for
  -- every domain it knows about.
  target_entity_id uuid,
  -- Secondary staleness signal only. The AUTHORITATIVE staleness check is a
  -- per-field value comparison against fhip_import_proposal_fields
  -- .existing_value (see that table). Recorded because it is cheap and useful
  -- in audit, NOT relied upon — `registry.save()`'s upsert path does not bump
  -- updated_at, so a timestamp alone would be an unsound gate.
  target_entity_updated_at timestamptz,

  -- The engine's RECOMMENDATION. The user is never bound by it, and the apply
  -- API re-derives its own decision rather than trusting this column.
  recommended_apply_mode text not null
    check (recommended_apply_mode in ('add_new', 'update_existing', 'keep_existing')),

  -- Set when duplicate detection believes an existing entry already represents
  -- this same employment (spec section 29).
  duplicate_of_entity_id uuid,

  status text not null default 'ready'
    check (status in ('ready', 'applied', 'superseded', 'dismissed', 'expired')),

  -- Set when the user chooses KEEP EXISTING. A dismissed proposal must not be
  -- re-forced on every page load (spec section 59) — the read path filters on
  -- this.
  dismissed_at timestamptz,
  applied_at timestamptz,

  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint fhip_import_proposals_dismiss_coherent
    check ((status = 'dismissed') = (dismissed_at is not null)),
  constraint fhip_import_proposals_applied_coherent
    check ((status = 'applied') = (applied_at is not null)),
  -- A payslip-sourced proposal must name its payroll event.
  constraint fhip_import_proposals_payslip_source
    check (source_kind <> 'payslip' or source_payroll_event_id is not null)
);

create index idx_fhip_import_proposals_user on fhip_import_proposals(user_id, target_domain, status);
create index idx_fhip_import_proposals_source_payroll on fhip_import_proposals(source_payroll_event_id);
create index idx_fhip_import_proposals_target on fhip_import_proposals(target_entity_id);


-- ---------------------------------------------------------------------------
-- fhip_import_proposal_fields — the per-FIELD comparison.
--
-- This table is what makes "apply selected fields" real rather than a UI
-- illusion (spec section 30, section 61). Each row is one proposed field
-- change, carrying BOTH the proposed value and the existing value observed at
-- generation time.
--
-- `existing_value` is the STALENESS ORACLE. At apply time the server re-reads
-- the target row and compares the live value of each SELECTED field against
-- this snapshot. Any difference means the user edited their data after the
-- proposal was generated, and the apply is refused as STALE_PROPOSAL rather
-- than silently overwriting the newer value (spec section 48).
--
-- Values are stored as TEXT deliberately: this table spans six Input Data
-- domains with numeric, enum, boolean and free-text fields, and a faithful
-- textual snapshot compares correctly for staleness in every one of them.
-- `value_kind` tells the adapter how to coerce on apply.
-- ---------------------------------------------------------------------------
create table fhip_import_proposal_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_id uuid not null references fhip_import_proposals(id) on delete cascade,

  -- The canonical register COLUMN this proposes to write. The adapter's own
  -- allow-list is the security boundary; this is the record of intent.
  field_name text not null,
  value_kind text not null check (value_kind in ('money', 'text', 'enum', 'bool', 'int')),

  proposed_value text,
  existing_value text,

  -- Whether FDH-9 recommends this field be applied by default. Variable pay
  -- and inferred frequency arrive with is_recommended = false (spec 26-27).
  is_recommended boolean not null default true,
  -- Fields the user must positively confirm because one payslip is not enough
  -- evidence (frequency inferred from a single document; bonus/overtime).
  requires_confirmation boolean not null default false,

  confidence numeric(5,4)
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- Machine-readable explanation shown in the compare view, e.g.
  -- 'gross_from_payslip', 'frequency_inferred_single_payslip',
  -- 'variable_pay_excluded_from_recurring'.
  reason_code text,

  created_at timestamptz not null default now(),

  -- One proposal proposes each field at most once.
  constraint uq_fhip_import_proposal_fields unique (proposal_id, field_name)
);

create index idx_fhip_import_proposal_fields_proposal on fhip_import_proposal_fields(proposal_id);
create index idx_fhip_import_proposal_fields_user on fhip_import_proposal_fields(user_id);


-- ---------------------------------------------------------------------------
-- fhip_import_applications — the APPLY audit record (spec section 32).
--
-- Records the proposal, the existing values, the selected changes, the acting
-- user, the timestamp and the source evidence — enough to explain where an
-- imported Income figure came from, months later, after the raw payslip has
-- been purged.
--
-- IDEMPOTENCY IS ENFORCED BY THE DATABASE (spec section 34). `unique
-- (proposal_id)` means re-applying the same approved proposal cannot create a
-- second Income record even if the API layer were bypassed entirely. This is
-- the structural answer to FAIL condition "duplicate payslips create duplicate
-- salary records".
--
-- APPEND-ONLY. SELECT + INSERT policies only, no UPDATE and no DELETE policy,
-- so a user cannot rewrite their own import audit trail — the same discipline
-- fdh_classification_history already uses.
-- ---------------------------------------------------------------------------
create table fhip_import_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_id uuid not null references fhip_import_proposals(id) on delete cascade,

  target_domain text not null
    check (target_domain in ('income', 'expense', 'asset', 'liability', 'investment', 'retirement')),
  -- The register row that was created or updated.
  target_entity_id uuid not null,

  apply_mode text not null check (apply_mode in ('add_new', 'update_existing', 'apply_selected_fields')),

  -- Exactly which fields the user selected, and the before/after values of
  -- each. jsonb rather than a child table: this is an immutable audit
  -- snapshot, never queried field-by-field.
  applied_fields jsonb not null,
  previous_values jsonb not null,
  new_values jsonb not null,

  source_payroll_event_id uuid references fdh_payroll_events(id) on delete set null,

  applied_at timestamptz not null default now(),
  applied_by uuid not null references auth.users(id) on delete cascade,

  constraint uq_fhip_import_applications_proposal unique (proposal_id)
);

create index idx_fhip_import_applications_user on fhip_import_applications(user_id);
create index idx_fhip_import_applications_target on fhip_import_applications(target_domain, target_entity_id);
create index idx_fhip_import_applications_payroll on fhip_import_applications(source_payroll_event_id);


-- ===========================================================================
-- PART C — INCOME PROVENANCE
--
-- Mirrors the EXACT precedent Investment Intelligence R3 set for the
-- `investments` register in migration 0042 (source_type + a link back to the
-- publication record). Non-invasive: every existing row defaults to 'manual',
-- and nothing in the Income domain depends on raw document retention
-- (spec sections 41, 51, 52).
-- ===========================================================================
alter table income_sources
  add column source_type text not null default 'manual'
    check (source_type in ('manual', 'payslip_import')),
  add column last_import_application_id uuid references fhip_import_applications(id) on delete set null,
  add column last_imported_at timestamptz;


-- ===========================================================================
-- RLS — owner-only on every new table.
-- ===========================================================================
alter table fdh_payroll_events enable row level security;
alter table fdh_payroll_components enable row level security;
alter table fhip_import_proposals enable row level security;
alter table fhip_import_proposal_fields enable row level security;
alter table fhip_import_applications enable row level security;

create policy "own fdh_payroll_events" on fdh_payroll_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own fdh_payroll_components" on fdh_payroll_components
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own fhip_import_proposals" on fhip_import_proposals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own fhip_import_proposal_fields" on fhip_import_proposal_fields
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Append-only: read your own, insert your own, never update or delete.
create policy "read own fhip_import_applications" on fhip_import_applications
  for select using (auth.uid() = user_id);
create policy "insert own fhip_import_applications" on fhip_import_applications
  for insert with check (auth.uid() = user_id and auth.uid() = applied_by);


-- ===========================================================================
-- TENANT-SCOPED REFERENTIAL INTEGRITY (spec section 46).
--
-- A FOREIGN KEY proves the referenced row EXISTS, never that it belongs to the
-- same tenant. RLS's `with check` stops a row being saved under someone else's
-- identity but says nothing about which OTHER tenant's row it points at. FDH-3
-- established this pattern in migration 0058 (`fdh3_assert_*_owner`); FDH-9
-- applies it to EVERY new cross-row relationship it introduces, so the
-- historical FDH1-F1 foreign-FK weakness is not repeated for payroll->bank,
-- payroll->proposal or proposal->Income.
--
-- These run `security definer` and fire regardless of role — including the
-- service-role path — so the same-tenant invariant holds independently of
-- which client performed the write.
--
-- THE CRITICAL ONE is fdh9_assert_proposal_owner(): it is what makes
-- "a Tenant-A proposal must never update a Tenant-B income_id" true even
-- against a forged request that bypasses every application-layer check.
-- ===========================================================================

-- --- payroll event -> document, bank transaction, superseding event ---------
create or replace function fdh9_assert_payroll_event_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.statement_upload_id is not null then
    select user_id into ref_owner from fdh_statement_uploads where id = new.statement_upload_id;
    if ref_owner is null then
      raise exception 'fdh_payroll_events: statement_upload_id % does not exist', new.statement_upload_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'fdh_payroll_events: cross-tenant reference — document % belongs to a different user', new.statement_upload_id;
    end if;
  end if;

  if new.bank_match_transaction_id is not null then
    select user_id into ref_owner from fdh_transactions where id = new.bank_match_transaction_id;
    if ref_owner is null then
      raise exception 'fdh_payroll_events: bank_match_transaction_id % does not exist', new.bank_match_transaction_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'fdh_payroll_events: cross-tenant reference — transaction % belongs to a different user', new.bank_match_transaction_id;
    end if;
  end if;

  if new.superseded_by_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.superseded_by_payroll_event_id;
    if ref_owner is null then
      raise exception 'fdh_payroll_events: superseded_by_payroll_event_id % does not exist', new.superseded_by_payroll_event_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'fdh_payroll_events: cross-tenant reference — payroll event % belongs to a different user', new.superseded_by_payroll_event_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_payroll_events_owner
  before insert or update of user_id, statement_upload_id, bank_match_transaction_id, superseded_by_payroll_event_id
  on fdh_payroll_events
  for each row execute function fdh9_assert_payroll_event_owner();


-- --- payroll component -> payroll event -------------------------------------
create or replace function fdh9_assert_payroll_component_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fdh_payroll_events where id = new.payroll_event_id;
  if ref_owner is null then
    raise exception 'fdh_payroll_components: payroll_event_id % does not exist', new.payroll_event_id;
  end if;
  if ref_owner <> new.user_id then
    raise exception 'fdh_payroll_components: cross-tenant reference — payroll event % belongs to a different user', new.payroll_event_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_payroll_components_owner
  before insert or update of user_id, payroll_event_id on fdh_payroll_components
  for each row execute function fdh9_assert_payroll_component_owner();


-- --- proposal -> payroll event AND -> the canonical target row --------------
-- This is the cross-tenant BRIDGE PROTECTION spec section 46 mandates.
create or replace function fdh9_assert_proposal_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_payroll_event_id % does not exist', new.source_payroll_event_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  -- target_entity_id is resolved against the register named by target_domain.
  -- Only 'income' is implemented in FDH-9; every other domain is rejected
  -- outright if it somehow carries a target, so a future adapter cannot ship
  -- a target without also extending this guard. Failing CLOSED is deliberate.
  if new.target_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in income_sources', new.target_entity_id;
      end if;
      if ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
      end if;
    else
      raise exception 'fhip_import_proposals: target_domain % has no implemented target guard', new.target_domain;
    end if;
  end if;

  -- Same rule for the duplicate pointer.
  if new.duplicate_of_entity_id is not null and new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.duplicate_of_entity_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — duplicate income entry % belongs to a different user', new.duplicate_of_entity_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fhip_import_proposals_owner
  before insert or update of user_id, source_payroll_event_id, target_entity_id, target_domain, duplicate_of_entity_id
  on fhip_import_proposals
  for each row execute function fdh9_assert_proposal_owner();


-- --- proposal field -> proposal ---------------------------------------------
create or replace function fdh9_assert_proposal_field_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_proposal_fields: proposal_id % does not exist', new.proposal_id;
  end if;
  if ref_owner <> new.user_id then
    raise exception 'fhip_import_proposal_fields: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fhip_import_proposal_fields_owner
  before insert or update of user_id, proposal_id on fhip_import_proposal_fields
  for each row execute function fdh9_assert_proposal_field_owner();


-- --- application -> proposal, payroll event, and the applied target ---------
create or replace function fdh9_assert_application_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_applications: proposal_id % does not exist', new.proposal_id;
  end if;
  if ref_owner <> new.user_id then
    raise exception 'fhip_import_applications: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;

  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  -- The row that was actually written must belong to the same tenant. Fails
  -- CLOSED for any domain without an implemented guard.
  if new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in income_sources', new.target_entity_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
    end if;
  else
    raise exception 'fhip_import_applications: target_domain % has no implemented target guard', new.target_domain;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fhip_import_applications_owner
  before insert or update on fhip_import_applications
  for each row execute function fdh9_assert_application_owner();


-- --- income_sources.last_import_application_id -> application ---------------
-- The reverse pointer must also stay same-tenant, so a forged UPDATE cannot
-- attribute one user's Income row to another user's import.
create or replace function fdh9_assert_income_import_link_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.last_import_application_id is not null then
    select user_id into ref_owner from fhip_import_applications where id = new.last_import_application_id;
    if ref_owner is null then
      raise exception 'income_sources: last_import_application_id % does not exist', new.last_import_application_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'income_sources: cross-tenant reference — import application % belongs to a different user', new.last_import_application_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_income_sources_import_link_owner
  before insert or update of user_id, last_import_application_id on income_sources
  for each row execute function fdh9_assert_income_import_link_owner();


-- ===========================================================================
-- fdh_document_audit_events.event_type — additive widening.
--
-- Six new payslip/bridge event types. Everything else FDH-9 needs is already
-- covered by the existing vocabulary: the upload itself is
-- 'document_upload_created'/'document_upload_completed', PDF text extraction
-- is 'pdf_native_extraction_started'/'_completed', and a purge is
-- 'document_purged' — no duplicate vocabulary is introduced for those. Follows
-- the widening discipline established by 0064/0068/0071/0076.
-- ===========================================================================
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
      -- FDH-9 additions (spec sections 32, 41-42).
      'payslip_extraction_completed',
      'payslip_extraction_failed',
      'payroll_event_approved',
      'income_proposal_generated',
      'income_proposal_applied',
      'income_proposal_dismissed'
    ));


-- ===========================================================================
-- PART D — HARDENING: ATOMIC APPLY RPC & AUTHORITATIVE-STATE PROTECTION
--
-- FINDING (Product Owner directive, FDH-9 hardening pass). Parts A-C above
-- (as originally drafted) gave `fhip_import_proposals` the same blanket
-- "for all using (auth.uid()=user_id) with check (auth.uid()=user_id)" shape
-- this project has now found and fixed as a live defect on FIVE other tables
-- (fdh_statement_uploads.reconciliation_status / 0065, ii_review_items / 0069,
-- R8 classification fields / 0068, ii_transactions + ii_reconciliation_cases /
-- 0087). REPRODUCED HERE TOO, on paper, before this fix: with that policy, an
-- authenticated user's OWN JWT can issue
--   PATCH /rest/v1/fhip_import_proposals?id=eq.<their own proposal>
--   { "status": "applied", "applied_at": "<now>" }
-- and PostgREST returns HTTP 200 with the row genuinely changed to 'applied'
-- — with NO Income mutation, NO application audit row, and NO trust that any
-- of applyService.ts's checks (ownership, staleness, allow-list,
-- compare-and-swap) ever ran. `fhip_import_applications`' original INSERT
-- policy (`with check (auth.uid()=user_id and auth.uid()=applied_by)`) has
-- the same shape of hole: a user could INSERT a fabricated audit row
-- unilaterally, without ever touching Income.
--
-- This is the same defect CLASS every time: RLS proves row OWNERSHIP, never
-- COLUMN or LIFECYCLE authority. Part D closes it for the FDH-9 bridge tables
-- and for `fdh_payroll_events`, using the two-layer split this project has
-- settled on (0069/0087): RLS for WHICH ROWS, a BEFORE trigger for WHICH
-- COLUMNS AND WHICH VALUE TRANSITIONS.
--
-- WHY THIS ROUND NEEDS A THIRD LAYER THE 0069/0087 PRECEDENT DID NOT.
-- 0069/0087's legitimate write path is STILL the ordinary authenticated
-- client (acknowledgeReviewItem(), resolve/route.ts) — their triggers only
-- narrow which same-role transitions are legal. FDH-9's legitimate write
-- path for "apply" is different in kind: spec section 4 requires the entire
-- multi-table mutation (Income change + application insert + proposal
-- marked applied) to be ONE ATOMIC DATABASE OPERATION, which means it must
-- run as a single SECURITY DEFINER function call, not a sequence of ordinary
-- authenticated-role statements. The trigger therefore cannot simply
-- enumerate "transitions the authenticated role may make" the way 0069/0087
-- do, because for the 'applied' transition specifically there IS no
-- legitimate authenticated-role write at all — only the function may ever
-- produce it. The trigger needs to be able to tell "this statement was
-- issued directly by PostgREST for an authenticated/anon caller" apart from
-- "this statement was issued by fdh9_apply_income_proposal() on that
-- caller's behalf", even though both run inside the same session/JWT.
--
-- MECHANISM CHOSEN: a transaction-local GUC flag
-- (`fhip.import_bridge_internal_write`), set true by the atomic function
-- immediately before each of its own authoritative writes, and read (never
-- set) by every hardening trigger below. This is deliberately NOT based on
-- `current_user`/function ownership (which role owns a function that was
-- migrated via the Supabase CLI vs. the SQL editor vs. a hosted project can
-- vary, and the same trigger has to be provably correct in the PGlite
-- harness, DEV and production alike) — the GUC is `set_config(..., true)`
-- (transaction-local), so it can never leak into a later, unrelated request
-- even on a pooled connection, and a raw PostgREST call can never set it
-- because PostgREST never runs arbitrary `SELECT set_config(...)` on a
-- caller's behalf. This is the actual security boundary: forging the
-- 'applied' transition now requires executing SQL as a role that can set
-- session GUCs arbitrarily AND write the table directly — i.e. it requires
-- already being inside the trusted function body.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- D.1 fhip_import_proposals — replace the blanket policy.
-- ---------------------------------------------------------------------------
drop policy if exists "own fhip_import_proposals" on fhip_import_proposals;

create policy "read own fhip_import_proposals" on fhip_import_proposals
  for select using (auth.uid() = user_id);
-- A freshly generated proposal is inert (spec section 6) — creating one is
-- not the defect this part closes, so ordinary authenticated INSERT stays,
-- scoped to the caller's own id and to the only state a NEW proposal may
-- ever start in.
create policy "insert own fhip_import_proposals" on fhip_import_proposals
  for insert with check (auth.uid() = user_id and status = 'ready');
-- UPDATE stays row-scoped by ownership; the trigger below is what actually
-- decides which columns/transitions are legal for the authenticated role.
create policy "update own fhip_import_proposals" on fhip_import_proposals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: a proposal is never hard-deleted by a user (it is
-- superseded/dismissed/applied instead); it only disappears via
-- ON DELETE CASCADE from its source payroll event.

create or replace function fdh9_import_proposals_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  -- Every column below is authoritative: it either identifies WHAT the
  -- proposal targets (rewriting it after generation would let a stale
  -- proposal be silently retargeted) or records an outcome only the apply
  -- function may produce. None of them is legitimately editable by the
  -- authenticated role, ever, at any status.
  if new.user_id is distinct from old.user_id
     or new.target_domain is distinct from old.target_domain
     or new.source_kind is distinct from old.source_kind
     or new.source_payroll_event_id is distinct from old.source_payroll_event_id
     or new.currency_code is distinct from old.currency_code
     or new.target_entity_id is distinct from old.target_entity_id
     or new.target_entity_updated_at is distinct from old.target_entity_updated_at
     or new.recommended_apply_mode is distinct from old.recommended_apply_mode
     or new.duplicate_of_entity_id is distinct from old.duplicate_of_entity_id
     or new.generated_at is distinct from old.generated_at
     or new.applied_at is distinct from old.applied_at
  then
    raise exception 'fhip_import_proposals: this field is authoritative and may not be written directly by the authenticated role';
  end if;

  -- The ONLY two direct (non-internal) status transitions that are
  -- legitimate: a user declining the proposal (ready -> dismissed, spec
  -- section 59) and a fresh proposal superseding a stale one on regeneration
  -- (ready -> superseded, supabaseStore.ts's persistProposal()). Every other
  -- transition — including into 'applied', including a same-value no-op used
  -- to smuggle a paired-column change through, including 'expired' (reserved,
  -- not yet produced by any code path) — is refused. This is THE exact
  -- disclosed defect's closure: 'applied' is categorically unreachable
  -- through this path.
  if new.status is distinct from old.status then
    if not (old.status = 'ready' and new.status in ('dismissed', 'superseded')) then
      raise exception 'fhip_import_proposals: status may only move from ready to dismissed or superseded via the authenticated role; applied is only ever set by fdh9_apply_income_proposal()';
    end if;
  end if;

  if new.dismissed_at is distinct from old.dismissed_at and new.status <> 'dismissed' then
    raise exception 'fhip_import_proposals: dismissed_at may only be set alongside status=dismissed';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fhip_import_proposals_authoritative_write
  before update on fhip_import_proposals
  for each row execute function fdh9_import_proposals_assert_authoritative_write();


-- ---------------------------------------------------------------------------
-- D.2 fhip_import_proposal_fields — make the staleness oracle itself immutable.
--
-- SEPARATE FINDING, not in the original disclosure but the exact same defect
-- class: `existing_value` is what detectStaleness()/the RPC's staleness loop
-- compares the live row against. The original "own ... for all" policy would
-- have let a user PATCH `existing_value` on their own proposal's field rows
-- to match their current data, silently defeating STALE_PROPOSAL every time
-- (this is precisely spec section 65's mandatory negative control:
-- "Staleness — disable stale check, harness must catch overwrite"). A
-- snapshot that can be rewritten after the fact is not a snapshot.
-- ---------------------------------------------------------------------------
drop policy if exists "own fhip_import_proposal_fields" on fhip_import_proposal_fields;

create policy "read own fhip_import_proposal_fields" on fhip_import_proposal_fields
  for select using (auth.uid() = user_id);
-- Written once, atomically, alongside the parent proposal by
-- persistProposal() — ordinary authenticated INSERT stays.
create policy "insert own fhip_import_proposal_fields" on fhip_import_proposal_fields
  for insert with check (auth.uid() = user_id);
-- No update, no delete policy for the authenticated role at all: every field
-- row is immutable once created (append-only, same discipline as
-- fhip_import_applications / fdh_classification_history). Rows only
-- disappear via ON DELETE CASCADE from their parent proposal.


-- ---------------------------------------------------------------------------
-- D.3 fhip_import_applications — close the forged-application-row gap
-- (spec section 20).
--
-- The original INSERT policy let any authenticated user fabricate an
-- application row for their own proposal_id/user_id/applied_by without ever
-- running the apply operation. The fix requires the SAME transaction-local
-- flag the apply function sets — a direct PostgREST INSERT, even with every
-- column value legitimate-looking, can never set that flag, so it is refused
-- by RLS itself (WITH CHECK), independently of the trigger layer.
-- ---------------------------------------------------------------------------
drop policy if exists "insert own fhip_import_applications" on fhip_import_applications;

create policy "insert own fhip_import_applications" on fhip_import_applications
  for insert with check (
    auth.uid() = user_id
    and auth.uid() = applied_by
    and coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true'
  );
-- "read own" (select) policy from Part B is untouched. No update, no delete
-- policy exists for the authenticated role — append-only, as designed.


-- ---------------------------------------------------------------------------
-- D.4 fdh_payroll_events — payroll-event authority audit (spec sections 10,
-- 21).
--
-- INSERT stays ordinary-authenticated-scoped. Unlike ii_transactions (R11),
-- this codebase's payslip extraction pipeline has no service-role ingestion
-- path anywhere — every read/write in lib/import-bridge and
-- lib/financial-data-hub/payslip goes through the per-request, RLS-scoped
-- client (supabaseStore.ts's own header: "EVERY QUERY IS SCOPED
-- .eq('user_id', userId) ON TOP OF RLS"). The legitimate write of a freshly
-- parsed payroll event is therefore necessarily an authenticated INSERT by
-- the user who uploaded their own payslip. This is a documented, deliberate
-- choice (spec section 10: "do not over-harden genuine user-editable... if
-- existing architecture requires it") — a user directly fabricating a whole
-- fake payroll event via INSERT is a self-harm data-integrity concern (no
-- different in kind from typing an arbitrary number into the manual Income
-- form today), not a same-tenant authority breach, and is explicitly out of
-- scope for this hardening pass; UPDATE forgery of an event's system-derived
-- fields AFTER correct extraction, the defect spec 10/21 actually names, is
-- what the trigger below closes.
--
-- UPDATE: only two direct (non-internal) actions exist anywhere in the
-- current implementation — none yet, since no route/UI calls UPDATE on this
-- table at all (see FDH9 completion report, "no app/api layer was ever
-- built"). Pending that UI, this hardening fails CLOSED rather than open:
-- the ONLY column an ordinary authenticated UPDATE may ever touch directly
-- is `employer_name`/`employer_normalised` (a label correction, the one
-- unambiguous case of "genuine user-editable correction field" named by spec
-- section 10). Every system-derived figure — every money column, every tax/
-- retirement/YTD column, reconciliation outcome, bank-match outcome, parser
-- provenance, approval state, review state, supersession — is authoritative
-- and can only ever be written by a future internal-write-flagged function
-- (the payroll-approval RPC added below covers approval_status specifically;
-- any later correction/review UI must add its own narrowly-scoped RPC rather
-- than widen this trigger's authenticated-role allowance).
-- ---------------------------------------------------------------------------
create or replace function fdh9_payroll_events_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.household_id is distinct from old.household_id
     or new.statement_upload_id is distinct from old.statement_upload_id
     or new.country_code is distinct from old.country_code
     or new.currency_code is distinct from old.currency_code
     or new.pay_period_start is distinct from old.pay_period_start
     or new.pay_period_end is distinct from old.pay_period_end
     or new.payment_date is distinct from old.payment_date
     or new.pay_frequency is distinct from old.pay_frequency
     or new.pay_frequency_source is distinct from old.pay_frequency_source
     or new.gross_pay is distinct from old.gross_pay
     or new.base_pay is distinct from old.base_pay
     or new.overtime_pay is distinct from old.overtime_pay
     or new.bonus_pay is distinct from old.bonus_pay
     or new.commission_pay is distinct from old.commission_pay
     or new.allowances_total is distinct from old.allowances_total
     or new.reimbursements_total is distinct from old.reimbursements_total
     or new.other_earnings is distinct from old.other_earnings
     or new.tax_withheld is distinct from old.tax_withheld
     or new.employee_deductions_total is distinct from old.employee_deductions_total
     or new.salary_sacrifice is distinct from old.salary_sacrifice
     or new.professional_tax is distinct from old.professional_tax
     or new.employer_retirement_contribution is distinct from old.employer_retirement_contribution
     or new.employee_retirement_contribution is distinct from old.employee_retirement_contribution
     or new.employer_nps_contribution is distinct from old.employer_nps_contribution
     or new.employee_nps_contribution is distinct from old.employee_nps_contribution
     or new.net_pay is distinct from old.net_pay
     or new.ytd_gross is distinct from old.ytd_gross
     or new.ytd_tax is distinct from old.ytd_tax
     or new.ytd_net is distinct from old.ytd_net
     or new.ytd_employer_retirement is distinct from old.ytd_employer_retirement
     or new.ytd_employee_retirement is distinct from old.ytd_employee_retirement
     or new.parser_name is distinct from old.parser_name
     or new.parser_version is distinct from old.parser_version
     or new.extraction_confidence is distinct from old.extraction_confidence
     or new.reconciliation_status is distinct from old.reconciliation_status
     or new.reconciliation_variance is distinct from old.reconciliation_variance
     or new.bank_match_status is distinct from old.bank_match_status
     or new.bank_match_transaction_id is distinct from old.bank_match_transaction_id
     or new.bank_match_confidence is distinct from old.bank_match_confidence
     or new.review_status is distinct from old.review_status
     or new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.superseded_by_payroll_event_id is distinct from old.superseded_by_payroll_event_id
     or new.payslip_fingerprint is distinct from old.payslip_fingerprint
  then
    raise exception 'fdh_payroll_events: this field is system-authoritative and may not be written directly by the authenticated role';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_payroll_events_authoritative_write
  before update on fdh_payroll_events
  for each row execute function fdh9_payroll_events_assert_authoritative_write();


-- ---------------------------------------------------------------------------
-- D.5 income_sources — provenance columns are authoritative too (spec
-- sections 41, 51), even though the rest of the row stays exactly as
-- user-editable as it is today (spec sections 55, 61: manual Income entry
-- must be completely unaffected).
-- ---------------------------------------------------------------------------
create or replace function fdh9_income_sources_assert_provenance_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.source_type is distinct from old.source_type
     or new.last_import_application_id is distinct from old.last_import_application_id
     or new.last_imported_at is distinct from old.last_imported_at
  then
    raise exception 'income_sources: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_income_sources_provenance_write
  before update on income_sources
  for each row execute function fdh9_income_sources_assert_provenance_write();


-- ===========================================================================
-- D.6 THE ATOMIC APPLY RPC (spec sections 3-9, 17-25, 28-41).
--
-- The one function in the platform permitted to move a proposal into
-- 'applied'. Runs entirely inside the single transaction PostgREST opens for
-- the RPC call: every statement below either all commits together or (on any
-- unhandled error, including a deliberately forced one) all rolls back
-- together, because this is a FUNCTION, not a PROCEDURE — it has no COMMIT of
-- its own, so an exception at any point aborts the whole enclosing
-- transaction and undoes every write this function made, including the
-- proposal-claim UPDATE issued earlier in the very same call (spec section
-- 18's mid-operation-failure requirement, satisfied by ordinary Postgres
-- transaction semantics rather than by any try/catch in this function or in
-- application code, per spec section 41).
--
-- FDH-9 currently ships Income as the only implemented target_domain (spec
-- section 5) — the function raises PROPOSAL_NOT_ACTIONABLE for any other
-- domain rather than attempting a generic dynamic mutation (spec section 6).
-- A future domain adapter adds its own narrow branch here, not a generic
-- escape hatch.
-- ===========================================================================
create or replace function fdh9_apply_income_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_selected_fields text[] default null
) returns jsonb as $$
declare
  v_uid uuid;
  v_proposal record;
  v_income record;
  v_allowed constant text[] := array['source_name','employer_name','income_type','amount','net_amount','frequency','currency_code','is_taxable'];
  v_kinds constant jsonb := jsonb_build_object(
    'source_name','text','employer_name','text','income_type','enum','amount','money',
    'net_amount','money','frequency','enum','currency_code','enum','is_taxable','bool'
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
  v_kind text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_apply_income_proposal: authentication required';
  end if;
  if p_decision not in ('add_new','update_existing','apply_selected_fields','keep_existing') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'Unrecognised decision.');
  end if;

  -- Lock the proposal row for the duration of this transaction so a
  -- concurrent apply of the SAME proposal cannot interleave with this one
  -- (spec section 40) — the second caller blocks here until the first
  -- commits or aborts, then re-reads a status that is no longer 'ready'.
  select * into v_proposal from fhip_import_proposals where id = p_proposal_id for update;
  if not found or v_proposal.user_id <> v_uid then
    -- Same response for "does not exist" and "belongs to someone else" — a
    -- cross-tenant probe (spec section 24) learns nothing from the answer.
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That import proposal could not be found.');
  end if;
  if v_proposal.target_domain <> 'income' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_ACTIONABLE', 'error', 'That proposal is for a part of your data this function does not yet handle.');
  end if;

  -- --- KEEP EXISTING: no write to Income of any kind (spec section 59) -----
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
        then 'This proposal has already been applied to your income.'
        else 'That proposal is no longer open.' end
    );
  end if;
  if p_decision <> 'add_new' and v_proposal.target_entity_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPLY_MODE', 'error', 'There is no existing entry to update.');
  end if;

  -- --- Resolve the requested field set --------------------------------------
  if p_decision = 'update_existing' and (p_selected_fields is null or array_length(p_selected_fields, 1) is null) then
    select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;
  else
    v_selected := coalesce(p_selected_fields, array[]::text[]);
  end if;
  if v_selected is null then v_selected := array[]::text[]; end if;

  -- Allow-list (spec section 6): checked BEFORE anything else touches the
  -- field name, so a forged proposal_fields row naming an unlisted column
  -- can never reach the dynamic SET/INSERT below.
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
    if not ('source_name' = any(v_selected)) or not ('amount' = any(v_selected)) or not ('frequency' = any(v_selected)) then
      return jsonb_build_object('ok', false, 'code', 'DOMAIN_VALIDATION_FAILED', 'error', 'A new income entry needs a name, a gross amount and a frequency.');
    end if;
  end if;

  -- --- Target ownership + staleness (spec sections 7, 24, 39) ---------------
  if p_decision <> 'add_new' then
    select * into v_income from income_sources where id = v_proposal.target_entity_id and user_id = v_uid for update;
    if not found then
      -- Covers BOTH "row genuinely gone" and "target_entity_id points at
      -- another tenant's row" — the same-tenant trigger on
      -- fhip_import_proposals (Part B) already stops that at proposal-write
      -- time, but this re-check makes the apply path itself independently
      -- safe even if that trigger were ever bypassed (spec section 24).
      return jsonb_build_object('ok', false, 'code', 'TARGET_NOT_FOUND', 'error', 'The income entry this proposal refers to could not be found.');
    end if;

    for v_field in
      select pf.field_name, pf.value_kind, pf.existing_value
      from fhip_import_proposal_fields pf
      where pf.proposal_id = p_proposal_id and pf.field_name = any(v_selected)
    loop
      v_live_text := case v_field.field_name
        when 'source_name'    then v_income.source_name
        when 'employer_name'  then v_income.employer_name
        when 'income_type'    then v_income.income_type
        when 'frequency'      then v_income.frequency
        when 'currency_code'  then v_income.currency_code
        when 'amount'         then case when v_income.amount is null then null else round(v_income.amount, 2)::text end
        when 'net_amount'     then case when v_income.net_amount is null then null else round(v_income.net_amount, 2)::text end
        when 'is_taxable'     then case when v_income.is_taxable is null then null when v_income.is_taxable then 'true' else 'false' end
        else null
      end;
      if v_field.value_kind in ('text', 'enum') then
        v_live_text := nullif(trim(both from coalesce(v_live_text, '')), '');
      end if;
      if v_live_text is distinct from v_field.existing_value then
        return jsonb_build_object(
          'ok', false, 'code', 'STALE_PROPOSAL',
          'error', 'Your income details changed after this proposal was prepared, so it was not applied.',
          'field', v_field.field_name, 'existing', v_field.existing_value, 'current', v_live_text
        );
      end if;
      v_previous := v_previous || jsonb_build_object(v_field.field_name, v_field.existing_value);
    end loop;
  end if;

  -- --- Build the typed patch (spec section 6: explicit allow-listed columns
  -- only; no arbitrary dynamic column/SQL from proposal data) --------------
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
    elsif v_kind = 'bool' then
      v_set_parts := array_append(v_set_parts, format('%I = %L::boolean', v_field.field_name, (v_field.proposed_value = 'true')));
      v_cols := array_append(v_cols, v_field.field_name);
      v_vals := array_append(v_vals, format('%L::boolean', (v_field.proposed_value = 'true')));
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

  -- --- Atomic claim (spec sections 3, 8, 40): compare-and-swap. A second,
  -- concurrent caller that reaches this line finds status <> 'ready' (either
  -- because it was blocked by the row lock above until this transaction
  -- committed, or because it lost the race) and is refused as ALREADY_APPLIED
  -- rather than double-applying. -------------------------------------------
  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fhip_import_proposals set status = 'applied', applied_at = now()
    where id = p_proposal_id and status = 'ready';
  if not found then
    perform set_config('fhip.import_bridge_internal_write', 'false', true);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'error', 'This proposal has already been applied to your income.');
  end if;

  -- --- The canonical Income mutation ----------------------------------------
  if p_decision = 'add_new' then
    v_cols := array_prepend('last_imported_at', array_prepend('source_type', array_prepend('is_active', array_prepend('owner', array_prepend('user_id', v_cols)))));
    v_vals := array_prepend('now()', array_prepend(format('%L', 'payslip_import'), array_prepend('true', array_prepend(format('%L', 'self'), array_prepend(format('%L::uuid', v_uid), v_vals)))));
    execute format('insert into income_sources (%s) values (%s) returning id', array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_target_id;
  else
    v_target_id := v_proposal.target_entity_id;
    execute format('update income_sources set %s, updated_at = now() where id = %L::uuid and user_id = %L::uuid', array_to_string(v_set_parts, ', '), v_target_id, v_uid);
  end if;

  -- --- The append-only application audit row (spec sections 3, 20, 32) -----
  insert into fhip_import_applications (
    user_id, proposal_id, target_domain, target_entity_id, apply_mode,
    applied_fields, previous_values, new_values, source_payroll_event_id, applied_by
  ) values (
    v_uid, p_proposal_id, 'income', v_target_id, p_decision,
    to_jsonb(v_applied_fields), v_previous, v_new, v_proposal.source_payroll_event_id, v_uid
  ) returning id into v_application_id;

  -- --- Provenance stamp (spec sections 41, 51) ------------------------------
  update income_sources
    set source_type = 'payslip_import', last_import_application_id = v_application_id, last_imported_at = now()
    where id = v_target_id and user_id = v_uid;

  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object(
    'ok', true, 'outcome', 'applied', 'apply_mode', p_decision,
    'target_entity_id', v_target_id, 'application_id', v_application_id,
    'applied_fields', to_jsonb(v_applied_fields)
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_apply_income_proposal(uuid, text, text[]) from public;
grant execute on function fdh9_apply_income_proposal(uuid, text, text[]) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- D.7 fdh9_approve_payroll_event — the one legitimate way approval_status
-- (and every other field D.4 locks) ever moves (spec sections 10, 42).
-- Deliberately tiny: verifies auth, locks the row, verifies ownership,
-- enforces the one valid transition, and is idempotent on a row already
-- approved by the SAME user (re-clicking Approve is not an error).
-- ---------------------------------------------------------------------------
create or replace function fdh9_approve_payroll_event(p_payroll_event_id uuid) returns jsonb as $$
declare
  v_uid uuid;
  v_event record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'fdh9_approve_payroll_event: authentication required';
  end if;

  select * into v_event from fdh_payroll_events where id = p_payroll_event_id for update;
  if not found or v_event.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_FOUND', 'error', 'That payroll event could not be found.');
  end if;

  if v_event.approval_status = 'approved' then
    return jsonb_build_object('ok', true, 'outcome', 'already_approved', 'approved_at', v_event.approved_at);
  end if;

  perform set_config('fhip.import_bridge_internal_write', 'true', true);
  update fdh_payroll_events
    set approval_status = 'approved', approved_at = now(), approved_by = v_uid
    where id = p_payroll_event_id;
  perform set_config('fhip.import_bridge_internal_write', 'false', true);

  return jsonb_build_object('ok', true, 'outcome', 'approved');
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fdh9_approve_payroll_event(uuid) from public;
grant execute on function fdh9_approve_payroll_event(uuid) to authenticated, service_role;
