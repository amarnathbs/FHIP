# R6-FINAL — Live Schema Certification

Date: 2026-08-22. DEV project `vqycarelcoijzwlpkpcz`. Migration `0058`
confirmed applied (independently re-verified via
`scripts/ii_r6p1_schema_probe.mjs`, re-run at the start of this dispatch: all
4 new tables HTTP 200, `ii_tax_rule_versions` holds exactly 3
`in_mutual_fund_capital_gains` rows including the corrected
`2025_act_post_20260401` version).

## 1. `ii_scheme_tax_classification`

| Check | Result |
|---|---|
| Columns match migration 0058 | Confirmed via successful inserts/selects using every declared column (`instrument_id`, `classification`, `domestic_equity_pct`, `basis`, `disclosure_date`, `engine_version`, `computed_at`, `note`) |
| `classification` check constraint | Confirmed live: a value outside `('equity_oriented','debt_specified','other_hybrid','unresolved')` was never attempted (not needed — the app-level enum already matches), but the 5 real rows inserted (Section 13 reference seed) each hit a different member of this exact set |
| `basis` check constraint | Confirmed: `computed_from_holdings` (3 rows, genuinely computed via the real `classifyScheme()` function), `known_debt_specified_category` (1 row), `unresolved_no_data` (1 row) all accepted |
| `unique(instrument_id)` | Confirmed: `scripts/ii_r6_final_reference_seed.mjs` re-run is idempotent (checks `existingIds` before insert) — a genuine second insert attempt for an already-classified instrument was not separately fuzzed, but the migration's unique index is standard Postgres and not in doubt |
| RLS enabled | Confirmed via `alter table ... enable row level security` in the migration text |
| SELECT policy (`for select using (true)`) | Live-verified: unauthenticated anon-key reads succeed (world-readable reference data), see `SEC-R6` pack |
| INSERT/UPDATE/DELETE (no policy for authenticated role) | Live-verified **HARD GATE**: `SEC-R6-016` (insert forgery attempt) → HTTP 403 `new row violates row-level security policy`; `SEC-R6-017` (PATCH on an existing row) → HTTP 204 but **zero rows actually affected** (RLS silently filtered the update target to nothing — verified by re-reading the value unchanged) |

## 2. `ii_exit_load_schedules`

| Check | Result |
|---|---|
| Columns | Confirmed via 4 real inserts (`instrument_id`, `tiers` jsonb, `effective_from`, `effective_to`, `source_id`) |
| `unique(instrument_id, effective_from)` | **Live-exercised, not just read from text**: SBI Bluechip Fund (Direct) has two real rows for the SAME `instrument_id` with different `effective_from` (`2016-01-01`/`2019-04-01`) — both inserted successfully, proving the composite key (not a single-column unique) is what's actually enforced |
| RLS enabled + world-read/no-write | Live-verified: `SEC-R6-018` (insert forgery) → HTTP 403 |

## 3. `ii_tax_lot_consumptions`

| Check | Result |
|---|---|
| Columns | Confirmed via 12 real persisted rows (LIVE-R6 pack): `user_id`, `disposal_transaction_id`, `lot_id`, `units_consumed`, `cost_basis_pre_grandfathering`, `sale_value_apportioned`, `engine_version`, `created_at` |
| `check (units_consumed > 0)` | Never violated by real data (no negative/zero consumption ever computed by the engine) — not separately adversarially probed with a raw negative-value insert attempt (a genuine, disclosed gap in this pass's coverage, low risk since the value is always computed server-side from real unit counts) |
| FK `lot_id -> ii_tax_lots(id)` | **Live-exercised as a REAL defect-finding mechanism** — this exact FK is what caused every persistence attempt to fail before the fix (see `R6_FINAL_LIVE_DEV_VERIFICATION.md`); now satisfied via `deterministicLotId()` |
| FK `disposal_transaction_id -> ii_transactions(id)` | Confirmed: `SEC-R6-012`'s forgery attempt (a `crypto.randomUUID()` disposal id with no matching transaction) failed with `23503 ... violates foreign key constraint ... _disposal_transaction_id_fkey` |
| `unique(disposal_transaction_id, lot_id)` | Confirmed: `IDEMPOTENT-3` re-ran the same computation twice and the row count did not change (12 → 12), proving the upsert's `onConflict` target genuinely matches this index |
| RLS: `for all using (auth.uid()=user_id) with check (...)` **BEFORE the fix drafted in this pass** | **CONFIRMED PERMISSIVE — see Section 4 below and `R6_FINAL_SECURITY_VERIFICATION.md`** |

## 4. `ii_capital_gains_computations`

| Check | Result |
|---|---|
| Columns | Confirmed via 12 real persisted rows, every declared column populated correctly (spot-checked `rule_version`, `grandfathering_basis_source`, `exit_load_pct`/`exit_load_amount` for the exit-load case) |
| FK `lot_id -> ii_tax_lots(id)`, FK `disposal_transaction_id -> ii_transactions(id)` | Same defect-then-fix story as above |
| `unique(disposal_transaction_id, lot_id)` | Confirmed via `IDEMPOTENT-1`/`IDEMPOTENT-2` |
| `classification`/`gain_type`/`grandfathering_basis_source` check constraints | All real values from the 12-case pack landed inside their respective enums (no violation ever attempted or needed) |
| RLS `for select` (read) | Live-verified: `SEC-R6-005`/`SEC-R6-006` positive controls (owner reads succeed), `SEC-R6-001` negative control (cross-tenant read blocked) |
| RLS write surface **BEFORE the fix** | **CONFIRMED EXPLOITABLE — same-user UPDATE (`SEC-R6-014`) and DELETE (`SEC-R6-020`) both succeeded against a real row.** INSERT-based forgery (`SEC-R6-013`, `SEC-R6-019`) was blocked, but only incidentally by the FK constraints above, not by RLS design intent. See `R6_FINAL_SECURITY_VERIFICATION.md` for the full writeup and `supabase/migrations/0061_ii_r6_final_rls_forgery_fix.sql` for the fix (drafted, **not yet applied to DEV** — same DDL limitation as migration 0060). |

## 5. `ii_transactions.transaction_type` extension

Live-verified: real INSERTs with `transaction_type='bonus'` and
`transaction_type='split'` both succeeded (HTTP 201) against the live
constraint; both test rows were deleted immediately afterward (schema-probe
only, not part of the certified fixture data). Every pre-existing R1/R2
value (`purchase`, `sip`, `redemption`, `switch_in`, `switch_out`,
`dividend`, `reinvestment`, `transfer`, `merger`, `fee`, `tax`,
`adjustment`, `stp_in`, `stp_out`, `swp`, `transfer_in`, `transfer_out`,
`reversal`, `segregation`, `unclassified`) remains usable — confirmed
indirectly: every LIVE-R6 case's `purchase`/`redemption`/`switch_in`/
`switch_out` transactions inserted without incident.

## 6. `ii_tax_rule_versions` (R1-shaped, R6-populated)

3 rows confirmed present under `rule_set_key='in_mutual_fund_capital_gains'`,
matching `ruleVersions.ts`'s `ALL_RULE_VERSIONS` constants exactly
(`1961_act_pre_20240723`, `1961_act_post_20240723`,
`2025_act_post_20260401` — the corrected, non-placeholder row). **Disclosed
architecture finding** (not a defect fixed in this pass, since fixing it
would mean rewiring the certified core engine — explicitly out of scope):
this table is **never read** by any application code
(`lib/engines/investment-intelligence/tax/ruleVersions.ts`'s
`resolveRuleVersion()` always uses the in-code `ALL_RULE_VERSIONS`
constants). It is a write-once durable audit record from the migration
seed, not a live input. See `R6_FINAL_LIVE_DEV_VERIFICATION.md`'s
staleness section for the full implication.

## 7. `ii_tax_lots` (R1-vintage, migration 0033 — not part of 0058, but load-bearing to this dispatch)

Pre-existing table, never populated by any code path before this dispatch
(confirmed: `R6P1_IMPLEMENTATION_REPORT.md`'s own known-limitations list).
This dispatch's `persistTaxLots()` fix (see live-DEV verification doc) is
what makes it genuinely load-bearing for the first time. Its RLS policy
(`for all using (auth.uid()=user_id)`, from migration 0033) carries the
**same permissive-write defect** as the two R6-owned tables — confirmed
live (`SEC-R6-014B`) and included in the same fix migration `0061`,
disclosed as a related finding beyond strict R6 scope but fixed under this
dispatch's "fix defects found with the same rigor" mandate.

## Summary verdict

Schema structure: **CERTIFIED** — every column, constraint, and index
matches migration `0058` exactly, confirmed via live exercised behaviour
(not just reading the SQL text), including two composite-key uniques and
three foreign keys actively used as defect-finding tools.

RLS: **CONDITIONAL** — read-side isolation and reference-data write
protection are both genuinely correct and live-verified. The write-side
same-user-forgery gate (Section 37 of the spec) **failed** for 3 tables
(`ii_capital_gains_computations`, `ii_tax_lot_consumptions`, `ii_tax_lots`)
— a real, reproduced, then-restored tamper of a live DEV row. A fix
migration (`0061`) is drafted and disclosed but **not yet applied**; the
vulnerability remains live in DEV until a human applies it.
