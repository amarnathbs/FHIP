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
--
-- RECONCILIATION NOTE (added during II-R12 terminal certification,
-- 2026-08-26): this section's fix was later extracted verbatim and shipped
-- standalone, ahead of the rest of R12, as migration 0094 (see 0094's own
-- header for the full rationale) -- 0094 is the CANONICAL, already-live
-- (DEV + production) version of this security fix. 0094's header claimed
-- re-applying this pair later via 0092 would be "safe and produce a
-- byte-identical end state, not a conflict" -- a fresh full-stack PGlite
-- replay done as part of this certification round proved that claim WRONG
-- as originally written: because migration numbers apply in order (0092
-- before 0094), a from-scratch replay hits 0092 FIRST, which creates
-- "read own ii_holding_snapshots" -- then 0094 runs and tries to
-- `drop policy if exists "own ii_holding_snapshots"` (already renamed away,
-- so a no-op) followed by `create policy "read own ii_holding_snapshots"`,
-- which now ALREADY EXISTS -> 42710 "policy already exists", replay fails.
-- The identical failure mode would hit any environment where 0094 has
-- already run standalone (i.e. DEV and production, right now) if 0092 were
-- ever applied there afterward, in the OTHER order: 0094's drop of the OLD
-- name is a no-op (already gone) and 0092's create of the SAME name it
-- already holds would 42710 again.
--
-- An idempotent drop-and-recreate here (as originally attempted) does NOT
-- actually solve it either: making 0092's own copy tolerant of running
-- twice does not stop migration 0094 (frozen, never edited, and applied at
-- position 0094 -- strictly AFTER 0092 in every numeric replay ordering)
-- from unconditionally trying to `create policy "read own
-- ii_holding_snapshots"` right after 0092 already created the exact same
-- name -- Postgres has no `create policy if not exists`, so that create
-- always raises 42710 the moment BOTH migrations exist in the same replay,
-- regardless of which one is made defensive.
--
-- Correct fix, since 0094 cannot be touched: 0092 must not create this
-- policy AT ALL any more. 0094 is the sole, permanent, canonical owner of
-- ii_holding_snapshots' RLS policy from here on -- it already runs at
-- position 0094 in every replay (fresh or incremental) and already IS live
-- in both DEV and production. This section is now a documentation-only
-- no-op: it changes no deployed state (independently confirmed by live
-- read-only REST checks against both DEV and production finding section
-- 3's price_source column absent from both, proving this file -- as a
-- whole -- has never actually been applied anywhere), and a full-stack
-- PGlite replay including both 0092 and 0094 was re-run after this edit to
-- confirm 0 failures.
-- ---------------------------------------------------------------------------
-- (intentionally no DDL in this section -- see note above; 0094 owns it)

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
