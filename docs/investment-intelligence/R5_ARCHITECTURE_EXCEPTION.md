# R5 — Architecture Exceptions

**NONE.**

R5 introduced no deviation from the governing R0 contracts
(`R0_CANONICAL_DATA_CONTRACT.md`, `R0_CANONICAL_IDENTIFIER_STRATEGY.md`,
`R0_SOURCE_PROVENANCE_CONTRACT.md`, `R0_INSIGHT_CLASSIFICATION.md`,
`R0_SECURITY_RLS_ARCHITECTURE.md`, `R0_CROSS_BORDER_CONTRACT.md`,
`R0_NET_WORTH_DEDUP_CONTRACT.md`), the R1 schema conventions, or the R2/R3/R4
certified behaviour.

Specifically:

* **Reference data** (`ii_fund_holdings_snapshots`, `ii_fund_holdings_lines`,
  `ii_security_classifications`, `ii_security_aliases`) follows the existing
  world-readable / service-role-write-only pattern established by
  `ii_benchmarks` / `ii_prices_nav` in R1 and `ii_risk_free_rates` in R4.
* **Derived analytics** (`ii_r5_analytics_results`, `ii_sip_series`) follows the
  owner-select-only / no-authenticated-write pattern established by R4's
  migration 0043 section 5.
* **Cross-border** handling is unchanged: values stay in the investment's own
  local currency and are never pre-converted. Look-through weights are
  currency-independent proportions.
* **Insight classification** is confined to `OBSERVATION` / `EDUCATION` /
  `SIMULATION`. `PERSONALISED_ADVICE` has no code path in R5.
* **XIRR** reuses the certified R4 engine rather than introducing a second
  implementation.

## Two deliberate design decisions worth recording

Neither is an exception to a contract; both are choices made inside the
contracts' latitude, recorded here so they are visible rather than buried.

### 1. A separate `ii_r5_analytics_results` table

R5 persists to its own table rather than widening R4's `ii_analytics_results`.

Rationale: R4's table is certified and in production use; its unique constraint
and `scope_type` check are tuned to R4's metric set; and R5 needs
holdings-snapshot and classification lineage columns
(`holdings_snapshot_ids`, `holdings_source_versions`, `classification_version`,
`portfolio_as_of_date`, `holdings_as_of_date`, `coverage`) that would be
permanently NULL for every R4 row. Additive rather than disruptive.

### 2. FIFO as the only accepted disposal convention

R5 attributes SIP units under FIFO across the whole (account, instrument)
position, and refuses to produce a SIP-specific figure when FIFO cannot be
applied soundly.

Rationale: FIFO is already the canonical structure R1/R2 model via
`ii_tax_lots.acquisition_date`, and under it "how many surviving units came
from SIP instalments?" has exactly one answer — so no arbitrary allocation
methodology is introduced. Tax-lot optimisation is explicitly R6 scope and is
not implemented.

## Migration-numbering caveat (disclosed, not resolved)

The repository has an active, unresolved migration-numbering fork: the
Investment Intelligence and Resources CMS lineages have independently used
overlapping numbers (two different `0035` files exist on different branches).

This is a known, open Product Owner decision. **R5 did not attempt to resolve
it.** R5 selected `0044` as the next number genuinely free within the
Investment Intelligence lineage specifically, verified by inspecting that
branch's own `supabase/migrations/` directory (R4 added `0043`). It avoided
`0100+` (Resources) and `0200+` (Financial Data Hub). The caveat is documented
in full in the migration file's own header.
