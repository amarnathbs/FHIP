# II-PC1-F2 — Current-Result Selection Decision (R6 persisted tax computations)

**Status:** DECIDED
**Date:** 2026-09-03
**Base:** `origin/main` @ `0e21039` (includes the II-PC1-F1 merge `0c11a5c`)
**Scope:** which persisted R6 tax-derived rows a consumer may treat as the CURRENT result.
**Related:** `II_PC1_F1_FIFO_SCOPE_DECISION.md` (the v2 → v3 bump this decision exists because of).

---

## 1. Persisted calculation model

R6 persists three derived tables. None of them is a source of truth: every
user-facing tax surface recomputes from canonical `ii_transactions` on each
request (see §3).

| Table | Derived or canonical | Engine version stored? | Fingerprint stored? | Timestamp / version key | Historical rows retained? |
|---|---|---|---|---|---|
| `ii_tax_lots` | derived | **No column** | No | `created_at`, `closed_at` | No — PK is `deterministicLotId('lot:'+acquisition_txn_id)`, upserted `onConflict: id`, so a recomputation rewrites the same row in place |
| `ii_tax_lot_consumptions` | derived | `engine_version` (not null) | No | `created_at` | **Yes** — unique key is `(disposal_transaction_id, lot_id)` |
| `ii_capital_gains_computations` | derived | `engine_version` (not null) | No | `computed_at` | **Yes** — unique key is `(disposal_transaction_id, lot_id)` |

`ii_scheme_tax_classification`, `ii_exit_load_schedules` and
`ii_tax_rule_versions` are reference data, not per-user computations, and are
outside this decision.

### 1.1 Why historical rows accumulate

The two consumption/gains tables upsert on `(disposal_transaction_id, lot_id)`.
That key assumes the set of lots a disposal consumes never changes. II-PC1-F1
changed exactly that: FIFO candidacy moved from `(instrument)` to
`(account, instrument)`, so for a user holding one scheme in two folios a
disposal now consumes a **different lot**. The v3 write therefore lands on a
**new** key, and the v2 row for the old lot is neither updated nor deleted.

Nothing in product code ever deletes from these tables. The orphan is permanent.

### 1.2 `computed_at` does not mean what it appears to mean

Verified against live DEV (`_f2_tmp/f2_probe3.mjs`, 2026-09-03): the write path
omits `computed_at` from its upsert payload, and a column `DEFAULT now()` does
**not** re-fire on the UPDATE half of an upsert. A row that has been recomputed
many times still reports its **original insert** timestamp.

> BEFORE computed_at = 2026-08-22T02:55:13.142783+00:00 taxable_gain = 5000
> AFTER  computed_at = 2026-08-22T02:55:13.142783+00:00 taxable_gain = 5001

So, before this dispatch, the schema had **no working freshness marker at all**:
`engine_version` distinguished engine generations but nothing distinguished
"produced by the latest run" from "left behind by an earlier one".

---

## 2. Historical-record retention model

Retention is **implicit, not designed**. There is no `status`, `superseded_by`,
`is_current`, `input_fingerprint` or `calculation_run_id` column on any of the
three tables, and no migration has ever added one.

Migration `0059`'s own header describes `ii_capital_gains_computations` as
"explicitly an OBSERVATIONAL/SIMULATION record, never a filed-return-equivalent
number". `taxRepository.ts` treats a persistence failure as non-fatal and warns
that "the figures shown were recomputed from certified inputs". Combined with
§3 below, the persisted rows function as a **derived ledger/cache**, not as an
audit register that any regulatory obligation depends on.

That said, this decision does **not** destroy them (dispatch §15): they are
retained and simply excluded from current-result selection.

---

## 3. Existing version-selection convention

There is no existing convention to inherit, because until now there was almost
nothing to select. The consumer inventory (see the F2 report) shows:

* `ii_tax_lot_consumptions` — **zero readers** anywhere in product code.
* `ii_tax_lots` — read only by `investmentPublicationService.loadPositionContext`
  for open-lot cost basis, filtered `(user_id, account_id, instrument_id, status != 'closed')`.
  Self-healing: the deterministic-id upsert rewrites every lot on every run, so
  no stale generation can survive.
* `ii_capital_gains_computations` — **exactly one reader**,
  `reviewCentreData.runReviewCentreRefresh`, which selected **every** row for
  the user with no version, recency or status predicate whatsoever.
* Every user-facing tax surface — `/api/investment-intelligence/tax/summary`,
  `/tax/lots`, `/tax/redemption-simulation`, the Tax Intelligence UI, and the
  R10 `tax_and_cost` report chapter via `loadTaxForReport` — **recomputes live**
  through `loadTaxDataset` + `runTaxSimulation`. They never read a prior
  computation, so they are structurally immune to this class of staleness.

The nearest sibling precedent is R4/R5 analytics, which stamp an
`engine_version` on `ii_analytics_results`; Review Centre's
`detectBenchmarkUnderperformance` likewise passes that version through into
evidence **without filtering on it**. So the precedent is "stamp the version,
carry it in evidence" — not "select on it". That precedent is what left the gap.

---

## 4. Two independent staleness axes (dispatch §8)

Live-DEV testing proved **both** axes are reachable, which rules out the
simplest candidate rule.

**Axis A — engine generation.** A v2 row survives a v3 recomputation and is
surfaced. Proven: `F2-T06`. The orphan carried `gain_type='ltcg'`,
`taxable_gain=30000`, `exit_load_pct=1` while the correct v3 answer for the same
disposal was `stcg` totalling `22000`; Review Centre emitted a real, open,
user-visible `exit_load_exposure` item sourced from it.

**Axis B — data freshness at the same engine version.** A legitimate new
backdated acquisition re-matches FIFO under the **same** v3 engine, orphaning a
v3 row, which is likewise surfaced. Proven: `F2-T04`.

Therefore `engine_version = 'v3'` (or even `= TAX_ENGINE_VERSION`) is **not**
sufficient on its own. Adopting it alone would have satisfied the literal F2
question while leaving an identical defect one transaction away — exactly the
outcome dispatch §8 warns against.

---

## 5. DECISION — the current-result rule

> **`LATEST_VALID_COMPUTATION_FOR_CURRENT_ENGINE`**
>
> A persisted R6 capital-gains computation is CURRENT for a given
> `disposal_transaction_id` if and only if:
>
> 1. its `engine_version` equals the engine version the **currently deployed
>    code** would produce — i.e. the `TAX_ENGINE_VERSION` constant, referenced
>    symbolically, never a literal; **and**
> 2. its `computed_at` is the maximum `computed_at` among the rows satisfying
>    (1) for that same `disposal_transaction_id`.
>
> Rows failing either test are HISTORICAL. They are retained, never deleted,
> and never presented as current.

### Why each clause is there

**Clause 1 (engine version).** Handles Axis A, and handles the "no current
computation exists" case correctly: if a user has only v2 rows, clause 1
matches nothing and the consumer is told there is no current computation
(dispatch §28 F2-T13) rather than falling back on an arbitrary historical row.
Because it is expressed as `TAX_ENGINE_VERSION` and not `'tax-engine-r6-p1-v3'`,
a future v4 bump re-scopes every consumer automatically with no consumer edit —
dispatch §20 satisfied.

**Clause 2 (latest run).** Handles Axis B. It requires the write path to make
`computed_at` honest (see §6), which is a code change only — the column already
exists.

**Scoped per disposal, not per user.** The disposal is the calculation context
dispatch §16 names ("the same relevant calculation context"). Post-fix the two
scopings coincide, because a run always recomputes every disposal for the user;
per-disposal simply degrades more gracefully on pre-fix rows.

### Determinism (dispatch §22)

`computed_at` is stamped **once per run** in JavaScript and applied to every row
of that run, so all rows of a run share one exact timestamp and MAX is a total
order over runs, not over rows. Two concurrent runs produce identical values
(recomputation is idempotent — proven by `F2-T03`), so whichever run's timestamp
wins yields an equivalent answer. Selection never depends on undefined DB row
order.

---

## 6. What this requires in code (no migration)

1. **Write path** — `persistCapitalGainsComputations` and
   `persistTaxLotConsumptions` stamp an explicit, single per-run `computed_at`
   / `created_at`, so the timestamp finally means "produced by the run at T".
   The columns already exist; no DDL.
2. **Read path** — one shared selector in `taxRepository.ts`
   (`loadCurrentCapitalGainsComputations`) implementing the rule above, so
   consumer selection lives at the canonical R6 data-access layer rather than
   being re-derived by each consumer (dispatch §19).
3. **Consumer** — `reviewCentreData.ts` calls that selector instead of running
   its own unfiltered `.from('ii_capital_gains_computations').select(...)`.

**No migration is proposed and none is required** (dispatch §33).

---

## 7. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| `.eq('engine_version', 'v3')` inline in Review Centre | Literal version; guarantees the identical defect at v4 (§20). Also fails Axis B, proven by `F2-T04`. |
| `engine_version = TAX_ENGINE_VERSION` alone | Version-agnostic and fixes Axis A, but `F2-T04` proves Axis B remains live. |
| Latest `computed_at` alone, no version clause | On a user with only v2 history, MAX picks the v2 run and surfaces it — the exact defect, inverted. |
| Delete superseded rows at write time | Destructive of calculation provenance; dispatch §15 explicitly prefers selection over history removal. Also non-atomic over PostgREST. |
| Add `status`/`superseded_by`/`input_fingerprint` columns | Requires a migration; dispatch §33 says attempt without one first, and query-time selection is sufficient. Recorded below as a possible future hardening for the Product Owner, not adopted here. |

---

## 8. Disclosed residual (honest, non-blocking)

For rows written **before** this change, `computed_at` is insert-time rather
than last-run time. A user whose rows span several pre-fix runs may, until
their next tax recomputation, have clause 2 exclude a row that is genuinely
current. The failure direction is **fail-safe** — the consumer under-reports an
advisory Review Centre observation; it can never show a wrong tax figure,
because Review Centre consumes only `exit_load_pct` and the
`classification`/`gain_type == 'unresolved'` flags, and every figure-bearing
surface recomputes live. It self-heals on the affected user's very next tax
page load or report generation, which rewrites every row with an honest
timestamp.

If the Product Owner wants that window closed deterministically rather than
lazily, the options are (a) a one-off backfill setting `computed_at` on existing
rows, or (b) a migration adding an explicit `calculation_run_id` / `status`
column. Both are **out of scope for F2** and neither is authorised here.
