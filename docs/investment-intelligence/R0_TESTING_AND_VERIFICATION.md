# R0 — Testing and Verification

Status: FINAL (R0)
Covers spec Section 19 (A–G). R0 is architecture-focused; sections C–G below are **design/paper tests** run against the frozen contracts, not executable code (no Investment Intelligence code exists to execute against — by design, per the task's non-goals). Section A (baseline regression) is a real, executed test.

## A. Baseline regression

Commands used are the actual scripts in `package.json` (`R0_CURRENT_STATE_DISCOVERY.md` confirms no `typecheck` script exists; the project's own established convention, confirmed in `.claude/settings.local.json`'s allowlisted commands, is `tsc --noEmit -p tsconfig.json` directly).

Executed **before** any R0 documentation was written, on `main` tip `fe7a094` immediately after creating branch `feature/investment-intelligence-r0-architecture`:

| Command | Result | Notes |
|---|---|---|
| `npm run lint` (`eslint .`) | **Exit 1 — 6 pre-existing errors, 6 warnings** | All 6 errors are `react-hooks/set-state-in-effect` violations in `components/recommendations/RecommendationsPanel.tsx` and `components/ui/AppShell.tsx`; all 6 warnings are `@next/next/no-img-element` notices in `components/reports/ReportPreview.tsx` and `components/ui/AppShell.tsx`. **Confirmed pre-existing** — no Investment Intelligence file exists to have caused them; these predate this branch entirely (present at `main` tip). |
| `tsc --noEmit -p tsconfig.json` | **Exit 0 — clean** | No type errors. |
| `npm test` (`vitest run`) | **Exit 0 — 124 passed (124), 14 test files** | Full existing suite green. |
| `npm run build` (`next build`) | **Exit 0 — success** | Full production build completes; every existing route compiles. |

Executed **again after** all R0 documentation was written (this release makes no source-code changes, only adds files under `docs/investment-intelligence/`):

| Command | Result | Delta from before |
|---|---|---|
| `npm run lint` | Exit 1 — same 6 errors, 6 warnings | **No change** — confirms R0 introduced zero lint regressions (expected: no `.ts`/`.tsx` file was touched). |
| `tsc --noEmit -p tsconfig.json` | Exit 0 — clean | **No change.** |
| `npm test` | Exit 0 — 124 passed (124) | **No change.** |
| `npm run build` | Exit 0 — success | **No change** (re-run to confirm; see `R0_ACCEPTANCE_REPORT.md` for the exact re-run log reference). |

**Verdict**: R0 did not break the existing application. The 6 pre-existing lint errors are a known, unrelated baseline condition, not something this release introduced or is responsible for fixing (out of scope — R0 makes no source changes at all).

## B. Architecture consistency test

Every one of the 20 canonical entities in `R0_CANONICAL_DATA_CONTRACT.md` was checked against the required attribute list (spec Section 6): ownership model, identifier strategy, provenance, country/currency treatment, audit requirement, lifecycle, FHIP relationship. Result: **20/20 entities specify all seven attributes** (verified via the entity-by-entity section and the summary table at the end of `R0_CANONICAL_DATA_CONTRACT.md`) — reference-data entities correctly specify "no `user_id`, world-readable" rather than omitting the ownership-model attribute, and country-neutral entities correctly specify "n/a, this table is not money/jurisdiction-bearing" rather than omitting country/currency. No entity was left unspecified.

## C. Double-counting scenario test

The 12-scenario matrix required by spec Section 9 was run as a design test in `R0_NET_WORTH_DEDUP_CONTRACT.md` section 2. Result for each:

| # | Scenario | Resolves to exactly one household economic value? |
|---|---|---|
| 1 | Manual share in Assets | ✅ (today's unmodified behaviour) |
| 2 | Manual share in Investments | ✅ (today's unmodified behaviour) |
| 3 | Same share later imported from a broker | ✅ (via linking to the existing row, not a second insert) |
| 4 | Mutual fund imported from CAS | ✅ (single new row, no prior duplicate) |
| 5 | Manual managed-fund row + imported CAS holding | ✅ (via linking + reconciliation) |
| 6 | Indian NPS published to Retirement | ✅ (single-target routing by instrument classification) |
| 7 | Term deposit — Asset vs Investment | ✅ (single-target routing, consistent bucket either way) |
| 8 | Gold investment vs personal gold asset | ✅ (no import path can produce the collision at all) |
| 9 | Indian investment shown in AUD net worth | ✅ (source value preserved; conversion happens once, at read time, in-memory) |
| 10 | Archived/unlinked imported investment | ✅ (existing `is_active` exclusion, already tested by the 124-test baseline) |
| 11 | Source document refreshed with newer holdings | ✅ (update-in-place via `unique(canonical_position_id)`, never a second publication) |
| 12 | User correction to an imported position | ✅ (layered correction, same row) |

**12/12 scenarios pass the design test.** The mechanism proving this (single-target-per-position publishing + `unique(canonical_position_id)` + reuse of the existing `is_active` soft-delete exclusion) requires zero changes to `computeDashboard()` — verified by inspection of the actual function (`R0_CURRENT_STATE_DISCOVERY.md` section 8), not merely asserted.

## D. Publishing contract test

Demonstrated conceptually in `R0_FHIP_PUBLISHING_CONTRACT.md` and `R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 4, traced end-to-end:

```
ii_source_documents (one CAS PDF)
  -> ii_transactions (parsed buy/SIP/dividend events)
  -> ii_holding_snapshots (latest certified balance, quality_status='certified')
  -> ii_fhip_publications (one row, publication_target='investments', include_in_net_worth=true)
  -> investments row (master_item_key='managed_funds', current_value = snapshot value,
     currency_code='INR', country_code='IN', owner mapped, institution = AMC name)
  -> Investments grid displays it (identical rendering to a manual row, plus a "Last reconciled" badge)
  -> computeDashboard() sums it into totalInvestments exactly once
     (reportingValue() converts INR->household currency at aggregation time only)
  -> netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities
     includes this value exactly once
```

**Proven**: the value reaches net worth exactly once, by tracing the exact `computeDashboard()` formula (`R0_CURRENT_STATE_DISCOVERY.md` section 8) against the exact publishing target (`investments.current_value`), with no second table anywhere in the chain that also feeds `computeDashboard()`.

## E. Goal test

Demonstrated in `R0_GOAL_INTEGRATION_CONTRACT.md` section 4:

| Case | Verified against |
|---|---|
| One position → one goal | Existing `checkFundingAllocation()` cap logic (≤100%, trivially satisfied) |
| One position → multiple goals | Existing cap logic summed across all `goal_funding_sources` rows for the same `linked_investment_id` |
| Multiple positions → one goal | Existing `goal_id`-to-many-`goal_funding_sources` design, already supported |
| Goal allocation change | New `ii_goal_allocations` row with `effective_from`, `goal_funding_sources.allocation_percentage` updated in place |
| Goal unlink | `ii_goal_allocations.status='removed'` + `goal_funding_sources.is_active=false` |

All five resolve without any change to `goalFundingAllocation.ts` or `goal_funding_sources`' schema — verified against the actual `checkFundingAllocation()`/`evaluateAllocation()` source (`R0_CURRENT_STATE_DISCOVERY.md` section 6), not assumed.

## F. Cross-border test

Demonstrated in `R0_CROSS_BORDER_CONTRACT.md` section 4, traced against the actual `reportingValue()`/`convertToReportingCurrency()` implementation (`R0_CURRENT_STATE_DISCOVERY.md` section 8):

- Indian MF source value: ₹5,00,000, `currency_code='INR'` — preserved unchanged through `ii_holding_snapshots` → `investments.current_value`.
- FHIP household base currency: AUD.
- `computeDashboard()` converts to AUD-equivalent **only** at the point it sums into `totalInvestments`/`netWorth` — the conversion is in-memory and derived, never written back over the INR source value.
- Per-country breakdown (`investmentByCountry`) continues to show ₹5,00,000, matching the existing "as recorded, in each country's own currency" behaviour already confirmed in `dashboard.ts`'s own code comments.

**Proven**: the INR canonical value remains preserved while the household receives correct AUD-equivalent net-worth information, using existing, unmodified FX conversion code.

## G. Advice-boundary test

Ten example insights, classified per `R0_INSIGHT_CLASSIFICATION.md` section 3:

1. "38% of your portfolio is held in three companies." → **Observation**
2. "Concentrated portfolios can experience larger swings when one company underperforms." → **Education**
3. "If you redeemed ₹2,00,000 from Fund X today, the estimated exit load under a 1% assumption would be ₹2,000." → **Simulation**
4. "Switch out of Fund X and into Fund Y for better returns." → **Personalised advice** (gated)
5. "You have not made a SIP contribution to this fund in the last 4 months." → **Observation**
6. "Regular SIP investing can help smooth out the effect of market volatility over time." → **Education**
7. "At your current SIP amount, this fund's value would reach an estimated ₹X in 5 years, assuming a 10% annual return." → **Simulation**
8. "You should redeem your entire holding in this fund before the financial year ends." → **Personalised advice** (gated)
9. "This fund's expense ratio is 1.8%, compared to a category average of 1.1%." → **Observation**
10. "A higher expense ratio reduces net returns over time, all else being equal." → **Education**

**10/10 correctly classified**; the 2 personalised-advice examples (4, 8) are both structurally gated per `ADR-007` — neither could be surfaced to a consumer without `compliance_approved_at` being set, which R0/R1 never sets.

## Summary

| Test | Type | Result |
|---|---|---|
| A. Baseline regression | Executed | Healthy before and after (lint: 6 pre-existing errors unchanged; typecheck/tests/build: clean, unchanged) |
| B. Architecture consistency | Design | 20/20 entities fully specified |
| C. Double-counting scenarios | Design | 12/12 pass |
| D. Publishing contract | Design (traced against real code) | Proven — value reaches net worth exactly once |
| E. Goal test | Design (traced against real code) | 5/5 cases pass, zero engine changes needed |
| F. Cross-border test | Design (traced against real code) | Proven — INR preserved, AUD derived correctly |
| G. Advice-boundary test | Design | 10/10 correctly classified, advice gated |
