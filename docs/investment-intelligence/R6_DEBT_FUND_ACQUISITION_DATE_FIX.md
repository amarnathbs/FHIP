# R6-DEBTFIX: Debt/Specified Mutual Fund Acquisition-Date Gate Fix

Status: **FIXED, independently re-verified live on DEV.** Branch
`feature/investment-intelligence-r6-debt-fund-fix`, off R6-FINAL closure tip
`eed5890`. Dispatched 2026-08-22 in response to a confirmed defect raised by
an independent acceptance review and re-verified by the orchestrating
session against live DEV data before this fix began.

## 1. The defect

`lib/engines/investment-intelligence/tax/capitalGainsEngine.ts`'s
`computeDisposalTax()`, `debt_specified` branch, unconditionally set
`gainType: 'stcg'` for every debt/specified-mutual-fund lot, regardless of
the lot's own acquisition date, with the comment "always short-term,
regardless of holding period (Finance Act 2023 rule)".

This is legally wrong for a lot **acquired before 1 April 2023**. Section
50AA (the "specified mutual fund" always-short-term rule, Finance Act 2023)
only applies to units acquired **on or after** 1 April 2023. A pre-cutoff
lot retains the general Section 2(42A)/112 capital-asset treatment that
predates the 2023 carve-out — which can legitimately be LTCG.

`ruleVersions.ts`'s `DebtSpecifiedRules.specifiedFundAcquiredOnOrAfter`
field already existed and was already documented as the per-lot gate, but
`capitalGainsEngine.ts` never actually read it — the field was dead data.
This exact gap was disclosed (not silently missed) in the R6-FINAL closure
pass's own source register (`R6_TAX_LEGAL_SOURCE_REGISTER.md` Section 4,
"DISCLOSED GAP") and given a dedicated regression test
(`tests/unit/iiR6FinalDebtFundBoundary.test.ts`) that *named* the bug as
accepted, disclosed behaviour rather than treating it as in-scope to fix.
The independent acceptance review correctly judged that disclosure
insufficient — a live, wrong tax number is a real defect regardless of
whether it was disclosed in a doc.

### Live-DEV proof (confirmed both before and after this fix)

Instrument: **ICICI Prudential Corporate Bond Fund – Growth (Direct Plan)**
(ISIN `INF109KA1Z62`), `ii_capital_gains_computations` row
`5580d650-e0fc-464f-adac-619dd3a968f3`:

| Field | Value |
|---|---|
| `ii_tax_lots.acquisition_date` | `2019-01-01` |
| Disposal `transaction_date` | `2024-06-01` |
| Units / cost per unit / sale price per unit | 1000 / ₹12 / ₹15 |
| `holding_days` | 1978 (5.4 years) |
| **BEFORE** `gain_type` | `stcg` (wrong) |
| **AFTER** `gain_type` | `ltcg` (correct) |

## 2. Legal research (before writing any code)

Evidence standard matched `R6_TAX_LEGAL_SOURCE_REGISTER.md`'s own bar: at
least 3 independent, mutually-consistent secondary sources, cross-checked
where possible against a primary/official source, with every claim checked
via live web search/fetch on 2026-08-22 (not recalled from training data),
and every inference-not-directly-cited fact flagged as such.

### 2a. The pre-1-April-2023 debt/non-equity mutual fund rule (as it stood
before Finance Act 2023)

| Field | Finding |
|---|---|
| Holding-period threshold | **> 36 months = LTCG**, otherwise STCG |
| LTCG rate | **20%**, WITH Cost-Inflation-Index (CII) indexation, under Section 112 |
| STCG rate | Taxpayer's income-tax slab rate |
| Sources | HDFC Life "Debt Fund Tax Rules 2026", ICICI Direct "Changes in taxation of non-equity funds from FY23-24" (fetched directly), ValueResearchOnline "How are debt funds bought before 2023 taxed?" (fetched directly, explicit quote: *"If you hold the funds for over three years, gains were qualified as long-term capital gain (LTCG) and are taxed at 20% with indexation"*), ClearTax |
| Confidence | **CERTIFIED** — 4 independent sources agree exactly, including two direct-fetched primary-style explainer pages |

### 2b. Budget 2024 (23 July 2024) indexation-removal interaction — the
second effective-date boundary

Budget 2024 (Finance (No. 2) Act, 2024) did **not** leave pre-2023
acquisitions alone — it changed their treatment too, for any disposal on or
after 23 July 2024:

| Field | Finding (disposals on/after 23-Jul-2024, lot acquired before 1-Apr-2023) |
|---|---|
| Holding-period threshold | Shortened from 36 to **24 months** |
| LTCG rate | Flat **12.5%**, indexation **removed** |
| STCG rate | Unchanged — taxpayer's slab rate |
| Sources | ValueResearchOnline (fetched directly: *"Indexation benefit is available only for debt funds purchased before April 1, 2023, held for more than 36 months, and redeemed before July 23, 2024... After July 23, 2024, the requirement dropped to >24 months with the flat 12.5% rate but no indexation"*), PrimeInvestor "Budget 2024 – how your equity & debt investments are taxed now" (fetched directly, matching quote with exact numbers), ICICI Direct, Business Standard (search-corroborated) |
| Confidence | **CERTIFIED** — 3+ independent sources, two fetched directly and in exact agreement including the specific 23-Jul-2024 boundary date |

**A specific ambiguity resolved during research**: an initial, lower-quality
search summary suggested pre-2023 debt-fund lots got an *optional choice*
between "20% indexed" and "12.5% unindexed" on disposals after 23-Jul-2024,
the same way land/building transactions did after Budget 2024's later
August-2024 amendment. Direct fetches of ValueResearchOnline and
PrimeInvestor **both explicitly deny this for debt funds** ("no optional
choice... the taxation method depends on your redemption date, not investor
preference" / "the article specifies there is no optional choice"), and a
follow-up search independently confirmed the 20%-indexed/12.5%-unindexed
*choice* is a **land/building-only** provision, unrelated to mutual funds.
This engine implements the debt-fund rule as **mandatory by disposal date**,
not optional — matching the higher-confidence, directly-fetched sources.

### 2c. Continuity into the Income-tax Act, 2025 (post-1-Apr-2026)

No source specifically discusses the pre-2023-acquisition debt-fund legacy
regime under the 2025 Act by name — this is the same class of gap the
R6-FINAL closure pass already disclosed for grandfathering continuity (a
cost/rate mechanic, not a headline provision, so it's under-covered by
consumer tax-explainer sites). **Not independently section-cited.** Carried
forward unchanged (24-month/12.5%/no-indexation) by inference, consistent
with every source's characterisation of the 2025 Act as a
renumbering/consolidation exercise with no capital-gains policy change for
mutual funds. **Flagged as an open item**, in both `ruleVersions.ts`'s
module header and this document — not silently assumed as certified.

## 3. The fix

`ruleVersions.ts`:
- Added `LegacyDebtFundRegime` (holding-period-months / rate / whether
  indexation is legally allowed) and a `legacyRegime` field on
  `DebtSpecifiedRules`, populated per rule version:
  - `1961_act_pre_20240723` (disposals 2023-04-01 → 2024-07-22): 36 months,
    20%, indexation allowed (but not computed — see below).
  - `1961_act_post_20240723` (disposals 2024-07-23 → 2026-03-31): 24
    months, 12.5%, no indexation.
  - `2025_act_post_20260401` (disposals ≥ 2026-04-01): same as the row
    above, carried forward by disclosed inference (Section 2c).

`capitalGainsEngine.ts`'s `debt_specified` branch now:
1. Gates on the **lot's own `acquisitionDate`** against
   `rules.debtSpecified.specifiedFundAcquiredOnOrAfter` (2023-04-01).
2. **Acquired on/after the cutoff**: unchanged — Section 50AA, always STCG,
   slab rate, no indexation. Note text now says "on/after the 1 April 2023
   Section 50AA cutoff" instead of the old blanket "Finance Act 2023 rule"
   language.
3. **Acquired before the cutoff**: evaluated under `legacyRegime`, resolved
   from the rule version **in force on the disposal date** (same
   effective-dating discipline as everything else in this module) —
   `computeHoldingPeriod` is called with the legacy threshold (36 or 24
   months) instead of being skipped.
   - If short-term: STCG at slab rate, note explains why (pre-2023
     acquisition, still within the applicable legacy holding threshold).
   - If long-term and indexation is legally allowed (pre-23-Jul-2024
     disposal): **honest degradation**, matching `grandfathering.ts`'s
     `fmv_unavailable` pattern — this release does **not** compute a real
     Cost-Inflation-Index-adjusted cost basis (no verified CII table is
     wired into this codebase). `costBasisUsed` remains the plain,
     un-indexed acquisition cost, and the `note` field explicitly states
     the indexation benefit legally applies but was not calculated, and
     that the displayed taxable gain is an upper bound, not final. No
     indexed number is ever fabricated.
   - If long-term and indexation is not legally allowed (disposal on/after
     23-Jul-2024): fully exact — 12.5% rate, no indexation gap to disclose,
     `note` explains this plainly.

Grandfathering (Section 55(2)(ac)) never applies to debt/specified funds,
either branch — unchanged.

### DB reference-data mirror (`ii_tax_rule_versions`)

`ii_tax_rule_versions.rule_definition` is pure reference/documentation data
— the engine computes exclusively from `ruleVersions.ts`'s in-memory
constants, confirmed by grep (no code path reads this table into the
engine) and by `ii_r6_final_atomicity_idempotency_staleness.mjs`'s own
STALENESS-RULE-CHANGE finding. It was, however, out of sync with the fixed
engine after this change, so — consistent with this module's own stated
design goal that "the three surfaces (DB seed, engine, certification
oracle) can be diffed against one canonical source" — migration
`0062_ii_r6_debt_fund_fix_reference_seed.sql` was added (pure DML, UPDATE
against the 3 existing rows, idempotent) and the identical UPDATE was
applied **live to DEV** directly via the service-role key (same
apply-live-then-mirror-into-a-migration precedent as migration `0059`).
Verified live post-application: all 3 rows now carry the corrected
`legacyRegime` object, same row ids, no new/duplicate rows.

## 4. Verification performed

### 4a. Unit tests

- `tests/unit/iiR6P1Certification.test.ts`: new "R6-DEBTFIX: legacy
  debt-fund family" describe block — 10 new independently-oracled cases
  (`DEBTPRE-001..010`) plus targeted assertions:
  - `DEBTPRE-001` reproduces the exact live-DEV defect facts (acquired
    2019-01-01, disposed 2024-06-01, 1000 units @ cost 12/sale 15) and is
    the explicit **regression test that would have caught the original
    defect** — asserts `gainType === 'ltcg'`, the note is no longer the old
    blanket "always short-term" text, and the indexation gap is disclosed
    (never fabricated).
  - `DEBTPRE-005`/`006`: the acquisition-date gate boundary itself
    (2023-03-31 vs 2023-04-01, identical disposal) — proves the gate flips
    treatment.
  - `DEBTPRE-007`/`008`: the 36-month legacy anniversary boundary,
    pre-23-Jul-2024 disposal.
  - `DEBTPRE-009`/`010`: the 24-month legacy anniversary boundary, straddling
    the 23-Jul-2024 Budget boundary itself.
  - `DEBTPRE-004`: a holding period that is long-term under the *wrong*
    24-month rule but correctly short-term under the *right* 36-month rule
    for its pre-Budget-2024 disposal date — proves the correct threshold is
    selected by disposal date, not just "long enough looks LTCG".
- `tests/unit/iiR6FinalDebtFundBoundary.test.ts`: rewritten — the original
  file asserted the bug's existence as "disclosed behaviour"; it now asserts
  the fixed behaviour (pre-cutoff and post-cutoff lots diverge).
- `tests/unit/iiR6FinalCanonicalInstrument.test.ts`: one pre-existing
  fixture (`canon-B`, a debt/specified lot acquired 2016-06-01) had its
  stale `gainType: 'stcg'` assertion corrected to `'ltcg'` (>10 years'
  holding legitimately clears both legacy thresholds); the test's actual
  purpose — proving no cross-contamination between two same-named canonical
  instruments — is unaffected and still passes.

### 4b. Certification pack (independent oracle)

Case count raised from 132 to **142** (120 original + 12 R6-FINAL closure +
10 new R6-DEBTFIX `DEBTPRE-*` cases), generated by
`scripts/ii-r6p1-certification/generate_cases.mjs` and independently
computed by `scripts/ii_r6p1_independent_reconciliation.py` (stdlib-only,
re-transcribes the legacy-regime rule independently rather than importing
`ruleVersions.ts`). Result:

```
caseCount: 142
comparisonCount: 644
passCount: 644
failCount: 0
```

Zero drift on any of the 634 pre-existing comparisons; all 10 new
`DEBTPRE-*` cases pass against the independent oracle.

### 4c. Full regression

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npx vitest run --no-file-parallelism` | **1255 passed**, 5 skipped, 0 failed (70 files passed, 1 skipped) |
| `npx eslint .` | 6 errors / 9 warnings — **all pre-existing, in files this change never touched** (React-hooks-in-effect warnings in unrelated components, `<img>`/`<a>` Next.js lint suggestions, unused-var warnings in unrelated scripts). Zero errors/warnings in every file this fix touched. |
| `npm run build` | Exit code 0, clean production build |

### 4d. Live-DEV re-verification (real repository/engine code path, not a
synthetic re-derivation)

Re-ran the actual disposal computation by starting the real Next.js dev
server, signing in as the real (pre-existing, `@fhip-test.local` test
fixture) user who owns the cited row, and calling the real
`GET /api/investment-intelligence/tax/summary` route — the same route the
product UI calls — which invokes `loadTaxDataset` → `runTaxSimulation` →
`persistCapitalGainsComputations` (upsert on
`disposal_transaction_id,lot_id`, updating the SAME row in place).

| | Before | After |
|---|---|---|
| `gain_type` | `stcg` | **`ltcg`** |
| `holding_days` | 1978 | 1978 (unchanged) |
| `cost_basis_used` | 12000 | 12000 (unchanged — no indexation fabricated) |
| `taxable_gain` | 3000 | 3000 (unchanged — same reason) |
| `rule_version` | `1961_act_pre_20240723` | `1961_act_pre_20240723` (unchanged, correct — keyed by disposal date) |
| `note` | *"Debt/specified mutual fund — always short-term at slab rate regardless of holding period (Finance Act 2023 rule); no indexation, no LTCG treatment."* | *"Debt/specified mutual fund unit acquired 2019-01-01, BEFORE the 1 April 2023 Section 50AA cutoff, disposed 2024-06-01 (pre-23-Jul-2024 rate window) — long-term (held 1978 days, > 36 months) at 20% under Section 112 as it stood before Budget 2024. Cost-Inflation-Index indexation benefit legally applies to this disposal but is NOT calculated by this release (no verified CII table wired in) — the cost basis and taxable gain shown use the UN-INDEXED acquisition cost only. Do not treat this taxable-gain figure as final; a correct indexed cost basis would raise the cost basis and lower the taxable gain shown here."* |

Row id (`5580d650-e0fc-464f-adac-619dd3a968f3`) is unchanged — confirmed
exactly one row exists for this `disposal_transaction_id` before and after
(no duplicate row created by the upsert). No other user's data was touched
— this call only recomputes and persists for the authenticated user
(`922d1025-a658-4d23-8729-fee0d9f75001`) making the request, scoped
server-side, matching this module's existing anti-forgery discipline.

## 5. Honest limitations — explicitly disclosed, not papered over

1. **Indexation is not computed.** For a pre-2023-acquisition lot disposed
   before 23-Jul-2024 and held long enough for LTCG, the correct rate (20%)
   and classification are now applied, but the cost basis is NOT
   CII-indexed — no verified Cost Inflation Index table exists in this
   codebase yet. The displayed `taxable_gain` for such disposals is
   therefore an upper bound (real tax liability would be lower), and this
   is stated plainly in the result's `note` field for every affected
   disposal, never silently omitted.
2. **2025-Act continuity for the legacy regime is inferred, not
   independently section-cited** (Section 2c above) — same disclosed-open-item
   standard as the pre-existing grandfathering-continuity gap.
3. **Disposals dated before 2023-04-01 are out of scope**, unaffected by
   this fix: `resolveRuleVersion` has no rule-version row covering a
   disposal before `2023-04-01` (`ALL_RULE_VERSIONS`' earliest
   `effectiveFrom`), so such a disposal throws `NoApplicableRuleVersionError`
   regardless of classification — a pre-existing, separate scope boundary
   this dispatch did not touch or need to touch (no cited defect, no cert
   case, and no live-DEV row hits this path).
4. This fix does not implement an actual slab-rate rupee computation for
   STCG (debt or otherwise) — unchanged pre-existing scope boundary,
   documented in `taxProfile.ts`.

No RLS policy was touched. No code outside
`capitalGainsEngine.ts`/`ruleVersions.ts` (plus the certification pack,
tests, and the DB reference-data mirror) was modified. R7 was not started.
