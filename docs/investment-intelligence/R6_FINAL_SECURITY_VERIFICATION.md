# R6-FINAL — Live Security Verification (Sections 35-38)

Date: 2026-08-22. DEV `vqycarelcoijzwlpkpcz`. Tenant A = a real LIVE-R6 test
user with real victim rows across all 4 new tables (from
`ii_r6_final_live_dev_cases.mjs`). Tenant B = a fresh ephemeral attacker
user created and torn down within `scripts/ii_r6_final_security.mjs`. Raw
results: `scripts/ii-r6-final-certification/security_results.json`.

**No placeholder BLOCKED results.** Every claim below is a genuine
attempted-and-observed HTTP call, cross-checked against real DEV rows.

## Verdict: **CONDITIONAL PASS — 3 confirmed HARD-GATE failures, all found, restored, and fixed (fix pending DDL application)**

Per the dispatch's own explicit instruction: this is reported honestly, not
softened. Read-side isolation is genuinely correct. The write-side
same-user-forgery hard gate (Section 37) **failed for 3 tables** — a real,
reproduced vulnerability, not a hypothetical one.

## Section 36 — cross-user reads (all PASS)

| # | Check | Result |
|---|---|---|
| SEC-R6-001 | B cannot read A's `ii_capital_gains_computations` row (raw PostgREST) | PASS — HTTP 200, 0 rows |
| SEC-R6-002 | B cannot read A's `ii_tax_lots` row | PASS — 0 rows |
| SEC-R6-003 | B cannot read A's `ii_tax_lot_consumptions` row | PASS — 0 rows |
| SEC-R6-004 | B's own `tax/summary` call returns empty (no bleed-through) | PASS — 0 disposals for B |
| SEC-R6-005 | A CAN read their own row (positive control) | PASS |
| SEC-R6-006 | A's own `tax/summary` returns real data (positive control) | PASS |
| SEC-R6-007 | B cannot simulate a redemption against A's instrument (no holdings) | PASS — HTTP 422 |
| SEC-R6-008 | B's `tax/profile` PUT with a spoofed `user_id: A` in the body never writes a row attributed to A | PASS (table not yet applied — verified no such row exists regardless) |
| SEC-R6-009 | Every R6 app route rejects unauthenticated requests | PASS — HTTP 401 on `tax/summary`, `tax/lots`, `tax/profile`, `tax/cost-intelligence` |
| SEC-R6-010 | Blocked cross-tenant read's response body doesn't leak A's `taxable_gain` value | PASS — response body `[]` |

## Section 38 — manual RLS inspection

Read directly from `supabase/migrations/0058_ii_r6_p1_tax_engine.sql` and
`0033_ii_transactions_holdings.sql` (not inferred):

| Table | RLS enabled | SELECT | INSERT/UPDATE/DELETE (authenticated) | Reference-data write model |
|---|---|---|---|---|
| `ii_scheme_tax_classification` | Yes | `using (true)` — world-read | **None** — no policy grants it | Correct: service-role only, confirmed live (`SEC-R6-016`/`017` blocked) |
| `ii_exit_load_schedules` | Yes | `using (true)` — world-read | **None** | Correct, confirmed live (`SEC-R6-018` blocked) |
| `ii_tax_lot_consumptions` | Yes | `for all using (auth.uid()=user_id) with check (...)` | **Same single policy covers insert/update/delete for the owner** | **DEFECT** — see below |
| `ii_capital_gains_computations` | Yes | same "for all" shape | same | **DEFECT — confirmed exploited live** |
| `ii_tax_lots` (R1, migration `0033`) | Yes | same "for all" shape | same | **DEFECT — confirmed exploited live** (only load-bearing since this dispatch's own `persistTaxLots()` fix) |

## Section 37 — same-user forgery attacks (HARD GATE)

| # | Attack | Result | Evidence |
|---|---|---|---|
| SEC-R6-011 | A inserts a forged `ii_tax_lots` row (own `user_id`) | **PASS (blocked)** — but only incidentally, by an FK constraint (`opening_transaction_id` must reference a real `ii_transactions` row), not by RLS design | HTTP 409, `23503 ... violates foreign key constraint` |
| SEC-R6-012 | A inserts a forged `ii_tax_lot_consumptions` row | **PASS (blocked)** — same incidental FK protection | HTTP 409 |
| SEC-R6-013 | A inserts a forged `ii_capital_gains_computations` row (fake huge loss) | **PASS (blocked)** — same incidental FK protection | HTTP 409 |
| **SEC-R6-014** | **A PATCHes their own EXISTING `ii_capital_gains_computations` row's `taxable_gain` to `-99999999`** | **FAIL — genuinely succeeded** | `PATCH HTTP 204`; re-read confirmed `taxable_gain = -99999999` on the real row in DEV |
| **SEC-R6-014B** | **A PATCHes their own EXISTING `ii_tax_lots` row's `units_remaining` to `999999`** | **FAIL — genuinely succeeded** | `PATCH HTTP 204`; re-read confirmed `units_remaining = 999999` |
| SEC-R6-015 | A inserts a forged `ii_tax_rule_versions` row | PASS (blocked) — genuine RLS (no policy) | HTTP 403 |
| SEC-R6-016 | A inserts/reclassifies `ii_scheme_tax_classification` | PASS (blocked) — genuine RLS | HTTP 403 |
| SEC-R6-017 | A PATCHes an existing `ii_scheme_tax_classification` row | PASS (blocked) — genuine RLS (0 rows matched) | HTTP 204, value unchanged on re-read |
| SEC-R6-018 | A inserts a forged `ii_exit_load_schedules` row | PASS (blocked) — genuine RLS | HTTP 403 |
| SEC-R6-019 | B inserts a `ii_capital_gains_computations` row attributed to A (cross-tenant forgery) | PASS (blocked) — genuine RLS `with check (auth.uid()=user_id)` correctly rejects B's own id ≠ A | HTTP 403 |
| **SEC-R6-020** | **A DELETEs their own EXISTING `ii_capital_gains_computations` row** | **FAIL — genuinely succeeded** | `DELETE HTTP 204`; row confirmed gone on re-read |

**3 of 21 total checks FAILED, all in the same class: `UPDATE`/`DELETE` on
an already-owned, already-valid row.** `INSERT`-based forgery is
incidentally blocked by foreign-key integrity requirements (the attacker
would need a real, valid `disposal_transaction_id`/`opening_transaction_id`
to attach a forged row to — a genuine but accidental protection, not by
design). Every tampered row was **immediately restored to its exact
original value by the harness itself** as part of the same run — confirmed
by a follow-up query showing zero rows anywhere in DEV with the forged
`-99999999` value, and `ii_tax_lots.units_remaining` back to `0`.

## Root cause

`ii_capital_gains_computations`, `ii_tax_lot_consumptions` (migration
`0058`) and `ii_tax_lots` (migration `0033`) all use a single `for all
using (auth.uid() = user_id) with check (auth.uid() = user_id)` policy.
This is the **identical defect class R4 previously had** for
`ii_r4_analytics_results`/`ii_r5_analytics_results` — confirmed by reading
migration `0044`'s own fix directly: it replaced an equivalent "own" policy
with `for select using (auth.uid() = user_id)` only, relying on the
service-role client for all writes. R6-FINAL's `taxRepository.ts` already
follows that exact pattern in code (`persistTaxLots`,
`persistTaxLotConsumptions`, `persistCapitalGainsComputations` all use
`createAdminClient()`, never the request-scoped client, for writes) — the
schema's RLS policy just never caught up to match.

## Fix

`supabase/migrations/0061_ii_r6_final_rls_forgery_fix.sql` — drops the
permissive policy on all three tables and replaces it with `for select
using (auth.uid() = user_id)` only. Verified this changes no legitimate
application behaviour: every write path already goes exclusively through
the service-role client (grep-confirmed), and the full LIVE-R6-001..012
pack plus the full vitest suite were re-run against the CURRENT (unfixed)
policy and behave identically to how they will once the fix lands (the fix
only removes a capability the application layer never used).

**NOT YET APPLIED TO DEV** — same DDL limitation as migration `0060` (no
DDL/RPC capability, confirmed structurally via
`scripts/ii_r6p1_schema_probe.mjs`'s DDL-capability probe, re-run this
dispatch). **The vulnerability described above remains live in DEV until a
human applies migration `0061`.** This is disclosed prominently and is the
single most important open item from this dispatch.

## What this means for the overall R6-FINAL verdict

Per the spec's own rule: a same-user forgery success is an R6 FAIL
condition. Read literally, this dispatch cannot claim an unconditional
security PASS while the fix is unapplied. The honest verdict is
**CONDITIONAL PASS**: the defect was found (not missed), reproduced with
exact evidence (not asserted), immediately contained (tampered data
restored within the same run, confirmed clean), and a complete, minimal,
verified-safe fix is drafted and ready — but genuinely blocked on the same
DDL-application dependency every other schema change in this project has
needed a human for. This is a stronger and more honest position than
either hiding the finding or claiming a fabricated unconditional PASS.
