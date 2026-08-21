-- =============================================================================
-- Financial Data Hub (FDH) — FDH-1 Migration C (0047): canonical transaction model,
-- splits, links, duplicates, user rules, classification history and the
-- recurring-payment foundation.
-- =============================================================================
-- MONETARY STORAGE. Every persisted money column is numeric(20,4). No
-- float/double/real appears anywhere in the FDH schema. numeric(20,4) holds
-- values up to 10^16 with four decimal places, which covers Indian crore-scale
-- amounts and sub-paisa/sub-cent FX residue without loss. FX rates are
-- numeric(20,10); confidences are numeric(5,4) over the closed range [0,1].
--
-- DIRECTION vs MEANING. `credit_debit` (which way the money moved on the
-- account) and `economic_transaction_type` (what it means economically) are
-- two independent columns and are never conflated. A credit is NOT income (a
-- refund, a transfer in, a loan drawdown and a reversal are all credits); a
-- debit is NOT an expense (a transfer out, an investment purchase and a debt
-- principal repayment are all debits). No constraint, index or code path in
-- FDH assumes CREDIT=income or DEBIT=expense.
--
-- SIGN CONVENTION. `amount_original` is a strictly positive MAGNITUDE
-- (check amount_original > 0). Direction lives in credit_debit and nowhere
-- else. The signed economic value is derived — see
-- lib/financial-data-hub/domain/money.ts toSignedAmount(). Storing a signed
-- amount as well as a direction column would permit two contradictory
-- encodings of the same fact.
--
-- CURRENCY. The original currency of the transaction is preserved separately
-- from the reporting currency, together with the rate, the rate date and the
-- rate source. FDH-1 implements NO FX provider and performs NO conversion.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_transactions — the canonical FDH transaction.
--
-- RAW vs CLEAN (privacy). `description_raw` and `merchant_raw` are the
-- verbatim source strings and are DELIBERATELY NULLABLE so the retention
-- lifecycle can null them once normalisation has produced `description_clean`
-- and `merchant_id`. Nothing in this schema makes a raw field mandatory —
-- see FDH1_PRIVACY_DATA_LIFECYCLE.md §4 and the regression test
-- tests/unit/fdh1PrivacyLifecycle.test.ts.
--
-- CONFIDENCE. Two structurally distinct confidences live here —
-- `extraction_confidence` (did we read the document correctly?) and
-- `classification_confidence` (did we categorise it correctly?). They are
-- never merged into one number. The third dimension, EVIDENCE COMPLETENESS,
-- is a property of a derived fact rather than of a transaction and lives on
-- fdh_data_provenance (migration 0048). Reconciliation is a STATE, not a
-- fourth confidence score.
--
-- USER CORRECTIONS. `user_override` marks a row a human has settled.
-- Combined with the append-only fdh_classification_history below, a future
-- reprocessing run can always tell an automatic classification apart from a
-- confirmed human decision. FDH-1 implements no reprocessing.
--
-- INVESTMENT BOUNDARY. `investment`, `asset_purchase` and `asset_sale` are
-- economic MEANINGS of a cash movement observed on a bank or card statement.
-- This table is not an investment ledger: it has no instrument, no units, no
-- NAV, no folio and no holding. Investment Intelligence owns those.
-- ---------------------------------------------------------------------------
create table fdh_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  financial_account_id uuid not null references fdh_financial_accounts(id) on delete cascade,
  -- Nullable: a future connected feed (CDR / Account Aggregator) produces
  -- transactions with no document behind them.
  statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,

  -- Business dates: time-of-day is meaningless, so DATE not timestamptz.
  transaction_date date not null,
  posting_date date,
  value_date date,

  description_raw text,          -- purgeable by design
  description_clean text,
  merchant_raw text,             -- purgeable by design
  merchant_id uuid references fdh_merchants(id) on delete set null,

  amount_original numeric(20,4) not null check (amount_original > 0),
  currency_original char(3) not null references currencies(currency_code) on delete restrict,
  amount_reporting_currency numeric(20,4)
    check (amount_reporting_currency is null or amount_reporting_currency > 0),
  reporting_currency char(3) references currencies(currency_code) on delete restrict,
  fx_rate numeric(20,10) check (fx_rate is null or fx_rate > 0),
  fx_rate_date date,
  fx_rate_source text
    check (fx_rate_source is null or fx_rate_source in (
      'none', 'user_supplied', 'statement_supplied', 'platform_static', 'external_provider'
    )),

  credit_debit text not null check (credit_debit in ('credit', 'debit')),
  economic_transaction_type text not null default 'unknown'
    check (economic_transaction_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  category_id uuid references fdh_categories(id) on delete set null,
  subcategory_id uuid references fdh_subcategories(id) on delete set null,

  recurring_flag boolean not null default false,
  subscription_flag boolean not null default false,
  transfer_flag boolean not null default false,

  classification_confidence numeric(5,4)
    check (classification_confidence is null
           or (classification_confidence >= 0 and classification_confidence <= 1)),
  extraction_confidence numeric(5,4)
    check (extraction_confidence is null
           or (extraction_confidence >= 0 and extraction_confidence <= 1)),
  classification_method text
    check (classification_method is null or classification_method in (
      'source', 'merchant_master', 'global_rule', 'user_rule', 'ai',
      'user_manual', 'admin_master_data', 'unclassified'
    )),

  source_reference text,                                  -- e.g. a bank's own reference
  source_page int check (source_page is null or source_page >= 1),
  source_row int check (source_row is null or source_row >= 1),

  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  user_override boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A reporting amount without a reporting currency (or vice versa) is
  -- meaningless; they travel together or not at all.
  constraint chk_fdh_txn_reporting_pair
    check ((amount_reporting_currency is null) = (reporting_currency is null)),
  -- An FX rate is only interpretable alongside the currencies it converts.
  constraint chk_fdh_txn_fx_pair
    check (fx_rate is null or reporting_currency is not null)
);
create index idx_fdh_txn_user on fdh_transactions(user_id);
-- The dominant query shape: one account's transactions over a date window.
create index idx_fdh_txn_account_date
  on fdh_transactions(financial_account_id, transaction_date desc);
create index idx_fdh_txn_user_date on fdh_transactions(user_id, transaction_date desc);
create index idx_fdh_txn_upload on fdh_transactions(statement_upload_id);
create index idx_fdh_txn_merchant on fdh_transactions(merchant_id) where merchant_id is not null;
create index idx_fdh_txn_category on fdh_transactions(category_id) where category_id is not null;
-- The review queue: rows still needing a human. Partial keeps it tiny.
create index idx_fdh_txn_review on fdh_transactions(user_id, review_status)
  where review_status in ('pending', 'in_review');

alter table fdh_transactions enable row level security;
create policy "own rows - fdh_transactions" on fdh_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_transaction_allocations — split transactions. One supermarket debit may
-- be part groceries, part household goods, part a gift.
--
-- Allocation amounts are positive magnitudes of the SAME direction as the
-- parent (a split does not reverse direction). The completeness rule —
-- sum(allocations) must equal the parent amount — is DELIBERATELY NOT a
-- database constraint: allocations are edited incrementally while a
-- transaction is still under review, and a row-level constraint would make a
-- half-entered split impossible to save. It is enforced by the domain
-- validator assertAllocationsReconcile() in
-- lib/financial-data-hub/domain/allocations.ts at the point a transaction is
-- finalised, with an explicit smallest-currency-unit tolerance.
-- ---------------------------------------------------------------------------
create table fdh_transaction_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references fdh_transactions(id) on delete cascade,
  allocation_sequence int not null check (allocation_sequence >= 1),
  economic_transaction_type text not null
    check (economic_transaction_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  category_id uuid references fdh_categories(id) on delete set null,
  subcategory_id uuid references fdh_subcategories(id) on delete set null,
  amount numeric(20,4) not null check (amount > 0),
  currency_code char(3) not null references currencies(currency_code) on delete restrict,
  percentage numeric(7,4) check (percentage is null or (percentage > 0 and percentage <= 100)),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_fdh_allocation_sequence unique (transaction_id, allocation_sequence)
);
create index idx_fdh_allocations_txn on fdh_transaction_allocations(transaction_id);
create index idx_fdh_allocations_user on fdh_transaction_allocations(user_id);

alter table fdh_transaction_allocations enable row level security;
create policy "own rows - fdh_transaction_allocations" on fdh_transaction_allocations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_transaction_links — a generic relationship between two transactions.
-- NO MATCHING ALGORITHM IS IMPLEMENTED IN FDH-1 (FDH-6).
--
-- PERSISTENT MISSING COUNTERPART. `transaction_id_to` is NULLABLE on purpose.
-- Statement A is imported in March and a probable transfer out is observed,
-- but the receiving account has not been imported yet. The link is recorded
-- with a null counterpart and stays open. Statement B arrives in May and a
-- future matching engine can resolve it. Nothing about this schema requires
-- both sides to exist within one import session.
-- ---------------------------------------------------------------------------
create table fdh_transaction_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id_from uuid not null references fdh_transactions(id) on delete cascade,
  transaction_id_to uuid references fdh_transactions(id) on delete cascade,
  link_type text not null
    check (link_type in (
      'internal_transfer', 'credit_card_settlement', 'refund_original',
      'reversal_original', 'duplicate', 'investment_funding', 'loan_payment', 'other'
    )),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected', 'superseded')),
  created_by_method text not null
    check (created_by_method in ('system_rule', 'algorithm', 'ai', 'user_manual', 'admin')),
  user_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_links_not_self
    check (transaction_id_to is null or transaction_id_to <> transaction_id_from)
);
-- Two partial unique indexes, because a NULL counterpart must not collide
-- with another NULL counterpart of a different link type.
create unique index uq_fdh_links_pair
  on fdh_transaction_links(transaction_id_from, transaction_id_to, link_type)
  where transaction_id_to is not null;
create unique index uq_fdh_links_open
  on fdh_transaction_links(transaction_id_from, link_type)
  where transaction_id_to is null;
create index idx_fdh_links_user on fdh_transaction_links(user_id);
create index idx_fdh_links_to on fdh_transaction_links(transaction_id_to)
  where transaction_id_to is not null;
-- Unresolved links a future matching engine will retry.
create index idx_fdh_links_unresolved on fdh_transaction_links(user_id, link_type)
  where transaction_id_to is null and status = 'pending';

alter table fdh_transaction_links enable row level security;
create policy "own rows - fdh_transaction_links" on fdh_transaction_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_duplicate_candidates — NO DUPLICATE-DETECTION ENGINE IS IMPLEMENTED IN
-- FDH-1 (FDH-6). This is the record a future engine will write and a user
-- will resolve.
-- ---------------------------------------------------------------------------
create table fdh_duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id_a uuid not null references fdh_transactions(id) on delete cascade,
  transaction_id_b uuid not null references fdh_transactions(id) on delete cascade,
  match_method text not null
    check (match_method in ('exact_hash', 'fuzzy_amount_date', 'statement_overlap', 'user_reported')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed_duplicate', 'not_duplicate', 'auto_confirmed')),
  reason_code text,
  user_resolution text
    check (user_resolution is null or user_resolution in ('kept_both', 'removed_a', 'removed_b', 'merged')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint chk_fdh_dupe_distinct check (transaction_id_a <> transaction_id_b),
  constraint uq_fdh_dupe_pair unique (transaction_id_a, transaction_id_b),
  constraint chk_fdh_dupe_resolution
    check (status = 'pending' or resolved_at is not null)
);
create index idx_fdh_dupe_user on fdh_duplicate_candidates(user_id, status);
create index idx_fdh_dupe_b on fdh_duplicate_candidates(transaction_id_b);

alter table fdh_duplicate_candidates enable row level security;
create policy "own rows - fdh_duplicate_candidates" on fdh_duplicate_candidates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_user_classification_rules — a household's own rules ("anything from
-- ACME PTY LTD is a business expense").
--
-- Created BEFORE fdh_classification_history because that table references it.
--
-- SAFE RULE DEFINITIONS. match_definition / action_definition are structured
-- JSON objects carrying a discriminator, never an executable expression and
-- never a user-supplied regular expression (an unbounded user regex is a
-- denial-of-service vector). The closed vocabulary is enforced by the Zod
-- discriminated unions in
-- lib/financial-data-hub/validation/classification.ts; the database enforces
-- the shape.
--
-- CRITICAL RULE: rows here are the ONLY place a user's own classification
-- preference is stored. They never propagate into fdh_merchants or
-- fdh_classification_rules — those are admin/service-role write-only.
-- ---------------------------------------------------------------------------
create table fdh_user_classification_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  rule_type text not null
    check (rule_type in (
      'merchant_exact', 'merchant_alias', 'mcc', 'description_contains',
      'institution_narrative', 'source_provided_category', 'account_scoped_default'
    )),
  match_definition jsonb not null,
  action_definition jsonb not null,
  priority int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_user_rules_match_shape
    check (jsonb_typeof(match_definition) = 'object' and match_definition ? 'match_kind'),
  constraint chk_fdh_user_rules_action_shape
    check (jsonb_typeof(action_definition) = 'object' and action_definition ? 'action_kind')
);
create index idx_fdh_user_rules_lookup
  on fdh_user_classification_rules(user_id, rule_type, priority) where active;

alter table fdh_user_classification_rules enable row level security;
create policy "own rows - fdh_user_classification_rules" on fdh_user_classification_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_classification_history — append-only audit of every classification
-- change, and the mechanism that keeps a user's confirmed decision
-- distinguishable from an automatic one across a future reprocessing run.
--
-- RLS DEVIATION, DELIBERATE. Every other user-owned FDH table uses the
-- standard `for all` policy. This one splits SELECT and INSERT and grants NO
-- update and NO delete policy, so the owner can append and read their own
-- history but cannot rewrite or erase it. Postgres denies any verb without a
-- policy. This is a strict tightening of the house pattern, chosen because an
-- audit trail a user can edit is not an audit trail. Precedent for
-- append-only intent already exists in the schema (audit_events,
-- financial_records_audit — FDH0_RLS_BASELINE.md §3d), which are SELECT-only;
-- FDH adds INSERT because, unlike those two, this table is actually written
-- by the RLS-scoped session client rather than by a service role.
-- ---------------------------------------------------------------------------
create table fdh_classification_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references fdh_transactions(id) on delete cascade,
  previous_economic_transaction_type text
    check (previous_economic_transaction_type is null or previous_economic_transaction_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  new_economic_transaction_type text not null
    check (new_economic_transaction_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  previous_category_id uuid references fdh_categories(id) on delete set null,
  new_category_id uuid references fdh_categories(id) on delete set null,
  previous_subcategory_id uuid references fdh_subcategories(id) on delete set null,
  new_subcategory_id uuid references fdh_subcategories(id) on delete set null,
  classification_method text not null
    check (classification_method in (
      'source', 'merchant_master', 'global_rule', 'user_rule', 'ai',
      'user_manual', 'admin_master_data'
    )),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  changed_by_type text not null check (changed_by_type in ('system', 'user', 'admin')),
  changed_by_user uuid references auth.users(id) on delete set null,
  -- Two explicit columns rather than one polymorphic rule_id, so both sides
  -- keep a real foreign key.
  global_rule_id uuid references fdh_classification_rules(id) on delete set null,
  user_rule_id uuid references fdh_user_classification_rules(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_fdh_class_history_txn
  on fdh_classification_history(transaction_id, created_at desc);
create index idx_fdh_class_history_user on fdh_classification_history(user_id);

alter table fdh_classification_history enable row level security;
create policy "own rows read - fdh_classification_history" on fdh_classification_history
  for select using (auth.uid() = user_id);
create policy "own rows append - fdh_classification_history" on fdh_classification_history
  for insert with check (auth.uid() = user_id);
-- Intentionally no UPDATE and no DELETE policy: append-only.


-- ---------------------------------------------------------------------------
-- fdh_recurring_transactions — the recurring / subscription foundation.
-- NO DETECTION ALGORITHM IS IMPLEMENTED IN FDH-1 (FDH-6).
-- ---------------------------------------------------------------------------
create table fdh_recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  merchant_id uuid references fdh_merchants(id) on delete set null,
  financial_account_id uuid references fdh_financial_accounts(id) on delete cascade,
  frequency text not null
    check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annual', 'irregular')),
  expected_amount numeric(20,4) check (expected_amount is null or expected_amount > 0),
  amount_tolerance numeric(20,4) check (amount_tolerance is null or amount_tolerance >= 0),
  currency_code char(3) references currencies(currency_code) on delete restrict,
  next_expected_date date,
  status text not null default 'candidate'
    check (status in ('candidate', 'active', 'paused', 'ended')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  user_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_recurring_amount_currency
    check ((expected_amount is null) or (currency_code is not null))
);
create index idx_fdh_recurring_user on fdh_recurring_transactions(user_id, status);
create index idx_fdh_recurring_due on fdh_recurring_transactions(next_expected_date)
  where status = 'active';

alter table fdh_recurring_transactions enable row level security;
create policy "own rows - fdh_recurring_transactions" on fdh_recurring_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
