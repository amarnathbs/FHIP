# 0058 reconciliation — Investment Intelligence R6 schema manifest

Source: the entire displaced 5-migration chain, originally `0058`-`0062` on
`feature/investment-intelligence-r6-security-final`, now `0059`-`0063` in
the repository. SQL content is byte-identical to the originals in every file
except the renumbering header comments and a small number of internal prose
cross-references between the five files (updated for accuracy, not
functionally load-bearing — confirmed by the identical clean-rebuild/
certification numbers before and after). Module: **Investment Intelligence
R6 (India Tax & Cost Intelligence, R6-P1 + R6-FINAL + R6-DEBTFIX)**.

## File 1/5 — `0059_ii_r6_p1_tax_engine.sql` (originally `0058`, 228 lines)

### New tables

| Table | Ownership | RLS | Purpose |
| --- | --- | --- | --- |
| `ii_scheme_tax_classification` | Shared reference data (not user-owned), keyed by `instrument_id` | `for select using (true)` — world-readable, no authenticated write | Durable per-scheme classification (equity_oriented / debt_specified / other_hybrid / unresolved), computed from R2 Portfolio Truth holdings. |
| `ii_exit_load_schedules` | Shared reference data | `for select using (true)` | Scheme-level exit-load tier schedule (`tiers jsonb`, effective-dated). |
| `ii_tax_lot_consumptions` | User-owned (`user_id`) | `for all using (auth.uid() = user_id) with check (...)` at the time of THIS file — later narrowed to SELECT-only by `0062` (originally `0061`), see file 4/5 below | FIFO consumption ledger: which lot(s) a disposal consumed and how many units from each. |
| `ii_capital_gains_computations` | User-owned (`user_id`) | Same "for all" at this file's time, later narrowed by `0062` | Persisted per-lot-consumption tax result (classification/rule-version/holding-period/grandfathering/gain-type/taxable-gain + matching exit load). Explicitly observational/simulation, never filed-return-equivalent. |

### Columns added to an existing table

`ii_transactions.transaction_type` check constraint widened (additive only,
every R1+R2 value kept verbatim) to admit two new values: `'bonus'`,
`'split'` — needed so a tax lot can open with the correct later acquisition
date for bonus-unit allotments and scheme-level unit splits, rather than
inheriting the original investment's date.

### Constraints / indexes

- `ii_scheme_tax_classification`: `unique(instrument_id)`
- `ii_exit_load_schedules`: `unique(instrument_id, effective_from)`
- `ii_tax_lot_consumptions`: `idx_ii_tax_lot_consumptions_user/disposal/lot`, `uidx_ii_tax_lot_consumptions_disposal_lot` (unique — re-running the engine upserts, doesn't duplicate)
- `ii_capital_gains_computations`: `idx_ii_capital_gains_computations_user/disposal`, `uidx_ii_capital_gains_computations_disposal_lot` (unique, same upsert rationale)

### Seed data

`ii_tax_rule_versions` (R1-shaped in `0031`/`0033`, unpopulated until now)
seeded with 3 effective-dated rows for `in_mutual_fund_capital_gains` (IN):
`1961_act_pre_20240723`, `1961_act_post_20240723`, `2025_act_post_20260401`
— all `placeholder: false`, `on conflict ... do nothing` (idempotent).

### Dependencies

`ii_instruments`, `ii_transactions`, `ii_tax_lots` (all R1/R2), `ii_sources`.

## File 2/5 — `0060_ii_r6_final_reference_seed.sql` (originally `0059`, 169 lines)

Pure DML, no DDL. Idempotent (`on conflict ... do nothing` throughout,
`not exists` guards). Inserts:
- 1 new real instrument: ICICI Prudential Corporate Bond Fund - Growth
  (Direct Plan), a real SEBI-recognised scheme (ISIN `INF109KA1Z62`) — DEV's
  instrument set had zero debt/specified funds and R6-FINAL's spec required
  a debt-fund reference example.
- `ii_fund_holdings` rows (illustrative top-holding weights, disclosed as
  such) for the three pre-existing real equity funds, plus underlying
  equity `ii_instruments` rows created inline where missing.
- `ii_scheme_tax_classification` rows for those three equity funds
  (equity_oriented, 97-99.5% domestic equity) and the new debt fund
  (debt_specified, category-based).
- One deliberately `unresolved` classification row for "NPS Tier I -
  Equity (E)" — a different tax regime entirely, disclosed as intentionally
  not guessed.
- `ii_exit_load_schedules` rows for the three equity funds, including one
  historical+current pair so the effective-dating path has real data.

## File 3/5 — `0061_ii_r6_final_tax_profile.sql` (originally `0060`, 48 lines)

### New table

| Table | Ownership | RLS | Purpose |
| --- | --- | --- | --- |
| `ii_tax_profiles` | User-owned, `user_id` is the PK (one profile per user, not per household/account) | `for all using (auth.uid() = user_id) with check (...)` | Persisted explicit tax-profile input (taxpayer type, residency status, informational tax year). No default row ever seeded — absence IS the "no profile declared" state. |

No seed data. No columns added to any other table.

## File 4/5 — `0062_ii_r6_final_rls_forgery_fix.sql` (originally `0061`, 94 lines)

Pure RLS correction, no new table/column. Fixes a **confirmed, live-
reproduced** same-user forgery vulnerability (a user could PATCH/DELETE
their own `ii_capital_gains_computations`/`ii_tax_lot_consumptions` rows
directly via PostgREST, overwriting a server-computed "estimated tax
liability" to an arbitrary value — reproduced live in DEV, evidence in
`docs/investment-intelligence/R6_FINAL_SECURITY_VERIFICATION.md`, restored
immediately after reproduction, no bad data left in DEV):

- `drop policy "own ii_capital_gains_computations"` → `create policy "read own ii_capital_gains_computations" for select using (auth.uid() = user_id)` (no insert/update/delete grant to `authenticated` — all writes are service-role-only via `taxRepository.ts`)
- Same pattern for `ii_tax_lot_consumptions`
- Same pattern for `ii_tax_lots` (pre-existing since R1's `0033`, disclosed as a related broader finding fixed under the same dispatch — this table only became practically exploitable once R6-FINAL started actually populating it with real financial state)

## File 5/5 — `0063_ii_r6_debt_fund_fix_reference_seed.sql` (originally `0062`, 60 lines)

Pure DML (3 `UPDATE`s against `ii_tax_rule_versions.rule_definition`, no
DDL, idempotent full-value overwrites). Fixes the reference-data mirror to
match a corrected engine: adds a `debtSpecified.legacyRegime` field to all
3 rule-version rows, describing the pre-2023 debt-fund treatment
(pre-23-Jul-2024: 36-month/20%-indexed; post-23-Jul-2024: 24-month/12.5%-
unindexed) for lots acquired before the 2023-04-01 "specified mutual fund"
cutoff. `ii_tax_rule_versions.rule_definition` is documentation/reference
only — the engine computes from `ruleVersions.ts` in-memory constants
directly — but this keeps the DB mirror honest per the module's own stated
"diffable against one canonical source" design goal.

## Classification (per spec section A), all 5 files combined

| Object | Class |
| --- | --- |
| `ii_scheme_tax_classification`, `ii_exit_load_schedules`, `ii_tax_lot_consumptions`, `ii_capital_gains_computations`, `ii_tax_profiles` | `II_ONLY` |
| `ii_transactions.transaction_type` check-constraint widening (+`bonus`,+`split`) | `II_ONLY` |
| `ii_tax_lots` RLS policy correction (0062) | `II_ONLY` (table itself is R1, but this file's change is II-scoped) |
| `ii_tax_rule_versions` seed/update rows (0059, 0063) | `II_ONLY` |
| `ii_instruments`, `ii_fund_holdings` seed rows (0060) | `II_ONLY` |

**Zero objects across all 5 files are `FDH_ONLY`, `SHARED`, or
`CONFLICTING`** with FDH-3's `0058` — no `fdh_*` table, column, function,
trigger, or storage policy is referenced or touched anywhere in this chain.
See `0058_FDH3_MANIFEST.md`'s matching table and
`0058_CANONICAL_LINEAGE_DECISION.md` for the cross-check.
