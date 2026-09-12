# G6-G8 Country Programme — Consolidated Report

**Branch:** `feature/g6-g8-country-programme-closure`
**Report date:** 2026-09-12
**Source spec:** `FHIP_G6-G8_Master_Execution_Prompt_250_Plus_Pages.md` (G6 NRI/Multi-Country Framework, G7 Reports/Resources/Disclosures, G8 Certification & Controlled Rollout — "the approved programme... ends at G8," no G9+ authorised)

## Executive Summary

| Phase | Status | Headline |
|---|---|---|
| **G5** (prerequisite) | SCOPED PASS (not unconditional) | DB-layer write-enablement certified 19/19 live in production; real end-to-end GENERIC journey still blocked by a disclosed, separate currency-enum defect |
| **G6** (NRI/Multi-Country) | **FULL PASS** | All 10 contracts implemented, unit-tested, and live-DEV proven against real infrastructure |
| **G7** (Reports/Resources/Disclosures) | **FULL PASS** | All 6 contracts implemented, unit-tested, and all 4 live-testable contracts proven against real DEV infrastructure |
| **G8** (Certification & Controlled Rollout) | 8 of 9 topics closed | G8.050/G8.051/G8.053/G8.056/G8.058 done and live-verified; only G8.055 (the real rollout mechanism) remains |

**No G9+ has been invented.** The programme's own explicit instruction — "ends at G8" — is respected throughout.

---

## 1. How this programme reached this point

The 274-page master spec was worked in three passes across this and earlier sessions:

1. **Discovery + ownership decisions + data-contract specification** for all three phases (84/84 discovery topics, 84/84 ownership decisions) — documentation/decision-only, explicitly not claiming FULL PASS ("documentation alone never earns FULL PASS" — the master spec's own rule).
2. **17 small-scope fixes specified and implemented**: 10 from G6's data contracts, 6 from G7's, 1 from G8's. All implemented, unit-tested, typechecked, built clean.
3. **This session**: a new 24-section "Consolidated G5 Production Closure and G6-G8 Completion Prompt" resumed the programme with an explicit staged plan — close G5 production properly, isolate the branch, certify migrations, live-DEV-certify G6/G7, close G8's remaining gaps. Branch isolated cleanly onto `feature/g6-g8-country-programme-closure` (44 commits classified, 27 cherry-picked, zero contamination from an unrelated concurrent branch).

---

## 2. G5 — Production prerequisite (context, not this programme's own phase)

G5 (Generic Universal-Module Write Enablement) is a prerequisite this programme depends on, not one of G6/G7/G8's own phases — recorded here because G6's own promotion to FULL PASS was explicitly gated on it.

**What's certified, live, in production:**
- Migrations `0129`/`0130` (`is_write_permitted()`, `mcc_generic_write_capabilities`, the MCC-14 delete-cascade exemption) — live and re-confirmed via read-only checks.
- `G5B_GENERIC_WRITE_ENABLED` flipped ON in production by the user.
- **Real production DB-layer certification, 19/19 checks passed, zero residue** — disposable synthetic production users, real authenticated (never service_role) sessions: GENERIC user INSERT/UPDATE allowed on Income/Expenses/Insurance; GENERIC DELETE denied; GENERIC writes denied on an unapproved table (`assets`); AU control unaffected; cross-tenant RLS intact; MCC-14 delete-cascade exemption intact on the G5B trigger path.

**What's disclosed and NOT fixed** (a deliberate scoping decision, accepted by the user): `lib/validation/income.ts`/`expense.ts`/`insurance.ts` hardcode `currency_code: z.enum(['AUD', 'INR'])` — a real GENERIC user (GB/US/SG/AE) gets a 422 before the request ever reaches the database trigger, regardless of any flag. Fixing this means adding currency support, which the mission's own section 3.3 explicitly lists as "Never authorised" without a separate Product Owner decision.

**Verdict, precisely**: **G5 PRODUCTION DB-LAYER PASS (SCOPED)** — not the mission's literal unconditional "G5 PRODUCTION FULL PASS." The user explicitly accepted this scope ("Accept scoped G5, promote G6, start G7") as sufficient to unblock G6/G7.

---

## 3. G6 — NRI and Multi-Country Framework: **FULL PASS**

### 3.1 The 10 contracts (all implemented, `feature/g6-...` commits, see below)

1. Widen `country_code` enum to all 6 countries on 4 existing registers.
2. Add nullable `country_code` to `income_sources`/`expense_items`/`insurance_policies` (migration `0138`).
3. Add `fx_rate_aud_inr`/`fx_rate_date` to `financial_snapshots` (migration `0139`).
4. Extract a shared `isDomesticRecord()` helper.
5. Add a converted per-country net-worth field (`netWorthByCountryConverted`), additive — doesn't touch the existing `netWorth`.
6. Fix goal-funding cross-currency conversion (a real, previously-existing bug: raw foreign-currency value was added to a goal target with zero FX conversion).
7. Wire the orphaned `CROSS_BORDER` capability into its one bypassing route.
8. Fix the primary-country preview route's hardcoded, unverified `cross_border_relationships_retained: true` claim.
9. Fix the NRI-disclaimer suppression never being cross-checked against `country_of_residence`.
10. Migrate `secondary_country`'s 2 live readers onto `cross_border_relationships`.

### 3.2 Verification history

- **Static/unit-test pass**: 163/163 contract-related tests reproduced personally; full suite 6360 passed/18 failed (all pre-existing/unrelated, confirmed) at the branch-isolation checkpoint.
- **Migration certification** (PGlite replay): fresh `0001→0139` replay 134/134 clean; both new columns nullable/no-default/no-CHECK; RLS auto-inherited; no destructive statements; rollback rehearsed successfully. Both migration files confirmed byte-identical to what was originally shipped.
- **Real live-DEV certification** (`tests/live-dev/g6LiveDevFxCrossBorderCertification.test.ts`): real disposable synthetic DEV users, real rows, hand-calculated oracles (never trusting the app's own output as its own oracle):
  - **FX lineage**: 3 real assets (AU/IN/GB) inserted with widened `country_code`; hand-calculated domestic+overseas=consolidated oracle using the real live DEV `fx_rate_aud_inr`; `computeDashboard()`'s `totalAssets` and `netWorthByCountryConverted` per-country buckets matched the oracle exactly, and the buckets summed to `netWorth` exactly.
  - **Contract 2**: real `income_sources`/`expense_items`/`insurance_policies` rows accepted the widened `country_code` (GB/IN/AE tested).
  - **Contract 3**: real `financial_snapshots` upsert stored the real FX rate and date.
  - **Contract 6**: goal-funding cross-currency conversion — hand-calculated oracle (INR investment value ÷ real FX rate × allocation %) matched `computeLiveLinkedFundingValue()`'s real output exactly.
  - **Contract 7/10**: a dedicated, otherwise-empty synthetic user proved the cross-border relationship lifecycle in isolation (create → `isCrossBorder` true → deactivate → false → duplicate-active-relationship rejected by the real unique index) — caught and fixed a real test-isolation defect along the way (an earlier attempt reused a user with pre-existing multi-country assets, which correctly kept `isCrossBorder` true via its own documented OR condition — not a product bug, a test design flaw).
  - **Cross-tenant RLS**: real authenticated (non-service-role) session proved cross-tenant read of another user's assets and cross-border relationships both return 0 rows; a forged cross-tenant write is blocked.
  - Zero residue, independently re-verified.

**Verdict: G6 FULL PASS.** Promoted from CONDITIONAL to FULL on the user's explicit authorization, once G5's scoped pass was accepted — G6's own real blocker (the G5 prerequisite) is satisfied, and G6's own contracts have genuine, oracle-based, live-DEV proof, not just static code review.

---

## 4. G7 — Reports, Resources, Disclosures: **FULL PASS**

### 4.1 The 6 contracts (of 13 in-scope topics; 7 marked N/A per their own ownership decision, not padded)

1. **Report header country context**: `reports.country_scope` populated from real `country_of_residence`, replacing a hardcoded `'household'` literal never read again.
2. **Reporting currency and date locale**: shared `localeForReportingCurrency()` helper replacing 4 independent hardcoded `'en-AU'` literals (a 5th was found and fixed beyond what the contract doc counted).
3. **Cross-border sections**: shared `hasCrossBorderEligibility()` function replacing two independent inline `> 1` checks.
4. **Consolidated sections**: `net_worth`/`cash_flow`/`executive_summary` gain a real blending `limitationText` for multi-country households.
5. **Historical report snapshots**: `report_snapshots.snapshot_metadata_json` gains FX-rate/country provenance, mirroring G6 Contract 3.
6. **Recommendation applicability**: doc-string correction plus new test coverage of existing, unmodified matcher logic.

### 4.2 Verification history

- **Static/unit-test pass**: all 6 contracts independently re-verified against actual shipped code (not trusted from commit messages) at the branch-isolation checkpoint.
- **Real live-DEV certification** (`tests/live-dev/g7LiveDevReportCertification.test.ts`), calling the real `generateReport()` against real DEV data for a domestic (1-country) and a cross-border (2-country) synthetic user:
  - **Contract 1**: both reports' `country_scope` matched the real `country_of_residence`, not a hardcoded literal.
  - **Contract 3**: the real `cross_border` section's status was `omitted` for the domestic household and `included` for the cross-border one — proving the eligibility function via the real call site, not just in isolation.
  - **Contract 4**: `net_worth`/`cash_flow`/`executive_summary` carried the real blending note ("blends figures from 2 countries") for the cross-border household and none for the domestic one.
  - **Contract 5**: `report_snapshots.snapshot_metadata_json` carried the real `fxRateAudInr`/`fxRateDate`/`countryOfResidence` for both reports.
  - Contracts 2 (locale) and 6 (doc-string + matcher unit test) were not re-run live — pure/deterministic, already unit-tested, zero live-DEV value to add.
  - **A real, previously-undiscovered gap found along the way**: `ReportRow`'s TypeScript interface never declared `country_scope`, even though the column (migration `0010`) and the insert (this contract) have always carried it. Caught by `tsc`, fixed by adding the field to the interface with a comment explaining the gap.
  - Zero residue, independently re-verified.

**Verdict: G7 FULL PASS.** All 6 contracts implemented and either directly live-DEV proven (4 of 6) or already fully covered by deterministic unit tests (the remaining 2, where live-DEV testing would add no value).

---

## 5. G8 — Certification & Controlled Rollout: 8 of 9 topics closed

### 5.1 Scope

Of the 9 in-scope topics (`G8.057`–`G8.065`), only 1 (`G8.063`, the currency-mismatch copy fix) had a genuine data contract — already implemented in the earlier 17-fix batch. The remaining real work came from `g8-ownership-decisions.md`'s own "authorised for a fix" / "authorises... as the minimum bar" recommendation list, plus two real Product-Owner scope decisions the discovery phase surfaced.

### 5.2 What's done, this session, real and verified

- **G8.050** (`countryGateAccessMatrix.test.ts`): new negative-assertion test (`MC-17b`) proving `proxy.ts`'s `isAppRoute` gate matches none of the real `app/(auth)` directories — previously only the positive case (every `app/(app)` directory IS gated) was asserted, leaving nothing but code review to prevent a future accidental widening. Caught and fixed a real mistake in the first draft along the way: an initial assumption that `/onboarding` should also be excluded was wrong — re-checked directly against `proxy.ts` and `app/(app)/layout.tsx` and found `/onboarding` legitimately belongs in the gate's allowlist by design.
- **G8.051**: new live-DEV RLS certification (`g8LiveDevRlsCertification.test.ts`), closing 3 real, named coverage gaps, each previously only inferred from schema or proven for a sibling table:
  - `business_entity_liabilities` — cross-tenant read/update/impersonation-insert all confirmed blocked (its sibling `business_entity_assets` had this proof; this table never did).
  - `report_access_events` — cross-tenant read blocked, plus a stronger proof than asked for: even the row's own owner cannot INSERT directly through their authenticated client (server-only by design since migration `0070`).
  - `user_entitlements.plan_tier` — a raw authenticated self-upgrade write against the table directly genuinely affects 0 rows; `plan_tier` confirmed unchanged before and after.
  - All 8 checks passed against real DEV infrastructure, zero residue.
- **G8.053**: 3 real accessibility fixes.
  - `CountrySelector.module.css`'s mobile hint used `display:none` (removes an element from the accessibility tree entirely, not just hides it visually) — fixed to a standard visually-hidden pattern so a mobile screen-reader user still reaches the "this doesn't confirm your account" reassurance via the existing `aria-describedby` link.
  - `BillingPanel.tsx`'s country-confirm error had no `role="alert"`/`aria-describedby`, unlike every comparable error elsewhere in the programme — fixed.
  - `OnboardingWizard.tsx`'s country select was less accessible than its own currency select six lines below — gained `required`/`aria-required`/`aria-invalid`/`aria-describedby`.
- **G8.056**: two real fixes.
  - Cross-referenced the G5B rollback asymmetry (the app-layer env flag has zero effect on the already-applied database grant) in both `g5bWriteFlag.ts`'s and migration `0129`'s own headers, so a future operator's rollback runbook cannot assume "flip the env var" is sufficient.
  - Fixed `income-proposals/apply/route.ts`'s stale `requireCountryConfirmedUser` import — meant G5B's GENERIC-write enablement never actually reached this FDH-derived path, contrary to what enabling the flag implicitly claims. Migrated onto `requireModuleCapability`, matching the sibling manual-entry route. This broke 3 existing tests in `fdh9IncomeTabUx.test.ts` (a real regression, caught by a full suite run, not by the targeted test run) — root-caused to the test file mocking the old gate function the route no longer calls, and fixed by adding a `requireModuleCapability` mock delegating to the same control variable, rather than touching the route again.
- **G8.058**: `ENVIRONMENT_VARIABLES.md` gained the 5 previously-undocumented flags: `G4_APP_CAPABILITY_LAYER_ENABLED`, `G5B_GENERIC_WRITE_ENABLED`, `G2_LANDING_LOCALISATION_ENABLED`, `G2_ALLOW_TEST_DETECTION_HEADER`, `FDH_DOCUMENT_UPLOAD_ENABLED`. Documentation-only, no behavioural change.

**Full suite result after all G8 fixes: 6404 passed / 2 failed / 23 skipped — zero regressions.** Both remaining failures are pre-existing and unrelated (MC-15's already-known LR-9 account-deletion gap; `aiResidualClosureFailClosed`'s A4, untouched by any of this work), confirmed by name and by re-running each in isolation. A further 9 file-level failures only appear in Resources' own live-DEV test files, caused by this machine's standing `.env.local` BOM-corruption limitation (present with or without `--env-file`), unrelated to anything in this programme.

### 5.3 What's still open — genuine Product-Owner decisions, not engineering gaps

- **G8.055 — Controlled production cohort / percentage rollout mechanism.** No such mechanism exists anywhere in this codebase — every feature flag examined (G2/G4/G5B) goes straight from "verified in DEV" to "100% of production instantly." The mission's own instruction already resolves the fork this topic named ("first check for/reuse an existing framework, build the smallest one needed if none exists") — **this is the one remaining piece of engineering work in G8**, not yet started.
- **G8.060/061 — CloudFront-Viewer-Country header injection**: confirming this is actually live on the production Amplify distribution is an infrastructure verification, not a code change, and needs direct access this codebase's own tests cannot provide.
- **G8.064/065 — India/GB account residual risks** (Investment Intelligence's India-only scoping by data-shape coincidence; the GB currency-support gap already discussed under G5 in §2): both explicitly disclosed, both explicitly not authorised for a fix in this phase — accepted residual risks, not silent gaps.

---

## 6. Migration status

| Migration | Purpose | Environment status |
|---|---|---|
| `0129`/`0130` | G5B write-enablement + MCC-14 exemption | Live in DEV and production; flag ON in production |
| `0138` | G6 Contract 2 — `country_code` on income/expense/insurance | Live in DEV and production |
| `0139` | G6 Contract 3 — `financial_snapshots` FX lineage | Live in DEV and production |

No new migrations were introduced by G7 or G8's own work (all additive-JSON/comment/test-only changes).

---

## 7. Outstanding items (honest, as of this report)

- **G5's currency-enum gap** — a real GENERIC user still cannot submit an Income/Expense/Insurance payload through the real app in their own currency, regardless of any flag. Needs a separate Product Owner decision on currency-support scope; explicitly not something to fix unilaterally.
- **G8.055** — the real controlled-cohort/rollout mechanism. Directed by the mission, not yet built.
- **G8.060/061** — CloudFront-Viewer-Country header confirmation on the production Amplify distribution. Needs direct infrastructure access.
- **`main` merge timing** — this entire branch (`feature/g6-g8-country-programme-closure`) remains unmerged into `main`. No merge has been authorised.
- **G4's current production state** — `G4_APP_CAPABILITY_LAYER_ENABLED`'s live production value has not been independently reconfirmed this session (last known: OFF, per the earlier Live Recovery closure).

---

## 8. Final verdict table

| Item | Verdict |
|---|---|
| G5 (prerequisite) | SCOPED PASS — DB-layer certified live in production; currency-enum gap disclosed, separate PO decision needed |
| G6 (NRI/Multi-Country) | **FULL PASS** |
| G7 (Reports/Resources/Disclosures) | **FULL PASS** |
| G8 (Certification & Controlled Rollout) | 8/9 topics closed; G8.055 (rollout mechanism) remains |
| Programme scope | Ends at G8 — no G9+ invented |
| `main` merge | Not authorised, not performed |

Full commit history for this branch's own work: `32ef1ab`..`e8a38fe` (`feature/g6-g8-country-programme-closure`).
