# R6: 1961 Act → 2025 Act Transition Model

Status: R6-FINAL closure pass, pre-DEV-application dispatch. 2026-08-22.

## The model

The Income-tax Act, 1961 (as amended by successive Finance Acts) governs
every disposal dated **on or before 2026-03-31**. The Income-tax Act, 2025
[30 of 2025] governs every disposal dated **on or after 2026-04-01**. The
engine's ONE resolution rule (`resolveRuleVersion` in `ruleVersions.ts`):

```
resolveRuleVersion(disposalDate) -> the TaxRuleVersion whose
  [effectiveFrom, effectiveTo] range contains disposalDate
```

This is keyed **exclusively on the disposal's own date** — never on "today",
never on when the calculation happens to run. A disposal that occurred on
2024-01-15 gets the rule version in force on 2024-01-15 whether the engine
computes it in 2024, 2026, or 2030. This is the single mechanism that
prevents retroactive re-rating of historical transactions.

## What research found (Section 8 of the R6-FINAL spec)

The Income-tax Act, 2025's capital-gains chapter, as it applies to equity
shares / equity-oriented mutual fund units / business trust units, was
independently researched and found to be a **renumbering with no rate
change**:

| | 1961 Act (post-23-Jul-2024) | 2025 Act (from 1-Apr-2026) |
|---|---|---|
| STCG section | 111A | 196 |
| LTCG section | 112A | 198 |
| STCG rate | 20% | 20% |
| LTCG rate | 12.5% | 12.5% |
| LTCG exemption | Rs 1,25,000/FY | Rs 1,25,000/tax year |
| Indexation | Not allowed | Not allowed |
| Equity-oriented-fund test | ≥65% domestic equity | ≥65% domestic equity (now Section 198(8)) |
| Debt/specified-fund rule | Always-short-term, slab rate (Finance Act 2023) | Unchanged |

Full citations: `R6_TAX_LEGAL_SOURCE_REGISTER.md`.

This means the CORRECT adversarial behaviour at the boundary is
counter-intuitive to a naive implementer: **the rule VERSION label changes,
but the computed tax AMOUNT does not** (for otherwise-identical facts).
Section 10's test suite proves exactly this — not a generic "the numbers are
different across an Act change" assumption, which would be WRONG here.

## Test evidence

`tests/unit/iiR6P1Certification.test.ts`, describe block **"R6-FINAL Sec.10:
1961 Act -> 2025 Act transition, paired at 31-Mar/1-Apr-2026"**:

1. **6 oracle-compared cases** (`ACTTRANS-001`..`006`, 3 pairs) — each pair
   holds acquisition date, cost, sale price, and units IDENTICAL, varying
   only the disposal date (2026-03-31 vs 2026-04-01). Each case's
   `ruleVersion`, `ruleVersionPlaceholder`, `gainType`, `costBasisUsed`, and
   `taxableGain` are independently verified against
   `scripts/ii_r6p1_independent_reconciliation.py`'s `oracle_act_transition`
   function (which re-derives the rule resolution and STCG/LTCG split from
   scratch, never importing production code).
2. **"the 2026-03-31/2026-04-01 pair carries a DIFFERENT rule version but an
   IDENTICAL taxable gain"** — the adversarial assertion itself: for each of
   the 3 pairs, asserts `preResult.ruleVersion !== postResult.ruleVersion`
   (`1961_act_post_20240723` vs `2025_act_post_20260401`) AND
   `postResult.taxableGain ≈ preResult.taxableGain` (and cost basis) to 1e-6.
3. **"a disposal dated 31-Mar-2026 keeps 1961-Act rules even if the engine
   runs long after 1-Apr-2026 (no retroactive re-rating)"** — proves
   `resolveRuleVersion('2026-03-31')` is invariant across repeated calls,
   since the function has no wall-clock/date.now() dependency at all (the
   strongest available proof in a pure, I/O-free function: there is no
   "later" to simulate other than calling it again, and nothing changes).

All pass: **604/604** total comparisons in the (now 132-case) R6
certification pack, which includes these 6 new cases plus the pre-existing
120.

## Migration mirror

`supabase/migrations/0058_ii_r6_p1_tax_engine.sql`'s `ii_tax_rule_versions`
seed carries the identical three rows (`1961_act_pre_20240723`,
`1961_act_post_20240723`, `2025_act_post_20260401`), all `placeholder:
false`, with the same sourceNote text as `ruleVersions.ts`. Not yet applied
to DEV as of this dispatch (see the closure report's PENDING list).
