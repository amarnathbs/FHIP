-- Investment Intelligence R6-P1 — India Tax & Cost Intelligence schema.
-- Forward-only migration. Does NOT modify any already-applied migration.
--
-- ===========================================================================
-- MIGRATION NUMBERING CAVEAT — carried forward from 0044's header
-- ===========================================================================
-- The unresolved cross-lineage migration-numbering fork disclosed at FDH-0
-- and worked on by a separate DB-governance task
-- (feature branch fix/migration-lineage-ii-resources, doc
-- docs/investment-intelligence/... ii_resources_migration_reconciliation)
-- is NOT resolved by this migration either. This branch was explicitly
-- forked from feature/investment-intelligence-r6-tax-cost-intelligence at
-- fd526ee — the R6-P0 tip — per the R6-P1 task brief, NOT from the
-- reconciliation branch's forward-emitted 0049. Within the INVESTMENT
-- INTELLIGENCE LINEAGE SPECIFICALLY (0031-0044), the next free number is
-- 0045. This migration does not attempt to reconcile against the FDH
-- stream's 0045-0048 or the reconciliation stream's 0049 — that is a
-- separate, already-tracked governance task. Whoever eventually merges this
-- branch must run it through the same reconciliation process before landing
-- on `main`.
--
-- ===========================================================================
-- SCOPE
-- ===========================================================================
-- R1 (migration 0031/0033) already shaped `ii_tax_rule_versions` (reference
-- data, unpopulated) and `ii_tax_lots` (per-user, unpopulated) "for a future
-- release" per their own comments. R6-P1 is that release: it SEEDS
-- ii_tax_rule_versions with the real, effective-dated 1961-Act/2025-Act-
-- placeholder rule set, and adds the tables R1 did not anticipate needing:
-- a FIFO lot-consumption ledger, a durable scheme tax-classification cache,
-- exit-load schedules, and a persisted capital-gains computation ledger.
--
-- No R2/R3/R4/R5 table is altered. No Resources/Phase-0C/FDH table or
-- schema is touched.

-- ---------------------------------------------------------------------------
-- 1. Extend ii_transactions.transaction_type (additive only) to admit the
--    two acquisition kinds neither the R1 (0033) nor R2 (0040) taxonomy
--    anticipated: bonus unit allotment and scheme-level unit splits. Both
--    need their own row so a tax lot can be opened with the correct (later)
--    acquisition date instead of inheriting the original investment's date.
--    Every R1 AND R2 value is kept verbatim (0040 already extended the R1
--    12-value set once; this is purely additive on top of THAT set, not a
--    reversion to R1's smaller list).
-- ---------------------------------------------------------------------------
alter table ii_transactions drop constraint ii_transactions_transaction_type_check;
alter table ii_transactions add constraint ii_transactions_transaction_type_check
  check (transaction_type in (
    'purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment',
    'transfer', 'merger', 'fee', 'tax', 'adjustment',
    'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out', 'reversal', 'segregation', 'unclassified',
    'bonus', 'split'
  ));

-- ---------------------------------------------------------------------------
-- 2. ii_scheme_tax_classification — durable, per-scheme classification
--    (equity_oriented / debt_specified / other_hybrid / unresolved), reusing
--    R2 Portfolio Truth's ii_fund_holdings/ii_instruments look-through data
--    to compute it. Shared reference-style data (not user-owned) — one
--    scheme's tax character is the same fact for every household holding
--    it, exactly like ii_fund_holdings/ii_prices_nav (world-read, no
--    authenticated insert/update/delete policy; writes go through the
--    service-role client, same as those two R1/R2 tables).
-- ---------------------------------------------------------------------------
create table ii_scheme_tax_classification (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  classification text not null check (classification in ('equity_oriented', 'debt_specified', 'other_hybrid', 'unresolved')),
  domestic_equity_pct numeric(6, 3),
  basis text not null check (basis in ('computed_from_holdings', 'known_debt_specified_category', 'unresolved_no_data', 'unresolved_stale_data')),
  disclosure_date date,
  engine_version text not null,
  computed_at timestamptz not null default now(),
  note text,
  unique (instrument_id)
);
alter table ii_scheme_tax_classification enable row level security;
create policy "read ii_scheme_tax_classification" on ii_scheme_tax_classification for select using (true);

-- ---------------------------------------------------------------------------
-- 3. ii_exit_load_schedules — scheme-level exit-load tier schedule. Shared
--    reference data, same read/write pattern as ii_fund_holdings.
-- ---------------------------------------------------------------------------
create table ii_exit_load_schedules (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  tiers jsonb not null, -- [{uptoDays: 365, loadPct: 1}, ...] ascending uptoDays; absence beyond last tier = 0%
  effective_from date not null,
  effective_to date,
  source_id uuid references ii_sources(id),
  created_at timestamptz default now(),
  unique (instrument_id, effective_from)
);
alter table ii_exit_load_schedules enable row level security;
create policy "read ii_exit_load_schedules" on ii_exit_load_schedules for select using (true);

-- ---------------------------------------------------------------------------
-- 4. ii_tax_lot_consumptions — the FIFO consumption ledger: which lot(s) a
--    redemption/switch-out consumed, and how many units from each. User-
--    owned (mirrors "own ii_tax_lots" policy). Append-only, same immutable
--    convention as ii_transactions/ii_holding_snapshots.
-- ---------------------------------------------------------------------------
create table ii_tax_lot_consumptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  disposal_transaction_id uuid not null references ii_transactions(id) on delete cascade,
  lot_id uuid not null references ii_tax_lots(id) on delete cascade,
  units_consumed numeric(20, 6) not null check (units_consumed > 0),
  cost_basis_pre_grandfathering numeric(18, 2) not null,
  sale_value_apportioned numeric(18, 2) not null,
  engine_version text not null,
  created_at timestamptz default now()
);
create index idx_ii_tax_lot_consumptions_user on ii_tax_lot_consumptions(user_id);
create index idx_ii_tax_lot_consumptions_disposal on ii_tax_lot_consumptions(disposal_transaction_id);
create index idx_ii_tax_lot_consumptions_lot on ii_tax_lot_consumptions(lot_id);
-- One consumption record per (disposal, lot) pair — a re-run of the engine
-- upserts rather than duplicating.
create unique index uidx_ii_tax_lot_consumptions_disposal_lot
  on ii_tax_lot_consumptions(disposal_transaction_id, lot_id);

alter table ii_tax_lot_consumptions enable row level security;
create policy "own ii_tax_lot_consumptions" on ii_tax_lot_consumptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 5. ii_capital_gains_computations — the persisted, per-lot-consumption tax
--    result: classification/rule-version/holding-period/grandfathering/
--    gain-type/taxable-gain, plus the matching exit-load figure. User-owned.
--    This is explicitly an OBSERVATIONAL/SIMULATION record, never a filed-
--    return-equivalent number (enforced structurally in the API/UI layer via
--    lib/engines/investment-intelligence/tax/disclaimer.ts).
-- ---------------------------------------------------------------------------
create table ii_capital_gains_computations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  disposal_transaction_id uuid not null references ii_transactions(id) on delete cascade,
  lot_id uuid not null references ii_tax_lots(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  classification text not null check (classification in ('equity_oriented', 'debt_specified', 'other_hybrid', 'unresolved')),
  gain_type text not null check (gain_type in ('stcg', 'ltcg', 'unresolved')),
  holding_days integer,
  rule_version text,
  rule_version_placeholder boolean not null default false,
  sale_value numeric(18, 2) not null,
  cost_basis_used numeric(18, 2) not null,
  taxable_gain numeric(18, 2),
  grandfathering_eligible boolean not null default false,
  grandfathering_basis_source text check (grandfathering_basis_source in ('not_applicable', 'actual_cost', 'fmv_grandfathered', 'fmv_unavailable')),
  exit_load_pct numeric(6, 3),
  exit_load_amount numeric(18, 2),
  engine_version text not null,
  computed_at timestamptz not null default now(),
  note text
);
create index idx_ii_capital_gains_computations_user on ii_capital_gains_computations(user_id);
create index idx_ii_capital_gains_computations_disposal on ii_capital_gains_computations(disposal_transaction_id);
create unique index uidx_ii_capital_gains_computations_disposal_lot
  on ii_capital_gains_computations(disposal_transaction_id, lot_id);

alter table ii_capital_gains_computations enable row level security;
create policy "own ii_capital_gains_computations" on ii_capital_gains_computations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 6. Seed ii_tax_rule_versions (R1-shaped, R6-P1-populated) with the real,
--    researched, effective-dated 1961 Act → 2025 Act rule set. Mirrors
--    lib/engines/investment-intelligence/tax/ruleVersions.ts exactly — see
--    that file for the sourced rationale behind every number. The
--    2025_act_placeholder row is explicitly flagged placeholder:true inside
--    its own rule_definition; it is never presented as authoritative.
-- ---------------------------------------------------------------------------
insert into ii_tax_rule_versions (rule_set_key, version, country_code, effective_from, effective_to, rule_definition)
values
  (
    'in_mutual_fund_capital_gains', '1961_act_pre_20240723', 'IN', '2023-04-01', '2024-07-22',
    '{
      "placeholder": false,
      "sourceNote": "Income-tax Act 1961 as amended by Finance Act 2023 (specified mutual fund short-term rule, effective FY2023-24) and pre-Budget-2024 Section 112A rates.",
      "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 15, "ltcgRatePct": 10, "ltcgExemptionThresholdInr": 100000, "indexationAllowed": false},
      "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true}
    }'::jsonb
  ),
  (
    'in_mutual_fund_capital_gains', '1961_act_post_20240723', 'IN', '2024-07-23', '2026-03-31',
    '{
      "placeholder": false,
      "sourceNote": "Finance (No. 2) Act, 2024, effective for transfers on/after 23 July 2024: equity STCG raised to 20%, LTCG raised to 12.5%, Section 112A exemption raised to Rs 1,25,000/FY. Debt/specified-fund short-term-always rule unchanged.",
      "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 20, "ltcgRatePct": 12.5, "ltcgExemptionThresholdInr": 125000, "indexationAllowed": false},
      "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true}
    }'::jsonb
  ),
  (
    'in_mutual_fund_capital_gains', '2025_act_placeholder', 'IN', '2026-04-01', null,
    '{
      "placeholder": true,
      "sourceNote": "PLACEHOLDER - the Income-tax Act, 2025 is in force from 1 April 2026 but its specific capital-gains rates/thresholds for mutual funds were not publicly finalised/verifiable at the time this engine was built. This row deliberately reuses the pre-transition rate structure as a placeholder. Replace once the 2025 Act rules are confirmed and re-run the certification pack.",
      "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 20, "ltcgRatePct": 12.5, "ltcgExemptionThresholdInr": 125000, "indexationAllowed": false},
      "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true}
    }'::jsonb
  )
on conflict (rule_set_key, version) do nothing;
