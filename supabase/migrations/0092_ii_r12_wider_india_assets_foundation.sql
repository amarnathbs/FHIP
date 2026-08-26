-- Investment Intelligence R12 -- Wider India Assets (Direct Equity + Equity ETF).
--
-- NUMBERING: allocated fresh at 0092, the first genuinely free number after a
-- full cross-branch collision scan at dispatch time (git ls-tree on
-- origin/main + every worktree under .claude/worktrees/): 0079-0081 are
-- claimed by the unmerged feature/app-review-remainder-input-ux-currency-
-- onboarding branch, 0091 is claimed by the unmerged
-- fdh9-payslip-income-intelligence branch. Neither is touched, edited, or
-- renumbered here. 0082-0090 (frozen, DEV+production-applied) are also not
-- touched. See R12_WIDER_INDIA_ASSETS_ARCHITECTURE_DISCOVERY.md section 1.
--
-- CONTENTS
-- --------
-- 1. Security fix: ii_holding_snapshots same-user authoritative-forgery gap
--    (the same defect class 0087 fixed on ii_transactions/
--    ii_reconciliation_cases, 0069 fixed on ii_review_items, 0065 fixed on
--    fdh_statement_uploads -- found live during R12's own P0 architecture
--    discovery, not hypothetical). A full grep of app/ + lib/ for
--    .insert(/.update(/.upsert( against 'ii_holding_snapshots' finds zero
--    authenticated-client call sites -- every real write is via
--    createAdminClient() in manualImporter.ts / documentProcessing.ts /
--    investmentPublicationService.ts. Replaced with SELECT-only for the
--    owner, matching 0087's ii_transactions shape exactly (no trigger
--    needed -- there is no legitimate authenticated write path to carve an
--    exception for, unlike ii_reconciliation_cases).
-- 2. ii_transactions.transaction_type gains exactly one new value: 'sale'
--    (equity/ETF market disposal -- distinct from mutual-fund 'redemption',
--    which means unit redemption from a scheme). No other new transaction
--    types are added (R12_TRANSACTION_SEMANTICS.md).
-- 3. ii_holding_snapshots gains a nullable price_source column (price
--    provenance, spec section 38) -- null for every pre-R12 row (their
--    provenance is CAS-statement-derived, unchanged); R12 manual-entry
--    writes always set it explicitly.
-- 4. ii_scheme_tax_classification.basis gains exactly one new value,
--    'direct_listed_security_rule' -- a direct listed equity share or an
--    equity-oriented ETF unit is equity_oriented BY STATUTE (Section
--    111A/112A applies to "an equity share in a company" and "a unit of an
--    equity oriented fund" identically -- it has never been an allocation
--    test the way a hybrid mutual fund's classification is). R12 does NOT
--    reuse classifyScheme()'s look-through allocation test (that would be
--    meaningless for a single security with no underlying holdings to
--    disclose) -- it writes this table directly with a rule-based basis,
--    reusing the SAME cache table and the SAME unmodified
--    computeDisposalTax() read path every mutual fund already goes
--    through (R12_INDIA_TAX_AND_COST_INTEGRATION.md). This is additive:
--    the 4 existing basis values and every existing row are unchanged.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ii_holding_snapshots RLS hardening.
-- ---------------------------------------------------------------------------
drop policy if exists "own ii_holding_snapshots" on ii_holding_snapshots;
create policy "read own ii_holding_snapshots" on ii_holding_snapshots
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for authenticated at all -- every write is
-- exclusively via the service-role admin client, verified above; RLS
-- refuses any authenticated write outright, matching ii_transactions'
-- identical post-0087 write model.

-- ---------------------------------------------------------------------------
-- 2. ii_transactions.transaction_type: add 'sale'. Based on the CURRENT
--    22-value constraint as of migration 0059 (R6-P1's own additive
--    extension on top of 0040's R2 extension on top of 0033's R1 12-value
--    taxonomy) -- confirmed by grep that no migration between 0059 and
--    0090 touches this constraint again. All 22 existing values are kept
--    unchanged.
-- ---------------------------------------------------------------------------
alter table ii_transactions drop constraint if exists ii_transactions_transaction_type_check;
alter table ii_transactions add constraint ii_transactions_transaction_type_check
  check (transaction_type in (
    'purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment',
    'transfer', 'merger', 'fee', 'tax', 'adjustment',
    'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out', 'reversal', 'segregation', 'unclassified',
    'bonus', 'split',
    'sale'
  ));

-- ---------------------------------------------------------------------------
-- 3. ii_holding_snapshots: price provenance column (additive, nullable).
-- ---------------------------------------------------------------------------
alter table ii_holding_snapshots add column if not exists price_source text
  check (price_source is null or price_source in (
    'manual_entry', 'statement_price', 'admin_reference', 'certified_market_data'
  ));
comment on column ii_holding_snapshots.price_source is
  'R12 price provenance (spec section 38). Null for pre-R12 rows (CAS-statement-derived, unchanged behaviour). Every R12 manual-entry write sets this explicitly -- manual_entry for a user-entered price, never fabricated as certified_market_data.';

-- ---------------------------------------------------------------------------
-- 4. ii_scheme_tax_classification.basis: add 'direct_listed_security_rule'.
-- ---------------------------------------------------------------------------
alter table ii_scheme_tax_classification drop constraint if exists ii_scheme_tax_classification_basis_check;
alter table ii_scheme_tax_classification add constraint ii_scheme_tax_classification_basis_check
  check (basis in (
    'computed_from_holdings', 'known_debt_specified_category',
    'unresolved_no_data', 'unresolved_stale_data',
    'direct_listed_security_rule'
  ));
