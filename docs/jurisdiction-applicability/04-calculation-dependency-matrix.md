# Deliverable 4 — Calculation Dependency Matrix

Format: Engine | Input/Rule | Current Jurisdiction Dependency | Correct Jurisdiction Basis | Risk

All rows below are based on direct reading of the named file/function, not inference from naming alone.

## Net Worth (`lib/engines/dashboard.ts`)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| `computeDashboard()` totals (assets/liabilities/investments/retirement/net worth) | **None** — sums the full active record set unconditionally | Correct as-is: totals must never depend on jurisdiction (spec s.11) | LOW |
| `assetsByCountry` / `liabilitiesByCountry` / `retirementByCountry` / `investmentByCountry` | Per-record `country_code` (the record's own tag, not the user's home country) | Correct as-is — this is presentation/cross-border breakdown metadata, additive to (never subtracted from) the totals above | LOW |
| `countriesInUse` | Union of all `country_code` values seen across modules | Correct — used only to gate "does a Cross-Border section have anything to show", never to filter totals | LOW |
| SMSF valuation (`retirement_accounts.current_balance` for `master_item_key='smsf'`) | Fed exclusively by `smsf_recompute_fund()` (migration `0084`); `dashboard.ts` itself is unmodified/unaware of SMSF specifically | Correct — single valuation source, already certified | LOW |

## Cash Flow / Income / Expenses

No jurisdiction-dependent branch was found in the income/expense aggregation path (confirmed by grep: no `country` reference in the cash-flow summation functions within `dashboard.ts`). Currency conversion (not jurisdiction filtering) is the only cross-country-relevant logic, via `lib/engines/fx.ts`'s `fx_rate_aud_inr` convention, applied uniformly regardless of the holder's home country. **No defect found.**

## Financial DNA (`lib/engines/financialDna.ts`)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| All profile-code scoring rules (debt-constrained-builder, etc.) | **None** — zero country-code literals or jurisdiction reads found in the entire file | Spec s.22 asks only to "map the dependency", not to add one in G0 — mapped as "currently none" | LOW — **RESOLVED, Decision PO-6 (2026-08-27):** stays global permanently; no country-specific behavioural scoring without separate defensible research and certification (`02-module-matrix.md` §Financial DNA) |

## Resilience (`lib/engines/resilience.ts`, `lib/engines/resilienceStress.ts`)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| `investmentByCountry` concentration score | Per-record `country_code`, generic geographic-concentration metric | Correct — global risk metric, jurisdiction-agnostic by design | LOW |
| **Foreign-holdings stress filter (`resilienceStress.ts:84,86`)** | **Derives "home country" from `currency === 'AUD' ? 'AU' : 'IN'`, never reads `country_of_residence` or calls `getUserHomeCountry()`** | Should resolve home country the same way every other module does (`lib/services/jurisdiction.ts`), not re-derive it from currency, which is a legitimately independent field (a household can hold AUD as `preferred_currency` while resident in IN, or vice versa) | **MEDIUM — real, disclosed defect.** Currently produces an incorrect (inverted or overly-broad) foreign-holdings stress-test result for any household whose `preferred_currency` doesn't match their `country_of_residence`. Not fixed in G0 (spec s.3/s.56: G0 does not casually change calculation behaviour) — flagged for Wave 5 with its own before/after regression gate. |
| Social-security / safety-net assumptions | None modelled | Spec s.23 explicitly forbids applying one country's assumption to the other's users — currently satisfied trivially (neither is modelled) | LOW today; future scope question (PO decision) |

## Financial Twin / Benchmark (`lib/services/twinData.ts`, `lib/engines/twin/*`)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| Income-band cohort assignment (`annualGrossIncomeToIncomeBand`, `lib/engines/twin/taxonomy.ts:135`) | Takes `countryCode: 'AU'\|'IN'` explicitly as a parameter — genuinely country-aware, confirmed by unit test `tests/unit/financialTwin.test.ts:60-61` proving the same nominal income figure resolves to a different band for AU vs IN | Correct design | LOW |
| **`const countryOfResidence = (profile?.country_of_residence as 'AU'\|'IN') ?? 'AU'` (`twinData.ts:126`)** | **Silently defaults an unresolved/null home country to `'AU'`** before it is fed into the (otherwise correctly country-aware) income-band function above | Should fail closed like `lib/services/jurisdiction.ts` does (return `null`/a distinguishable "unresolved" state and let the caller decide, e.g. fall back to a broader/unsegmented cohort — never assume AU) | **MEDIUM–HIGH — the clearest, most concrete violation of spec s.25/s.48's "no silent AU defaults" rule found in this audit.** Any user with an unresolved `country_of_residence` (98/344 in DEV, §`05-live-dev-usage-audit.md`) who reaches the Financial Twin is silently benchmarked as if they were AU-resident. Not fixed in G0 (would change real users' benchmark cohort assignment — a genuine behaviour change, not discovery) — flagged as the top Wave 5 candidate fix. |
| Cohort widening via `secondaryCountry` | Reads `user_profiles.secondary_country`, currently always NULL in DEV (0/344) | Correct as designed, just unreachable today given no UI ever writes this field | LOW (dormant, not broken) |

## Forecasting (`lib/services/forecastData.ts`, `lib/engines/forecast/assumptions.ts`, `lib/engines/forecast/*Calculator.ts`)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| `forecast_global_assumptions` cascade (`resolveAssumptions()`) | 4-tier: scenario override → profile override → `country_code`-matched row → `country_code IS NULL` global row. Country tier is skipped entirely (not defaulted to AU) when `countryCode` is null | Correct — matches spec s.25's explicit requirement exactly | LOW |
| `forecast_profiles.country_code` sourcing | Copied once from `country_of_residence` at profile creation (`?? null`, never `?? 'AU'`) | Correct at creation time; **however, once created, a `forecast_profiles` row is never re-synced if the user's `country_of_residence` later changes** — see `09-cross-border-model.md` §4 | MEDIUM — not a silent-AU-default bug, but a country-change staleness gap: a forecast profile created while AU-resident keeps using AU assumptions forever unless something explicitly re-derives it after a country change (no such re-derivation code path was found) |
| `base_currency` default (`forecastData.ts:50`, `?? 'AUD'`) | Currency default, not jurisdiction, but adjacent | Should this default to a currency matching the user's actual `country_of_residence` when `preferred_currency` is unset, rather than always AUD? | LOW–MEDIUM (cosmetic/display risk only — does not affect country-specific *assumption* selection, which correctly uses `country_code` separately) |
| Retirement/withdrawal-rate/life-expectancy assumptions | Country-keyed rows exist for both AU and IN with materially different values (retirement age 67 vs 60, life expectancy 87 vs 75 — migration `0014`) | Correct — genuinely differentiated, not copy-pasted placeholders | LOW |

## Investment Intelligence — India Tax & Cost (R6 CGT/FIFO/grandfathering engine)

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---| ---|
| Report inclusion (`reportSnapshotResolver.ts:119-127`, `taxAndCost: ReportTaxData \| null`) | Explicitly gated "India-only", returns `null` (not fabricated zeros) when not applicable | Correct, matches spec s.26/s.39-40 exactly | LOW |
| No equivalent AU CGT engine exists | N/A — confirmed absent, not a defect in what exists, just an acknowledged gap re-confirmed from the prior SMSF closure report | Future scope decision, not urgent | LOW (documented gap, not a live risk) |

## Reports — Free/Premium/Exports (`lib/services/reportSnapshotResolver.ts` and downstream section builders)

Reviewed the resolver itself in full; the individual section-builder/template files (`components/reports/**`, any `reportSections*.ts`) were **not** individually traced end-to-end in this pass (time-budget constraint, spec s.5's own instruction to search rather than read every file). **This is a disclosed residual gap, not a claimed clean result** — recommend a dedicated Wave 6 sweep of report template copy for AU-only terminology leaks (e.g. "Superannuation", "ATO", "HECS") appearing unconditionally regardless of the report subject's country.

## FDH — Bank Adapters / Classification

| Input/Rule | Current Jurisdiction Dependency | Correct Basis | Risk |
|---|---|---|---|
| Statement upload/adapter selection | None — no `country_of_residence` check anywhere in the upload path | Correct — a user's home jurisdiction must never gate which bank format they can upload (spec s.27) | LOW |
| `fdh_categories/subcategories.country_applicability` | Present in schema/validation, defaults `['AU','IN']` on every row — non-discriminating in practice | Dormant, same as `goal_types` — no current risk, no current benefit | LOW |

## Defect Remediation Specifications (spec §11 — JA-D1 and JA-D2, documented here, NOT implemented)

Both defects below are confirmed genuine (re-verified 2026-08-27: `git diff origin/main` for both files is empty — neither file has changed since the discovery baseline, and both lines cited are byte-for-byte as originally found). **Neither file was touched in this closure task** (hard rule). This section defines the bounded future remediation each requires, per Decisions PO-4 and PO-6.

### JA-D1 — Financial Twin silent AU fallback (`lib/services/twinData.ts:126`)

| Requirement | Specification |
|---|---|
| Correct future input source | `getUserHomeCountry()` (`lib/services/jurisdiction.ts`) — the same canonical resolver every other correctly-behaving module uses. Never re-derive from `profile?.country_of_residence` inline with a fallback operator. |
| Unresolved-country response contract | Return a distinguishable "comparison unavailable — country not confirmed" state, not a benchmark computed against any cohort. Never a fabricated zero, never a silently-assumed-AU comparison. |
| UI behaviour | Twin/Benchmark UI must render an explicit "confirm your country to see this comparison" prompt in place of a cohort chart when the state above is returned — not a blank chart, not an AU chart with no disclosure. |
| API behaviour | The underlying API/service must return the same distinguishable unavailable-state contract to any caller (including a direct API call), not just suppress it in one UI component — mirrors the existing fail-closed pattern already proven for SMSF's server-side gate. |
| Global-cohort conditions | A global (country-agnostic) cohort may be used **only if** a genuine, supported, and separately certified global cohort exists (i.e. its own income-band/peer-matching logic, reviewed and tested the same way the AU/IN cohorts were) — not as a silent default in place of the current AU default. This closure does not certify one; none exists today. |
| Logging/telemetry | Any telemetry recording "user hit unresolved-country twin state" must not include personally-identifying data — aggregate counts only, consistent with this closure's own `05-live-dev-usage-audit.md` methodology. |
| Positive AU test | Confirmed-AU user's benchmark cohort/output must be byte-identical before and after the fix (regression proof required). |
| Positive IN test | Confirmed-IN user's benchmark cohort/output must be byte-identical before and after the fix (regression proof required). |
| Missing-country negative control | A user fixture with `country_of_residence = NULL` must receive the unavailable-state contract, not an AU-cohort result — the core proof this fix actually works. |
| Unsupported-country test | A raw/forged non-enum country value (bypassing the `z.enum(['AU','IN'])` validated path) must also resolve to the unavailable-state contract via `getUserHomeCountry()`'s existing `isKnownCountry()` guard — not a crash, not a silent AU default. |
| Historical-output considerations | Any previously-generated report or snapshot that embedded a Twin comparison computed under the old silent-AU-default behaviour is not retroactively regenerated or flagged as wrong — historical snapshots preserve the jurisdiction context in effect when they were generated (Decision PO-6/Reports). |
| Rollback boundary | The fix is scoped to `twinData.ts`'s country-resolution line and its immediate callers' handling of the new unavailable state — it must not touch `annualGrossIncomeToIncomeBand()`'s own AU/IN band logic, which is correct and unaffected. |
| Objective exit criteria | (1) Positive AU/IN regression tests pass unchanged; (2) missing-country negative control returns the unavailable-state contract, not an AU result, for a real DEV fixture with `country_of_residence = NULL`; (3) unsupported-country test passes; (4) no report/snapshot regression; (5) code review confirms zero remaining `?? 'AU'`-shaped fallback anywhere in the Twin call chain. |

### JA-D2 — Resilience currency-derived country (`lib/engines/resilienceStress.ts:84`)

| Requirement | Specification |
|---|---|
| Correct future country input | The caller's already-resolved `country_of_residence` (via `getUserHomeCountry()`), threaded into `resilienceStress.ts` the same way `resilienceCalculator.ts`/`forecastData.ts` already fetch it for their own purposes — this is a threading fix, not a new data-fetch. |
| Why currency cannot determine home country | `preferred_currency`/`base_currency` is an independently-set display/reporting preference (§8, `01-canonical-architecture.md`), not a jurisdiction proxy — a household can legitimately hold `AUD` while resident in India, or vice versa (this is the exact scenario the current code silently mishandles). |
| Handling of confirmed AU | Use `country_of_residence = 'AU'` directly; must produce byte-identical stress-test output to today for any AU-resident household whose `preferred_currency` also happens to be AUD (the common, currently-passing case). |
| Handling of confirmed IN | Same, symmetric, for IN/INR. |
| Handling of unresolved country | Must not silently default to either `'AU'` or `'IN'` — the foreign-holdings stress filter should either skip the home/foreign split entirely for an unresolved-country household (treating all holdings identically) or return the same distinguishable "unavailable" contract used in JA-D1, a Product Owner call at implementation time, not an engineering default. |
| Handling of cross-border holdings | Unaffected in kind — the filter's job (holdings whose own `country_code` differs from home country) is unchanged; only the *home country* input source changes from currency to the canonical resolver. |
| Core scoring remains global | Reaffirmed per Decision PO-6 — this fix corrects the foreign-holdings filter's input source only; it does not add any new country-specific safety-net or scoring assumption to Resilience's core score. |
| Identical-output regression test | For any household where `country_of_residence` and `preferred_currency` were already aligned (AU+AUD, IN+INR — the majority live-DEV case), stress-test output must be byte-identical before and after the fix. |
| Mismatch regression tests | Two new required test fixtures: AU-resident with INR preferred currency, and IN-resident with AUD preferred currency — both must show the *corrected* (currency-independent) home/foreign split after the fix, proving the current inverted/incorrect behaviour is actually gone, not just theoretically described. |
| Historical-report protection | Same rule as JA-D1 — a previously-generated Resilience report/snapshot using the old currency-derived logic is not retroactively regenerated (Decision PO-6/Reports). |
| Rollback boundary | Scoped to the single home-country derivation line and its immediate use in the foreign-holdings filter — must not touch `investmentByCountry` concentration scoring (already correct, generic, unaffected) or any other Resilience sub-score. |
| Objective exit criteria | (1) Aligned-currency regression identical pre/post; (2) both mismatch fixtures produce the corrected split; (3) unresolved-country handling matches whichever Product-Owner-approved contract is chosen at implementation time (fail-closed either way — never a guessed AU/IN default); (4) no historical-report regression; (5) code review confirms zero remaining `currency === 'AUD' ? 'AU' : 'IN'`-shaped derivation anywhere in the Resilience call chain. |

**Both fixes are explicitly scoped narrowly (spec §11's own instruction): do not bundle unrelated Resilience or Financial Twin scoring redesign into either fix.** Both remain unfixed at the end of this closure — this is not a closure blocker (spec §16 explicitly excludes "the two confirmed defects remain unfixed" from the blocker list).
