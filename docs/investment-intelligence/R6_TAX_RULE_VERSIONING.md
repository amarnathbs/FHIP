# R6 Tax Rule Versioning — How It Actually Works

Status: R6-FINAL closure pass, pre-DEV-application dispatch. 2026-08-22.

## The core idea

Every India capital-gains rate/threshold this engine uses lives in exactly
ONE place: `lib/engines/investment-intelligence/tax/ruleVersions.ts`'s
`ALL_RULE_VERSIONS` array. Nothing else in the engine hardcodes a rate,
threshold, or a `today >= someDate` branch. This is what makes "recompute
next year" safe: the DB row / config entry a disposal resolves to is a pure
function of the disposal's own date, never of when the code runs.

## Shape

```ts
interface TaxRuleVersion {
  ruleSetKey: 'in_mutual_fund_capital_gains';
  version: string;                 // e.g. '2025_act_post_20260401'
  countryCode: 'IN';
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;      // null = open-ended (currently in force)
  ruleDefinition: {
    placeholder: boolean;           // true only for a genuinely uncertified rule
    sourceNote: string;              // human-readable citation, dated
    equityOriented: { domesticEquityThresholdPct, stcgHoldingPeriodMonths,
                       stcgRatePct, ltcgRatePct, ltcgExemptionThresholdInr,
                       indexationAllowed: false };
    debtSpecified: { specifiedFundAcquiredOnOrAfter, alwaysShortTerm,
                      indexationAllowed: false, taxedAtSlabRate };
  };
}
```

## Resolution

```ts
resolveRuleVersion(disposalDate, versions = ALL_RULE_VERSIONS): TaxRuleVersion
```

Finds the ONE version whose `[effectiveFrom, effectiveTo]` range contains
`disposalDate` (inclusive both ends; `effectiveTo: null` means open-ended).
Throws `NoApplicableRuleVersionError` if none matches — there is no silent
fallback to "the closest one" or "today's version". As of this pass the
three rows cover 2023-04-01 onward with no gaps:

```
2023-04-01 ─────────────── 2024-07-22   1961_act_pre_20240723
2024-07-23 ─────────────── 2026-03-31   1961_act_post_20240723
2026-04-01 ─────────────── (open)       2025_act_post_20260401
```

A disposal before 2023-04-01 has no covering row and raises rather than
guessing — this engine's stated scope boundary (pre-FY2023-24 disposals are
out of scope for the initial release).

## The `placeholder` flag and its disclaimer wiring

`ruleDefinition.placeholder` is a structural escape hatch for a rule the
engine cannot yet certify: `capitalGainsEngine.ts` copies it onto every
`DisposalTaxResult.ruleVersionPlaceholder`, `taxOrchestrator.ts` ORs it
across all of a simulation's disposals into `placeholderUsed`, and
`disclaimer.ts`'s `withTaxDisclaimer()` attaches `PLACEHOLDER_RULE_DISCLAIMER`
to the result whenever that's true. `taxRepository.ts` persists the flag
verbatim as `ii_capital_gains_computations.rule_version_placeholder`.

**As of the R6-FINAL closure (2026-08-22), no rule version is flagged
`placeholder: true`** — the prior `2025_act_placeholder` row was replaced
after independent legal research corroborated its rates (see
`R6_TAX_LEGAL_SOURCE_REGISTER.md`). The mechanism is deliberately NOT
deleted: it exists so a future Finance Act amendment this team cannot verify
in time can be flagged the same way, end-to-end, without any engine change —
add a row with `placeholder: true` and every downstream surface (disclaimer,
persisted flag, UI) already knows how to show it.

## Certification: three surfaces, deliberately independent

1. **Production**: `ruleVersions.ts` (this file), consumed by
   `capitalGainsEngine.ts` / `taxOrchestrator.ts` / `taxYearAggregation.ts`.
2. **Migration seed**: `supabase/migrations/0058_ii_r6_p1_tax_engine.sql`'s
   `ii_tax_rule_versions` INSERT — hand-mirrored to match (1), not generated
   from it, so a divergence between the two is visible as a mismatch rather
   than silently impossible.
3. **Independent oracle**: `scripts/ii_r6p1_independent_reconciliation.py`'s
   `RULE_VERSIONS` list — deliberately RE-TRANSCRIBED from the same
   researched sources, never imports `ruleVersions.ts`. The 120+12-case
   certification pack (`scripts/ii-r6p1-certification/`) diffs (1) against
   (3) case-by-case; 604/604 comparisons pass as of this dispatch.

## Bumping the rule table safely

To add a new rule version (e.g. a Finance Act 2026 amendment discovered
later): add a `TaxRuleVersion` row with correct `effectiveFrom`/`effectiveTo`
(adjusting the PRECEDING row's `effectiveTo` so there is no gap or overlap),
mirror it into a new migration's `ii_tax_rule_versions` insert, re-transcribe
it independently into the Python oracle, add oracle-compared cases to
`generate_cases.mjs`'s `rate_version`/`act_transition` families, and bump
`TAX_ENGINE_VERSION` in `taxVersioning.ts` (forces any cached
placeholder-or-now-stale result to recompute). This exact sequence is what
happened in this pass — see the change log below.

## Change log

- 2026-08-22 (R6-FINAL closure): `2025_act_placeholder` → `2025_act_post_20260401`,
  `placeholder: true` → `false`. `TAX_ENGINE_VERSION` bumped
  `tax-engine-r6-p1-v1` → `tax-engine-r6-p1-v2`. Migration `0058`'s seed
  updated to match. 12 new closure cases added to the certification pack
  (`act_transition` × 6, `grand_boundary` × 6); pack grew 120 → 132 cases,
  544 → 604 comparisons, still 0 failures.
