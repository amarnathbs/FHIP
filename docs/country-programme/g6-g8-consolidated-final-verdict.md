# G6–G8 Consolidated Final Verdict and Handoff

Per the master spec's own page 274 template (`FHIP_G6-G8_Master_Execution_Prompt_250_Plus_Pages.md`).

**Updated 2026-09-12** to reflect that all 17 specified fixes named in this document's original version have since been implemented, tested, typechecked, and built clean. The verdict below is revised accordingly — still **CONDITIONAL PASS**, not FULL PASS, for reasons explained in full below (live-DEV verification and production migration remain outstanding, and the master spec's own rule requires both, not just code+tests, for a FULL PASS claim).

---

## Permitted terminal verdicts — actual result

The master spec permits exactly three FULL PASS strings and states its own governing rule plainly: **"A phase must use CONDITIONAL PASS or FAIL whenever its own exit condition or a predecessor production prerequisite remains incomplete. Documentation or compilation alone never earns FULL PASS."**

- **G6 — CONDITIONAL PASS.** Discovery (28/28), Ownership Decisions (28/28), Data-Contract Specification (all 28, 10 real contracts + 18 correctly N/A), and Threat Model (7/7) were completed first. **All 10 specified contracts have since been implemented and unit-tested** (see "Implementation status" below). What remains outstanding for `G6 FULL PASS — CROSS-BORDER FRAMEWORK RECONCILES AND PRESERVES SOURCE LINEAGE`: two new migrations (`0138`, `0139`) are still held locally, never applied to DEV or production; and no live-DEV run has exercised any of the 10 contracts against a real database. Per the master spec's own rule, code-plus-unit-tests alone still does not earn FULL PASS while those two things remain true.
- **G7 — CONDITIONAL PASS.** Discovery (28/28), Ownership Decisions (28/28), and Data-Contract Specification (the master spec's own literal 13-topic scope for this phase, 6 real contracts + 7 N/A) were completed first. **All 6 specified contracts have since been implemented and unit-tested.** No migration is owed for G7 (all 6 contracts are application-code-only). What remains outstanding: no live-DEV run has exercised report generation, the locale fix, or the recommendation-matcher coverage against a real database/report pipeline. `G7 FULL PASS — REPORTS, RESOURCES AND DISCLOSURES ARE GEOGRAPHICALLY VALID` is not yet earned for the same live-verification reason as G6.
- **G8 — CONDITIONAL PASS.** Discovery (28/28), Ownership Decisions (28/28), and Data-Contract Specification (the master spec's own literal 9-topic scope, 1 real contract + 8 N/A) were completed first. **The one specified contract has since been implemented and unit-tested.** More significantly, two of G8's own ownership decisions (§G8.055 controlled-cohort rollout, §G8.054 SEO scope) still explicitly require a Product Owner ruling this pass could not make unilaterally, and remain unresolved — `G8 FULL PASS — COUNTRY PROGRAMME CERTIFIED AND CONTROLLED ROLLOUT COMPLETE` cannot be claimed while G8's own namesake capability (a controlled, non-100%-instant rollout mechanism) still does not exist anywhere in the codebase, unchanged since this document's original version.

**This is not a failure of the work done — it is an honest description of what kind of work has and hasn't happened yet.** Real code, real unit tests, a clean typecheck, and a clean production build now exist for every one of the 17 specified fixes. What still hasn't happened, for any of them, is: application of the two held-locally migrations to any real database, and live-DEV verification of the resulting behaviour against real data. The master spec's own rule requires both before a FULL PASS claim, and this report does not shortcut that requirement just because a large amount of real engineering work is now behind it.

---

## Implementation status — all 17 fixes (2026-09-12)

Implemented on `feature/lr-1-upload-security-lifecycle` across 15 commits (`ee86c71`..`d56f3be`), all pushed to `origin`. **Not merged to `main`** — held pending an explicit merge/deploy decision, same discipline as every other non-hotfix feature branch in this repository.

### G6 — NRI and Multi-Country Framework (10/10 contracts)

| # | Contract | What changed | Commit |
|---|---|---|---|
| 1 | Widen `country_code` on assets/liabilities/investments/retirement_accounts | Zod enum widened from `['AU','IN']` to all 6 authoritative country codes; no DB migration needed (no CHECK narrower than the existing FK) | `ee86c71` |
| 2 | New `country_code` column on income/expense/insurance | New migration `0138` (3 nullable columns, held locally); Zod schemas updated | `dd9d4df` |
| 3 | FX-rate lineage on `financial_snapshots` | New migration `0139` (`fx_rate_aud_inr`, `fx_rate_date`, held locally); `loadDashboard()`'s upsert populates both at write time | `2f85d9f` |
| 4 | `isDomesticRecord()` shared helper | New pure function in `jurisdiction.ts`; replaces 2 independent inline comparisons in `resilienceStress.ts`/`reportSectionsPremium.ts` — zero behavioural change, confirmed by construction | `ee86c71` |
| 5 | Converted per-country net-worth field | `DashboardSummary.netWorthByCountryConverted` — additive, currency-converted view alongside the existing unconverted per-country rollups | `1d5c2bc` |
| 6 | Goal-funding cross-currency conversion | `computeLiveLinkedFundingValue()` now converts a percentage-based funding source through `convertToReportingCurrency()` when the linked record's currency differs from the goal's own — closes a real defect (a foreign-currency balance was previously credited at face value with no conversion) | `9aeaea3` |
| 7 | Wire `CROSS_BORDER` capability into its bypassing route | `cross-border-relationships` routes migrated onto `requireModuleCapability()`; a genuine regression (would have blocked GENERIC-experience users while G4 stays off) was caught and fixed via a new `allowGenericWhenG4Off` option | `da281d3` |
| 8 | Preview route's real cross-border check | Replaced a hardcoded, never-checked `cross_border_relationships_retained: true` with a real count query; deliberate breaking field rename (no live UI consumer existed to update) | `68d9cc9` |
| 9 | NRI-disclaimer `country_of_residence` cross-check | A self-declared "resident" taxpayer type is no longer trusted blindly when `country_of_residence` disagrees — extracted into a new, directly-tested pure function | `c49151c` |
| 10 | `secondary_country` readers migrated to `cross_border_relationships` | `twinData.ts` and `financialContextObject.ts`'s cross-border signal now uses a real active-relationship count instead of the legacy, narrower `secondary_country` field | `50a1151` |

### G7 — Reports, Resources and Disclosures (6/6 contracts)

| # | Contract | What changed | Commit |
|---|---|---|---|
| 1 | Report header country context | `reports.country_scope` now resolved from `source.profile.countryOfResidence` at generation time instead of a fixed `'household'` literal. **Deviation from the spec's own illustrative snippet, caught and fixed**: the column is `NOT NULL DEFAULT 'household'` — a literal `?? null` fallback (as the spec sketched) would have broken report generation for any GENERIC-experience user; falls back to `'household'` instead | `e9ee3f3` |
| 2 | Reporting currency and date locale | New shared `localeForReportingCurrency()` helper replacing 5 independently-hardcoded `'en-AU'` literals (the spec's own doc undercounted at 4) | `e9ee3f3` |
| 3 | Cross-border sections shared eligibility function | New `hasCrossBorderEligibility()`, replacing 2 independent inline `>1`/`<=1` threshold checks | `1f43417` |
| 4 | Consolidated sections `limitationText` | net_worth/cash_flow/executive_summary now carry an additive cross-border blending caveat when `countriesInUse.length > 1` | `3429a94` |
| 5 | Historical report snapshots FX/country provenance | `report_snapshots.snapshot_metadata_json` gains `fxRateAudInr`/`fxRateDate`/`countryOfResidence` at generation time — no schema change, existing JSONB field | `2af3edf` |
| 6 | Recommendation applicability | Doc-string correction (28 confirmed AU/IN-only-triggering condition rows, by design) plus new direct unit-test coverage of the matcher's country-conditional branch, a previously confirmed zero-coverage gap | `9d4c4c9` |

### G8 — Certification and Controlled Rollout (1/1 contract)

| # | Contract | What changed | Commit |
|---|---|---|---|
| 1 | Fix "not IN becomes Australia" currency-mismatch copy | `FinancialDataGrid.tsx`'s currency-mismatch warning now uses the canonical `COUNTRY_LABELS` map instead of a two-way ternary that could only ever say "India's" or "Australia's" — confirmed currently inert (only reachable for AU/IN today) but genuinely correct for any future country | `d56f3be` |

### Verification evidence (all personally observed, this session)

- `npx tsc --noEmit`: clean after every commit.
- `npm run build`: clean.
- Full `npx vitest run`: 6432 passed, 2 failed, 5 skipped — both failures confirmed pre-existing and unrelated to this work (one flaky negative-control test unrelated to country/G6-G8 code; one stale test assertion from an earlier, separate LR-9 feature, predating this session's G6-G8 implementation turn — flagged separately for its own fix, not part of this programme).
- Two real regressions were caught and properly fixed during implementation, not worked around: G6 Contract 7's GENERIC-user blocking risk (new `allowGenericWhenG4Off` option, plus the resulting test-completeness guard re-pointed at the new mechanism rather than just shrunk); G7 Contract 1's NOT NULL constraint violation risk (illustrative spec snippet corrected before shipping).
- Two new migrations held locally, applied nowhere: `0138_g6_contract2_country_code_columns.sql`, `0139_g6_contract3_snapshot_fx_lineage.sql`.

---

## Final numerical summary

| Field | Value |
|---|---|
| Branch | `feature/lr-1-upload-security-lifecycle` |
| Base SHA (before the G6-G8 discovery/decision pass) | `1cafce3` |
| SHA at original (documentation-only) verdict | `c341bc2` |
| SHA at end of 17-fix implementation | `d56f3be` |
| Migrations prepared this pass | 2 (`0138`, `0139`) — held locally |
| Migrations applied (DEV/production) | 0 |
| Countries live-tested | 0 — all verification to date is unit-test/typecheck/build, not live-DEV |
| Unit/integration tests added for the 17 fixes | Dedicated new test files/cases per contract (see each commit); full suite 6432 passed / 2 pre-existing-unrelated failed / 5 skipped |
| Production build run | Yes — clean |
| Live DEV cases | 0 for any of the 17 fixes specifically |
| Live production cases | 0 |
| Synthetic residue | 0 |
| Push/merge/deployment status | All 15 implementation commits pushed to `feature/lr-1-upload-security-lifecycle` — **not merged to `main`** |
| Remaining blockers | See below |

---

## Remaining blockers, in priority order

1. **Apply and live-verify the two held-locally migrations** (`0138`, `0139`) — DEV first, then production, each independently re-verified, matching this session's own established discipline for every prior schema change (e.g. the LR programme's own migration `0136`/`0137` sequence).
2. **Live-DEV verification of all 17 fixes** against real data — the master spec's own rule requires this, not just unit tests, before any FULL PASS claim. This is the single biggest remaining step between CONDITIONAL and FULL PASS for G6/G7.
3. **G8.054/G8.055 — two Product Owner scope rulings**, unchanged since the original verdict:
   - Is G2's landing localisation a visitor-experience-only feature (accept it is structurally invisible to search engines), or should it be extended to real crawlable per-country paths?
   - Does "controlled rollout" in this programme mean the current global-flag operating model, or does a real per-user/percentage targeting mechanism need to be built? (No such mechanism exists anywhere in this codebase today — `ai_model_registry.rollout_percentage` is the one unconsumed near-miss column.)
4. **G8.032/033 — confirm whether CloudFront-Viewer-Country header injection is actually live** on the production Amplify distribution. Cannot be verified from inside this repository.
5. **Decide `main` merge timing** for `feature/lr-1-upload-security-lifecycle`'s 17-fix work — a separate Product Owner call, independent of the live-DEV verification above (verification could reasonably happen before or after merge, per this session's own established per-change judgment).

---

## What is genuinely, durably done

- **G6, G7, G8 discovery**: 84 topics (28×3), each with real file:line citations.
- **G6, G7, G8 ownership decisions**: 84 topics, each with a stated canonical owner and an explicit decision.
- **Data-contract specifications, correctly scoped** to the master spec's own literal page-range structure at each phase (28 for G6, 13 for G7, 9 for G8).
- **All 17 specified fixes implemented, unit-tested, typechecked, and build-verified** — the update this document exists to record.
- **3 items remain correctly identified as Product Owner decisions, not engineering calls**, and are still not decided unilaterally anywhere in this pass.

## End of authorised programme

Per the master spec's own final instruction: **stop after G8. G9 or later is not invented here and is not authorised by this document.** Any further numbered phase requires a new, explicit Product Owner decision record defining its own scope, dependencies, exclusions, and acceptance criteria.
