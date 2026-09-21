# LR Entity Capability Matrix

## 2026-09-21 ADDENDUM

Re-checked directly against current `origin/main`, not relabelled:

- **Row 27, SMSF "Production readiness"**: update from "**NOT READY** — P0-1, P0-2" to **"P0-2 fixed (migration `0148`, confirmed on `origin/main`). P0-1 fixed for the reported double-subtraction scenario; the fixing engineer's own commit (`368d98f`) discloses one still-open architectural question (correctly correlating 'already netted inside a fund's own valuation' vs. 'not netted anywhere') that awaits a Product Owner ruling — see `LR_2026_09_21_RECONCILIATION_ADDENDUM.md`."** Not "READY" outright — the disclosed open question is real, not resolved.
- **§7 line "Entity liabilities NOT in personal DTI/DSR — PASS (structural)"**: re-read `lib/engines/dashboard.ts` and `householdContext.ts` this pass — the structural exclusion (business-entity tables never joined into `householdLiabilities`) is unchanged. Not re-run as a live oracle this pass (see the master addendum's Cannot-Verify register on the JS toolchain).
- **P2-15 (`/companies` missing from `NAV_HREF_MODULE_MAP`)**: re-checked directly — `grep -n "companies" lib/nav/appNavCapability.ts` still returns zero matches. **Unchanged, still open.**
- **Not covered by this matrix, and arguably should be from here on**: migration `0154` (2026-09-15) added a fifth `business_entities.entity_type`, `'huf'` (Hindu Undivided Family, India-only), under an explicit, separate Product Owner decision ("similar to family trust... all features of family trust need to adopt for HUF") — not an LR-11 requirement, not evaluated row-by-row against this matrix's capability columns in this pass, and per its own migration header carries **no production authority** as of 2026-09-15. Flagged so a future pass adds it as a sixth column rather than it silently riding on Family Trust's numbers.
- Migration `0136` (Family Trust)'s production-application status could not be re-checked this pass — production credentials were deliberately withheld (see Cannot-Verify register). Everything else in §2 below (the DEV-vs-PROD CHECK-constraint table) reflects the 09-14 finding, not a fresh 09-21 probe.

---

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
Rows and columns per Section 42.

---

## 1. The matrix

| Capability | Household | SMSF | Company | Family Trust | Child (discovery-only) |
|---|---|---|---|---|---|
| Income | **Yes** (`income_sources`, `/income`) | Partial — `owner='smsf'` tag on the household grid, then excluded from household cash flow | **Absent** | **Absent** | Absent (an `owner='child'` label only) |
| Expense | **Yes** (`expense_items`, `/expenses`) | Partial — same mechanism | **Absent** | **Absent** | Absent |
| Asset | **Yes** | **Yes** (`smsf_holdings`, 5 classes) | Partial — `label` + `value` + `currency_code` + `notes` only; no class, no country, no linkage | Partial (identical) | Absent |
| Investment | **Yes** | **Yes** | **Absent** — no investment concept in the entity schema | **Absent** | Absent |
| Liability | **Yes** | **Yes**, incl. `property_liability_links` | Partial — `label` + `value` only; no rate, no repayment, no term | Partial (identical) | Absent |
| Property | **Yes** (asset class + link) | **Yes** (`smsf_property_loan` link) | **Absent** — a property is a free-text label | **Absent** | Absent |
| Transaction ledger | **Yes** (`/financial-data-hub/activity`) | Absent | **Absent** | **Absent** | Absent |
| Bank import | Engine exists, **unreachable from any UI** (P1-7) | Absent | **Absent** | **Absent** | Absent |
| Contribution | **Yes** | **Yes** (`smsf_fund_members`) | **Absent** | **Absent** | Absent |
| Insurance | **Yes** | Partial — `owner='smsf'`, AU-gated in the UI | **Absent** | **Absent** | Absent |
| Forecast inclusion | **Yes** | **Yes** | Partial — value enters the forecast **baseline** only; no entity growth model | Partial (identical) | Absent |
| Reconciliation | **Yes** (FDH review/approve) | **Yes** ($0-variance mode-switch gate) — **but Detailed maintenance is broken, P0-2** | **Absent** — migration `0134:50-60` explicitly declines a variance gate | **Absent** | Absent |
| Report | **Yes** | **Yes** (`smsfReportData.ts`) | Partial / silent — value folds into `netWorth` and `totalAssetsCombined` but is **never itemised**; zero report code references entities | Partial / silent (identical) | Absent |
| Export | **Yes** | **Yes** (`smsfExport.ts`, CSV) | **Absent** — no entity export exists | **Absent** | Absent |
| Reachable in the UI | **Yes** | **Yes** (`/retirement`) | **Yes** (`/companies`) | **Yes** in the UI — **impossible in the production database (P1-1)** | n/a |
| **Production readiness** | Ready | **NOT READY** — P0-1, P0-2 | Ready, with P2-4 / P2-5 caveats | **NOT READY** — migration `0136` absent from production | n/a |

---

## 2. Family Trust — the headline

`app/(app)/companies/page.tsx:164-173` renders:
```tsx
<option value="company">Company</option>
<option value="family_trust">Family Trust</option>
```
and `lib/validation/businessEntity.ts:17` accepts `z.enum(['company','family_trust'])`.

The production database does not:

| `entity_type` | DEV CHECK | PROD CHECK |
|---|---|---|
| `company` | accepts | accepts |
| `family_trust` | accepts | **rejects (`23514`)** |
| `nonsense_type` | rejects | rejects |

Migration `0136_lr13_family_trust_entity_type.sql` was applied to DEV and **never to production**. Evidence: `scripts/audit-lr/a09_migration_reconciliation.mjs`, `a10_family_trust_prod_confirm.mjs`. Nothing was written by the probes.

A DEV authenticated journey confirms the other half: `POST /api/business-entities` with `entity_type:'family_trust'` returns **200** with a real row on DEV (`scripts/audit-lr/journey1_reports_and_premium.ts`). So the feature is complete and working everywhere except where it matters.

**Trust ownership semantics.** The audit brief warns against inventing legal semantics. None were invented, and none exist: Family Trust reuses Company's `ownership_percentage` model verbatim (the "Option A" design). There is no beneficiary model, no distribution model, no unit/appointor concept. Whether ownership-percentage is the right abstraction for a discretionary trust is a **Product Owner and legal question this audit deliberately does not answer**.

---

## 3. Net Worth consolidation — verified

`lib/engines/businessEntityValuation.ts:76-84`:
```ts
return rows
  .filter((r) => r.entity.is_active)
  .reduce((sum, r) => sum + (r.entity.ownership_percentage / 100) * computeBusinessEntityNetAssetValue(r, reportingCurrency, fxRateAudInr), 0);
```
Applied once, at `lib/engines/dashboard.ts:771` and `:781`.

Live-proven (`oracle3` T2): a 50%-owned entity with 400,000 assets and 100,000 liabilities, plus a 100,000 personal asset → `businessEntityOwnershipValue = 150,000`, `netWorth = 250,000`. Correct.

| Invariant | Result |
|---|---|
| Value added = ownership% × (entity assets − entity liabilities) | **PASS** |
| Percentage applied per entity before summing | **PASS** |
| Entity liabilities NOT separately subtracted from household Net Worth | **PASS (structural)** — `business_entity_liabilities` is never read by `dashboard.ts` |
| Entity liabilities NOT in personal DTI/DSR | **PASS (structural)** — both ratios derive from `householdLiabilities`, built from `input.liabilities` only |
| Entity cash flow NOT in personal surplus | **PASS (structural)** — no entity cash-flow concept exists |
| Net Worth breakdown reconciles | **FAIL (P2-4)** — `netWorthAllocation` sums to 100,000 against `totalAssetsCombined` 250,000; the entity value has no bucket |
| The figure is visible to the user | **FAIL (P2-4)** — `businessEntityOwnershipValue` has zero consumers in `app/` or `components/`; net worth changes with no line item |

The structural exclusion is the strongest available form and is genuinely achieved. The traceability is not.

---

## 4. Legacy owner tags — the real double-count risk

`lib/constants.ts:67-76` still carries all eight owner values, including `company` and `family_trust`.

| Layer | Restriction on `owner='company'` / `'family_trust'` |
|---|---|
| Grid `<select>` | **Hidden for new rows** (`FinancialDataGrid.tsx:281-289`, `:958`) — but an existing row keeps the option and can be re-saved indefinitely |
| Display | Marked `" (Legacy)"` (`lib/constants.ts:113-117`) |
| Zod validators (all 7 registers) | **No restriction** — every one accepts the full `OWNER_VALUES` enum |
| API routes | **No restriction** — a direct `POST /api/assets` with `owner:'company'` succeeds |
| Database CHECK (`0004`) | **No restriction**; neither `0134` nor `0136` narrows it |
| Engine treatment | **Counted as household** — `householdContext.ts:60-65`: "Company and family_trust are knowingly left as household context here: LR-FI-1 §19 defers their entity semantics" |

So a user who tags a liability `owner='company'` **and** records that company in `/companies` double-counts it — and asymmetrically: the grid row's balance enters `totalLiabilities` and its repayment enters personal DTI/DSR, while the entity workspace's own liabilities enter neither.

Recorded as P2-5. Closing it requires either server-side enforcement or finishing the entity semantics LR-FI-1 §19 deferred.

---

## 5. Child entity — discovery-only status intact

**Confirmed: no child-entity financial model exists.** The only traces of "child" are an unused `owner` enum value, a `relationship` enum on household members, and a label mapping in `publicationLogic.ts`. No child table, route, page, validator or valuation path. Nothing accidental was found.

---

## 6. RLS and database backstops

`supabase/migrations/0134_lr11_business_entity_registry.sql:146-159` enables RLS on all three tables with one `FOR ALL` policy each, `auth.uid() = user_id` on both `USING` and `WITH CHECK`. The two child tables additionally cross-check the parent's ownership in `WITH CHECK`, which correctly blocks attaching a row to another tenant's entity by guessing its UUID.

**Live-proven** (`scripts/audit-lr/oracle6_security_deletion_residue.ts`, two real authenticated users):

| Attempt by user B against user A's rows | Result |
|---|---|
| SELECT `business_entities` | 0 rows — ISOLATED |
| SELECT `business_entity_assets` | 0 rows — ISOLATED |
| SELECT `business_entity_liabilities` | 0 rows — ISOLATED |
| UPDATE A's entity | 0 rows affected — ISOLATED |
| DELETE A's entity | 0 rows affected — ISOLATED |
| **Positive control: A reads its own row** | **1 row — control OK** |

The positive control matters: it proves the zeros above are isolation, not a broken policy blocking everyone.

**Gap (P2-14):** these tables were created by `0134`, after the MCC backstop migrations `0104`/`0105`/`0108`, and were never retrofitted with `is_country_confirmed()`. `is_write_permitted()` (`0129`, G5B) is likewise not applied. Country confirmation for entities is enforced **only at the API layer** — the exact defence-in-depth layer the G8 closure relied on when reasoning about a GENERIC user's direct database access.

---

## 7. Capability-layer and navigation findings

- `/companies` is linked once, from `components/ui/AppShell.tsx:79` ("Companies & Trusts", in "Your finances"), which feeds both the desktop sidebar and the mobile drawer. No dashboard tile, no cross-link. No entity page is unreachable.
- **P2-15:** `/companies` is missing from `NAV_HREF_MODULE_MAP` (`lib/nav/appNavCapability.ts:23-55`). `isNavHrefVisible` returns `true` unconditionally for an unmapped href, so this is the one nav item outside G4's fail-closed visibility model. The completeness test that exists to catch exactly this drift (`tests/unit/appNavCapability.test.ts:22-61`) compares the map against a hand-maintained literal array **that has the same omission**, so it passes while the drift it guards against is present.
- The `BUSINESS_ENTITIES` capability is declared in `lib/services/appCapability.ts:401-416` but `requireModuleCapability` is never called on any `app/api/business-entities/**` route or on the `/companies` page — compare `app/api/insurance/route.ts`, which does. The declared capability is unenforced at nav, page, API and DB. Containment for GENERIC users survives only via `proxy.ts`'s allowlist omission — a single middleware-layer defence.
- Entity creation never sends `country_code` (`page.tsx:96-103`), so every entity is created with `country_code = NULL`, while the currency selector offers only AUD/INR — which sits awkwardly against the manifest's "universal" classification.

## 8. Entity income / expenses / transactions / reports / exports

**Absent — all five, plainly.** The entity schema is three tables, and the two child tables carry only `label`, `value`, `currency_code`, `notes`. There is no entity income table, expense table, transaction ledger, bank import, report module, or export — in contrast to SMSF, which has both `smsfReportData.ts` and `smsfExport.ts`.

Functionally, a Company or Family Trust in FHIP today is **a single net-worth number with an optional two-column line-item breakdown.** If the original LR-11 requirement included entity income/expenses, entity import, or entity reports, that scope is not implemented. The LR-11 phase report records WP-07 (entity-tagged transaction ingestion) and WP-08 (entity reports) as explicitly deferred — see `LR_DEFERRED_SCOPE_RECONCILIATION.md`.
