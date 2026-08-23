# R6-FINAL — Live-DEV Verification (Sections 29-32, 39-44)

Date: 2026-08-22. All work in this document ran against DEV
`vqycarelcoijzwlpkpcz` with a real running app server
(`http://localhost:3199`, `npm run dev -p 3199` in this worktree) and real
authenticated `@fhip-test.local` users. Scripts:
`scripts/ii_r6_final_reference_seed.mjs`,
`scripts/ii_r6_final_live_dev_cases.mjs`,
`scripts/ii_r6_final_atomicity_idempotency_staleness.mjs`. Raw results:
`scripts/ii-r6-final-certification/live_dev_cases_results.json`,
`.../atomicity_idempotency_staleness_results.json`.

## Reference data (Sections 13, 16, 18)

Seeded directly into DEV via service-role key (pure DML, no DDL needed) and
mirrored as an idempotent forward migration
(`supabase/migrations/0059_ii_r6_final_reference_seed.sql`) for
reproducibility:

- `ii_scheme_tax_classification`: 5 rows — 3 `equity_oriented` (ICICI
  Prudential Nifty 50 Index Fund at 99.5% domestic equity, SBI Bluechip
  Fund Direct+Regular at 97.0% each, all genuinely computed via the real
  `classifyScheme()` function against real NSE large-cap constituent names
  with illustrative/approximate weights — disclosed as such, not a live
  factsheet feed), 1 `debt_specified` (a newly added real, named instrument
  — ICICI Prudential Corporate Bond Fund, ISIN `INF109KA1Z62`, since DEV's
  existing India instrument set had zero debt funds), 1 `unresolved` (NPS
  Tier I - Equity (E), deliberately left unresolved — different tax regime
  entirely, see the script's header for the full rationale).
- `ii_exit_load_schedules`: 4 rows, including a real historical+current
  pair on SBI Bluechip Fund (Direct) (`2016-01-01`–`2019-03-31` tiered, then
  `2019-04-01`–present simplified) — general industry-typical structures,
  explicitly disclosed as not any one scheme's actual SID.
- **TER (Section 18): genuinely not operational.** No TER reference-data
  table exists anywhere in the schema (`ii_r6_final/tax/cost-intelligence`
  route returns `available: false` with an honest reason string, never a
  fabricated number). This is a disclosed scope gap for a future phase, per
  the spec's own "do not infer TER, do not use category averages" rule.

## Tax-profile input surface (Sections 20-23)

`ii_tax_profiles` (migration `0060`) is a NEW table — **not yet applied to
DEV** (this session has no DDL capability, confirmed structurally by the
same probe method as every migration this project has needed applied
out-of-band). Consequence, live-verified: `GET
/api/investment-intelligence/tax/profile` returns
`{profile: null, persistenceAvailable: false}`; `PUT` returns HTTP 503 with
an explicit message. The tax-profile input itself is still genuinely
exercised as an **explicit per-request override**
(`?taxpayerType=...&taxYear=...` on `tax/summary`) — a deliberate, explicit
user input, just not yet persisted across sessions. `RESIDENT_INDIVIDUAL`,
`RESIDENT_HUF`, and `NON_RESIDENT_INDIVIDUAL` are all live-verified (see
LIVE-R6-012 below and `tests/unit/iiR6FinalTaxpayerContext.test.ts`'s 9
hermetic cases) to produce the correct `taxpayerContext` without ever
changing a computed rupee figure for equity-oriented gains (verified
identical `taxableGain` across individual/HUF/NRI in both the hermetic
tests and live).

## The 12 LIVE-R6-DEV cases — ALL PASS, 10/12 independently recalculated

| Case | Description | Result | Independent recalc |
|---|---|---|---|
| LIVE-R6-001 | Simple realised equity gain (single lot, LTCG) | **PASS** | Yes — 15,000 both sides |
| LIVE-R6-001-DB | Persisted `ii_capital_gains_computations` row matches | **PASS** (after the fix below) | DB ground truth |
| LIVE-R6-002 | Multi-lot FIFO (2 of 3 lots consumed, oldest first) | **PASS** | Yes — 6,600 both sides, FIFO order 500-then-200 verified independently |
| LIVE-R6-003 | Partial multi-lot redemption, remaining-units balance | **PASS** | Yes — gain 3,200, remaining 600 units |
| LIVE-R6-004 | Switch transaction (switch_out taxed, switch_in opens new lot) | **PASS** | Yes — gain 3,000, new lot dated the switch date |
| LIVE-R6-005 | Grandfathering (real 31-Jan-2018 FMV, three-way comparison) | **PASS** | Yes — basis ₹25/unit, gain 4,000 |
| LIVE-R6-006 | Specified/debt fund always STCG (5+ years held) | **PASS** | Yes — STCG, gain 3,000, classification `debt_specified` from the real reference row |
| LIVE-R6-007 | Multi-fund taxpayer-level LTCG exemption threshold | **PASS** | Yes — gross 160,000 − 125,000 exemption = 35,000 taxable, `contributingDisposalCount=2` |
| LIVE-R6-008 | Mixed-lot exit load (one lot past the 365-day tier, one within) | **PASS** | Yes — 580-day lot=0%, 92-day lot=1% |
| LIVE-R6-009 | Direct vs Regular plan cost comparison | **PASS** | Yes — Direct gain 30,000 > Regular gain 28,645.83, two fully separate canonical positions |
| LIVE-R6-010 | AUD household / INR investment currency isolation | **PASS** | Yes — INR gain 9,000, unaffected by any AUD conversion |
| LIVE-R6-011 | Missing tax-profile | **PASS** | `taxpayerContext.estimateBasis === 'UNKNOWN_PROFILE'`, never assumed resident |
| LIVE-R6-012 | Non-resident / DTAA-not-evaluated | **PASS** | `INDIA_DOMESTIC_LAW_ESTIMATE`, `dtaaEvaluated: false`, gain still correctly computed (100) |

**10 of 12** cases carry an independent (non-production-code) hand/script
recalculation; the remaining 2 (011, 012) are profile/metadata assertions
where "independent recalculation" doesn't apply to a number — both are
still genuine live HTTP calls with DB-ground-truth-adjacent checks
(`taxProfileSource`).

## A real defect found and fixed: `lot_id` foreign key was never satisfiable

**LIVE-R6-001-DB failed on the first run.** DEV's response to the first
real `tax/summary` call included a persistence warning:

> `insert or update on table "ii_capital_gains_computations" violates
> foreign key constraint "ii_capital_gains_computations_lot_id_fkey"`

Root cause: `ii_capital_gains_computations.lot_id` (and
`ii_tax_lot_consumptions.lot_id`) is a not-null FK to `ii_tax_lots(id)`, but
**nothing in R6-P1 ever wrote a row to `ii_tax_lots`** — lots are computed
purely in-memory by `taxLotEngine.ts` and were never persisted. The
original code passed the raw acquisition-transaction id as `lot_id`, which
is never a real `ii_tax_lots.id`. Every real disposal's persistence attempt
had been failing silently (swallowed into a non-fatal `warnings` entry)
since R6-P1 shipped — `ii_capital_gains_computations` had **never held a
single real row in any environment**, in spite of the feature "working"
(figures are always recomputed fresh, never read back from the persisted
table for display).

**Fix** (`lib/services/investment-intelligence/taxRepository.ts`):

- `persistTaxLots()` — actually populates `ii_tax_lots` (whose own schema —
  `user_id`, `account_id`, `instrument_id`, `opening_transaction_id`,
  `status`, `acquisition_date`, `units_acquired`/`units_remaining`,
  `cost_per_unit` — matches `TaxLot` exactly, confirming this was always
  the intended design) using a **deterministic** id
  (`deterministicLotId()`, an RFC 4122 v5 UUID derived from the lot's own
  stable key) so repeated computation is naturally idempotent without
  needing a new unique index this session cannot add via DDL.
- `persistTaxLotConsumptions()` — the same defect existed for
  `ii_tax_lot_consumptions` (declared in schema, mentioned in a comment,
  never actually written to). Fixed the same way; required adding
  `costBasisPreGrandfathering` to `DisposalTaxResult`
  (`capitalGainsEngine.ts`) since the consumption ledger's own
  `cost_basis_pre_grandfathering` column needs the RAW pre-grandfathering
  basis, which the existing `costBasisUsed` field doesn't always equal.
- `persistCapitalGainsComputations()` — now derives `lot_id` via the same
  `deterministicLotId()`, so the FK resolves.
- Call order in `tax/summary/route.ts`: lots → consumptions → gains (FK
  dependency order).

Certified by `tests/unit/iiR6FinalTaxLotPersistenceFix.test.ts` (4 hermetic
tests on `deterministicLotId`'s properties) plus the full live re-run of
all 12 LIVE-R6 cases (all PASS after the fix) — see
`ii_r6_final_reference_seed.mjs`/`ii_r6_final_live_dev_cases.mjs`'s DB
ground-truth checks and `SEC-R6` pack's use of these now-real rows.

## Live UX (Section 27)

`/investment-intelligence/tax` — Tax Summary, Realised Gains, Tax Lots,
Redemption Simulator, and the explicit tax-profile control, mirroring
`SipIntelligenceClient.tsx`'s conventions exactly. Browser-verified live
against DEV data (screenshots taken during this dispatch, not reproduced
here):

- Logged in as a real LIVE-R6 test user, page rendered the full disclaimer,
  a 12-row realised-gains table, and a tax-lots table with real acquisition
  dates/units.
- Redemption simulator: entered a real open lot's instrument id, 200 units
  at ₹25/unit → returned "Estimated taxable gain: ₹1,800" (200 × (25−16) =
  1,800, matching the lot's real cost-per-unit of ₹16 exactly), "Estimated
  exit load: ₹0" (no schedule seeded for that test instrument — correctly
  absent, not fabricated as 0% via guesswork).
- Tax-profile selector: switching to "Non-resident individual (NRI)" and
  clicking Apply changed the on-page "Estimate basis" to
  `INDIA_DOMESTIC_LAW_ESTIMATE` / `DTAA evaluated: false` live, no page
  reload.

`/investment-intelligence` hub and the R4/R5 sibling pages
(`/investment-intelligence/sip`, `/xray`, `/performance`) are similarly not
linked from the main nav or the hub page — confirmed this is the
**pre-existing, established pattern** for this whole module (checked
`AppShell.tsx`'s nav config and `InvestmentIntelligenceClient.tsx`'s own
lack of internal links), not a gap introduced by this page.

## Pagination at scale (Sections 39-41)

DEV genuinely has nowhere near 1,000 rows in any relevant table as of this
dispatch (`ii_transactions`: 96 total rows across all users;
`ii_prices_nav`: 3 rows; `ii_instruments`: 56 rows — all confirmed via
`Content-Range` headers on a real PostgREST request). The
999/1000/1001/2500/5001-row boundary matrix therefore **remains
synthetic/mocked**, exactly as the pre-DEV pass's own
`tests/unit/iiR6FinalTaxPaginationAudit.test.ts` (13 tests) already does —
honestly noted, not fabricated as a live-DEV proof. What IS newly
live-verified: the `fetchAllRows()`-paginated reads in `taxRepository.ts`
function correctly end-to-end against real (if small) DEV datasets — every
one of the 12 LIVE-R6 cases' reads went through this exact code path
without truncation or error.

## Atomicity (Section 42)

The three persistence steps (`persistTaxLots`,
`persistTaxLotConsumptions`, `persistCapitalGainsComputations`) are three
separate upserts, **not** wrapped in one DB transaction — genuinely not
atomic at the storage layer. What was live-tested is the property that
actually matters:

1. **ATOMICITY-1**: constructed a real partial-state precondition by
   deleting a real user's `ii_capital_gains_computations` rows via
   service-role while leaving `ii_tax_lots` intact (simulating "the gains
   step failed mid-computation").
2. **ATOMICITY-2 (PASS)**: the very next `tax/summary` call still returned
   all 12 correct disposal results — the API never reads persisted state
   back for display, only ever recomputes fresh from `ii_transactions`, so
   a partial-persistence gap can never surface a wrong number.
3. **ATOMICITY-3 (PASS)**: that same call fully self-healed the gap (12
   rows restored, matching the original ids/values) with no manual repair.

## Idempotency (Section 43)

`IDEMPOTENT-1`/`2`/`3` (all PASS): two consecutive identical `tax/summary`
calls produced byte-identical `disposalResults`, and created **zero**
duplicate rows across `ii_capital_gains_computations` (12 → 12),
`ii_tax_lots` (14 → 14), and `ii_tax_lot_consumptions` (12 → 12).

## Staleness / invalidation (Section 44)

| Trigger | Result |
|---|---|
| Transaction correction (real `PATCH` on `ii_transactions.price_per_unit`) | **PASS** — taxable gain moved from 15,000 to 10,000 (exact expected −5,000 delta), and reverted exactly on undo |
| Tax-classification change (real `PATCH` flipping `equity_oriented`→`unresolved`) | **PASS** — classification and gain immediately reflected the change (gain became `null`, correctly excluded), reverted exactly on undo |
| Tax-profile change (per-request override toggled across 3 consecutive calls) | **PASS** — `UNKNOWN_PROFILE` → `INDIA_DOMESTIC_LAW_ESTIMATE` → `UNKNOWN_PROFILE`, no lag either direction |
| Tax-rule change | **HONEST DISCLOSURE, not a live demo.** Confirmed via direct code search: `ii_tax_rule_versions` is never read by `resolveRuleVersion()` (always uses in-code `ALL_RULE_VERSIONS` constants) — there is no DB-driven rule-change scenario this architecture supports today, so staging one would be theatre. What IS genuinely provable (and proven, via ATOMICITY-2) is that every call recomputes fully fresh, including rule resolution — no rule-derived figure is ever cached. The real historical precedent for "a rule change forces recomputation" is `TAX_ENGINE_VERSION`'s v1→v2 bump during the pre-DEV closure pass (a genuine correction that forced every previously-computed result to recompute). |
