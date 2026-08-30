# Deliverable 1 — Canonical Architecture Map

## 1. Authoritative home-jurisdiction source (spec s.4, independently re-confirmed)

**`user_profiles.country_of_residence`** is the sole authoritative source, confirmed by direct read-site tracing (not by trusting the SMSF closure report's own claim — every call site below was independently opened and read):

| Read site | File | Purpose |
|---|---|---|
| `getUserHomeCountry()` | `lib/services/jurisdiction.ts:34-44` | The one shared resolver — reads `country_of_residence`, returns `null` if unset/unrecognised (fails closed, never defaults to AU). |
| SMSF AU gate | `supabase/migrations/0084_geo_jurisdiction_smsf.sql:151` | DB trigger reads `user_profiles.country_of_residence` directly (`p.country_of_residence = 'AU'`), independent of the app-layer resolver — genuine defence-in-depth, not the same code path twice. |
| Financial Twin | `lib/services/twinData.ts:41,103,126` | Reads `country_of_residence` for peer-cohort segmentation. **Defect: silently defaults to `'AU'` when null** (see `04-calculation-dependency-matrix.md`). |
| Forecasting | `lib/services/forecastData.ts:41,51` | Copies `country_of_residence` into `forecast_profiles.country_code` at profile creation; never re-reads `user_profiles` afterwards (correct — `forecast_profiles.country_code` becomes its own working copy, consistent with the household/`primary_country` pattern below, but note this means a subsequent home-country *change* does not automatically update an existing forecast profile — see `09-cross-border-model.md` §4 country-change risk). |
| Reports | `lib/services/reportSnapshotResolver.ts:206,356` | Reads directly, `?? null` (fails closed, correct). |
| Recommendations | `lib/services/recommendationsData.ts` | Reads directly (confirmed via grep; not separately re-derived). |
| Retirement members | `lib/services/retirementMemberData.ts` | Reads directly. |
| Onboarding | `app/(onboarding)/onboarding/OnboardingWizard.tsx:140,154` | Writes `country_of_residence`, then copies the same value into `households.primary_country` in the same submit (one-way copy at onboarding time only). |
| Dashboard | `app/(app)/dashboard/page.tsx` | Reads directly (confirmed via grep). |

**`households.primary_country` is confirmed passive**, not a second source of truth:
- Only ever written once, at onboarding submission (`OnboardingWizard.tsx:154`), as a direct copy of `country_of_residence`.
- `lib/validation/household.ts` requires it (`z.enum(['AU','IN'])`) but no other code path in the app reads `households.primary_country` for a jurisdiction-logic decision (confirmed by grep across `lib/` and `app/` — its only other reader is display/reporting context, not gating).
- Live DEV re-confirms zero drift: of 244 households, **0 have `primary_country` different from their owner's `user_profiles.country_of_residence`** (see `05-live-dev-usage-audit.md`).

**Verdict: the SMSF release's own architecture claim holds under independent re-verification.** No change recommended.

## 2. Secondary/cross-border profile fields (new finding, not previously documented)

`user_profiles.secondary_country` exists as a schema column since the foundation migration (`supabase/migrations/0001_foundation.sql:22`) and is validated by `lib/validation/profile.ts:12` (`z.enum(['AU','IN']).nullable().optional()`), but has exactly **one reader in the entire codebase**: `lib/services/twinData.ts:127`, used only to widen the Financial Twin's peer-cohort tier. It is:
- Not read by the applicability resolver (`lib/services/jurisdiction.ts`).
- Not read by any catalogue/creation gate.
- Not surfaced anywhere in the current onboarding UI as an explicit "add a second country" flow (grep of `OnboardingWizard.tsx` shows no `secondary_country` write).
- Live DEV: 344/344 `user_profiles` rows have `secondary_country = NULL` — it is entirely unused in practice today.

This is the closest existing schema concept to a genuine "cross-border declaration" field, but it is dormant for applicability purposes exactly like `goal_types.country_applicability` and `fdh_categories.country_applicability` are dormant for filtering purposes (see §3). Cross-border applicability today is instead inferred implicitly, per-record, from each row's own `country_code` differing from the owner's home country (see `09-cross-border-model.md` §1) — there is no explicit user-facing "I have interests in a second country" toggle anywhere in the product.

## 3. Applicability infrastructure (spec s.8, s.46-47)

**A reusable resolver already exists and is genuinely reused, not duplicated** — this is the single most important finding for G0's "certify or design" mandate (spec s.46).

`lib/services/jurisdiction.ts` (added by the SMSF release, migration-adjacent, not itself a migration):

```ts
export type CountryCode = 'AU' | 'IN'; // only 2 countries known/enforced anywhere today

export async function getUserHomeCountry(userId, supabase): Promise<CountryCode | null>
// fails closed — never defaults; unresolved country is null, not 'AU'.

export function isItemAvailableForCountry(countryApplicability, country): boolean
// null/empty applicability = globally available to everyone, including an
// unresolved country. A non-null applicability array requires a resolved,
// matching country — an unresolved country is REJECTED against a
// restricted item (fail closed), matching the DB trigger's behaviour.

export async function assertItemCreationAllowedForUser(params): Promise<{allowed}|{allowed:false,reason}>
// server-side creation gate; reads master_financial_items.country_applicability
// directly, calls getUserHomeCountry() itself (never trusts a client-supplied country).
```

This is consumed by exactly one call site today — `lib/services/masterItems.ts:listMasterItems()` → `app/api/master-items/route.ts` — which is in turn the **single shared catalogue endpoint** behind `components/grid/FinancialDataGrid.tsx`, itself used by all 7 core catalogue-driven modules (`app/(app)/{assets,expenses,income,insurance,investments,liabilities,retirement}/page.tsx`). This is exactly the "one source of truth downstream layers consistently consume" the spec asks for (s.47) — **already built, not something G0 needs to design from scratch.**

**Certification status:** `tests/unit/jurisdictionApplicability.test.ts` (5 tests) directly unit-tests `isItemAvailableForCountry()`'s pure logic (null=global, fail-closed on unresolved country, empty array = global). Re-run in this task:

```
npx vitest run tests/unit/jurisdictionApplicability.test.ts
```
Result: **5/5 passed** (re-executed fresh in this task's worktree, not just cited from memory).

The live/DB-level half of the architecture (does a forged direct request actually get rejected; does an existing record actually survive a country change) has **only ever been proven for one product: SMSF** — 73/73 PGlite cert + 8/8 live-DEV cert, per the prior SMSF closure report. There is currently no second jurisdiction-specific product to cross-validate the pattern against, which is itself one of this report's disclosed gaps (see `08-testing-strategy.md`).

**No second/competing applicability registry was found anywhere in the codebase** (checked: FDH's own `country_applicability` on `fdh_categories`/`fdh_subcategories`/`fdh_classification_rules`, migration `0045`, and `goal_types.country_applicability`, migration `0009` — both use the *identical* `char(2)[]`, NULL-means-global convention as `master_financial_items.country_applicability`, and neither is independently enforced anywhere; they are dormant, not divergent). **Recommendation: reuse `lib/services/jurisdiction.ts`'s `isItemAvailableForCountry()` verbatim against these two dormant columns when/if they are ever activated — do not write a second predicate.**

## 4. ISO country codes (spec s.9)

Confirmed: the app uses ISO-3166-1 alpha-2 codes (`AU`, `IN`) consistently across every table and every TypeScript type found (`country_code char(2)`, `CountryCode = 'AU' | 'IN'`). **Only AU and IN are implemented or validatable anywhere** — `GB`, `US`, `SG`, `AE` (cited as illustrative examples in the spec) do not exist in any enum, zod schema, or catalogue constraint today. A `countries` table exists (referenced by `smsf_holdings.country_code` FK in migration `0084`) — this is the one place a genuinely open-ended country list already exists structurally; extending supported jurisdictions in the future should add rows there and to the `CountryCode` union / zod enums together, not introduce a third representation.

## 5. Server enforcement architecture (spec s.35)

Two independent enforcement layers exist today, and only for SMSF:

1. **API/service layer** — `assertItemCreationAllowedForUser()` is called from exactly one route: `app/api/retirement/route.ts` `POST` (lines 30-36), which gates every `retirement_accounts` creation (including SMSF, via the generic `FinancialDataGrid` → registry pattern) before it ever reaches the DB. Confirmed by direct read of the route — this is genuine, intentional defence-in-depth alongside the DB trigger, not a dead helper (an earlier draft of this doc understated this before re-checking; corrected here after grepping actual callers). **However, the other six catalogue-driven POST routes (`app/api/{assets,expenses,income,insurance,investments,liabilities}/route.ts`) do not call this gate at all** (confirmed absent by grep across all six) — because no item in those six categories is currently jurisdiction-restricted, there is nothing for them to gate today. This is correct for the *current* catalogue state but is a real architecture gap for future waves: **if a jurisdiction-restricted item is ever added to, say, `asset` or `investment` without also adding this same one-line call to that category's POST route (and, per SMSF's precedent, a DB trigger for the belt-and-braces case), nothing would stop a forged direct API/PostgREST request from creating it.** Recommend making this call a standard, checklist-enforced part of adding any restricted catalogue item (see `07-jurisdiction-standard.md`), rather than relying on each future developer rediscovering the SMSF precedent independently.
2. **DB trigger** — `trg_retirement_accounts_smsf_au_gate` (migration `0084`), the only DB-level enforcement in the entire app for jurisdiction. Fails closed via RLS-scoped lookup (a forged `user_id` for another tenant sees zero rows, treated as non-AU).

**Recommendation for future waves:** wire `assertItemCreationAllowedForUser()` into the generic catalogue-creation POST routes (one shared check, same pattern as `listMasterItems()` already achieves for reads) so future jurisdiction-restricted items get creation-time enforcement without each needing a bespoke migration-level trigger — reserve bespoke DB triggers for items with additional non-jurisdiction integrity rules (as SMSF's own trigger also happens to gate reactivation, which a generic check alone would not cover).

## 6. Calculation/presentation separation (spec s.11, s.41)

Confirmed structurally correct and already followed:
- `lib/engines/dashboard.ts` computes Net Worth and per-module totals from the full record set unconditionally — no `country_applicability` filter, no `country_of_residence` filter, anywhere in this file (confirmed by grep — its only "country" awareness is per-record `country_code` used to build `assetsByCountry`/`countriesInUse` breakdowns *alongside* the unfiltered totals, not to gate them).
- `master_financial_items.country_applicability` is explicitly documented in its own migration comment (`0084` line 106) as governing **creation/UI-offer filtering only**, never used to hide/delete/stop-counting existing rows.
- The SMSF DB trigger only fires on `INSERT` or reactivation `UPDATE` — editing an already-active SMSF row's other fields is never blocked regardless of current country (migration `0084` lines 140-150, confirmed by direct reading).

**No violation of "never use UI hiding to remove economic value" (spec s.11) was found anywhere in the codebase.**

## 7. Five canonical applicability classes (PRODUCT OWNER APPROVED 2026-08-27 — G0-JA-1 closure)

The discovery baseline's informal four-class model (`07-jurisdiction-standard.md` §2) is superseded by the Product Owner's five approved classes. This section is the single canonical definition; `07-jurisdiction-standard.md` has been updated to reference it rather than restate it.

| Class | Definition | Existing precedent |
|---|---|---|
| **GLOBAL** | Available regardless of confirmed country. | 193 of 216 catalogue items today; `isItemAvailableForCountry()` already returns `true` for any resolved (or unresolved) country when `country_applicability` is NULL. |
| **HOME_JURISDICTION** | Available only when the relevant country is the user's confirmed primary financial country. | SMSF today — the only catalogue item with a live, enforced restriction (`country_applicability=['AU']`, migration `0084`). |
| **HOME_OR_CROSS_BORDER_COUNTRY** | Available when the relevant country is primary **or** explicitly enabled as a cross-border country for that user/record. | Not yet enforced anywhere in `master_financial_items` — but Resources' `australia_india_cross_border` jurisdiction value (migration `0049`, see `02-module-matrix.md` §Resources) is a working, shipped precedent for exactly this concept, predating this decision. Newly assigned to 12 of the 20 reclassified AU items (`03-catalogue-matrix.md`, Decision PO-2a/c). |
| **GLOBAL_WITH_JURISDICTION_VARIANT** | A universal concept, available to everyone, whose label/help/description/fields vary by jurisdiction. | Newly assigned to 8 of the 20 reclassified AU items (Decision PO-2b) — e.g. `council_rates` (global concept: property tax) and `body_corporate` (global concept: strata/owners-corporation fee). No code changes this — it is a future labelling-layer requirement (Wave 2), not a `country_applicability` restriction (these 8 items keep `country_applicability=NULL`, i.e. still creatable by anyone, per PO-2b's explicit instruction not to hide a universal concept). |
| **EXISTING_RECORD_ONLY** | Not a catalogue-wide classification — a *per-record, per-user runtime state*: an existing record remains fully visible, editable (subject to normal field-level rules), and counted in totals, but the same item is not offered for **new** creation to that user in their current context. | Implicit today in SMSF's trigger design (fires only on INSERT/reactivation, never blocks read/update-of-other-fields of an already-active row) but never named as a distinct, reusable state. Formalised here so a future resolver can express "this specific user, for this specific existing record, is in an EXISTING_RECORD_ONLY state" without needing a sixth class or a per-item special case. Used explicitly in the SMSF cross-border scenario table (`09-cross-border-model.md` §5, Decision PO-5). |

**Architecture rules governing all five classes (spec s.46, reaffirmed):**
- Extend the existing `country_applicability`/`isItemAvailableForCountry()` foundation minimally — **no second applicability engine is introduced or proposed by this closure.** `GLOBAL_WITH_JURISDICTION_VARIANT` and `EXISTING_RECORD_ONLY` do not need a new database column: the former is a presentation-layer (label/help-text) concern layered on top of an item that remains `country_applicability=NULL`; the latter is a resolver-time decision combining the existing `country_applicability` check with an existing-record lookup, not a new stored state.
- Applicability controls catalogue exposure and new-record creation only — never removes economic values from Net Worth, assets, liabilities, investments, retirement totals, goals, reports, or historical snapshots (unchanged from §6 above; re-affirmed for all five classes, not just the original four).
- Existing-record access is evaluated separately from new-record eligibility (this is the entire reason `EXISTING_RECORD_ONLY` exists as a named state rather than being folded into `HOME_JURISDICTION`).
- Record-country eligibility is evaluated separately from user residence (a record's own `country_code` is not the same field as `user_profiles.country_of_residence` — see §8 below).
- An anonymous selected display country (e.g. a marketing-site country picker) must never grant an authenticated financial capability — no code path was found that does this today (`getUserHomeCountry()` only ever reads the authenticated `user_profiles` row via a server-side Supabase client), and none should be introduced.
- Cross-border eligibility (`HOME_OR_CROSS_BORDER_COUNTRY`) requires an **explicit stored relationship**, not an inference from currency alone — this is the exact lesson of the `resilienceStress.ts:84` defect (`04-calculation-dependency-matrix.md`), generalised into a standing architecture rule. `user_profiles.secondary_country` (dormant today, §2 above) is the closest existing schema candidate for storing this explicit relationship once a real onboarding/settings write-path is built (Wave 4) — a currency field must never substitute for it.
- A record's currency is never proof of its country. A record's `country_code` column is the only source of a record's country; `preferred_currency`/`base_currency` are separate, currency-only concepts (§8 below).
- The architecture fails closed for **new** jurisdiction-sensitive creation (an unresolved or ineligible country is rejected, per `isItemAvailableForCountry()`'s existing behaviour) while always preserving existing values — this was true in the discovery baseline and remains true; no code change was made or is required to state this as the standing rule.

**Minimum future resolver inputs required to evaluate these five classes (not implemented in this task):** (1) the user's confirmed primary financial country (today: `user_profiles.country_of_residence`, see §8); (2) the user's confirmed-country *state* (confirmed vs. unresolved — today implicit as "NULL means unresolved", no explicit confirmation timestamp/source exists yet, see `02-module-matrix.md` §Profile/Onboarding and Decision PO-3); (3) the set of countries explicitly enabled as cross-border for that user (does not exist yet — `secondary_country` is dormant and is a single value, not a set; a future implementation needs a proper one-to-many "enabled cross-border countries" relationship, not a second scalar column); (4) for existing-record checks, the specific record's own `country_code` and creation/active-status metadata (exists today per table); (5) the catalogue item's own `country_applicability` value (exists today) plus, for `GLOBAL_WITH_JURISDICTION_VARIANT` items, a jurisdiction-keyed label/help-text override (does not exist yet — no schema or component-level i18n-style override mechanism was found for catalogue item labels).

## 8. Canonical jurisdiction concepts (PRODUCT OWNER APPROVED architecture, 2026-08-27)

Per the Product Owner's explicit instruction not to let one country field carry every meaning, the following concepts must remain distinct in all future architecture and documentation. Each row states today's authoritative field (or "does not exist yet") — this section does not create any new field.

| Concept | Today's authoritative source | Notes |
|---|---|---|
| Detected visitor country | Does not exist (no IP/geo-detection code found anywhere in the app) | Per Decision PO-3, must remain a *suggestion* only if ever built — never a confirmation. |
| Selected anonymous display country | Does not exist for the authenticated app (out of scope — no landing-page country picker was found feeding any authenticated capability) | Must never grant an authenticated financial capability (§7 rule, reaffirmed). |
| Residence country | `user_profiles.country_of_residence` (today, conflated with primary financial country — see below) | |
| Primary financial country | `user_profiles.country_of_residence` (today, same field as residence — **not yet separated**) | See transition note below. |
| Confirmed/unconfirmed country state | Implicit: NULL = unresolved, non-NULL = resolved. **No explicit confirmation timestamp or source column exists yet.** | Required for Decision PO-3's future audit trail (`02-module-matrix.md` §Profile/Onboarding). |
| Base/reporting currency | `user_profiles.preferred_currency` / `forecast_profiles.base_currency` | Distinct field, never a jurisdiction proxy (§7 rule; `resilienceStress.ts` defect is the cautionary example). |
| Original record currency | Each table's own currency-bearing columns (varies by module) | Not explicitly audited row-by-row in this closure; unchanged from discovery baseline. |
| Record country | Each table's own `country_code` column (`assets`, `liabilities`, `investments`, `retirement_accounts`, etc.) | Distinct from the owner's home country — this is what makes cross-border detection possible today (`09-cross-border-model.md` §1). |
| Cross-border countries (plural, per user) | Does not exist as an explicit stored set. `user_profiles.secondary_country` is a dormant, single-value approximation (§2 above), never written by any UI. | Required for `HOME_OR_CROSS_BORDER_COUNTRY` to be genuinely explicit rather than inferred (§7 rule) — a future one-to-many table, not a second scalar. |
| Country experience level | Does not exist | Not raised as a gap by any of the six PO decisions; noted here only for completeness per spec s.6's concept list. |
| Capability availability | Emergent from `isItemAvailableForCountry()` + (not-yet-built) confirmation-state + (not-yet-built) cross-border-set — no single "capability" table/flag exists | |
| Catalogue applicability | `master_financial_items.country_applicability` | |
| Existing-record visibility | Implicit today (unconditional reads everywhere except the SMSF trigger's INSERT/reactivation-only scope) — not yet a named, reusable concept outside this documentation | Formalised as `EXISTING_RECORD_ONLY` in §7. |
| New-record creation eligibility | `assertItemCreationAllowedForUser()` (SMSF only, live); `isItemAvailableForCountry()` (UI-offer, all items) | |
| Resources jurisdiction | `resource_posts.jurisdiction` / `resource_faqs.jurisdiction` (migration `0049`) — its own independent single-value vocabulary (`global`/`australia`/`india`/`australia_india_cross_border`), see `02-module-matrix.md` §Resources | Genuinely separate system from `master_financial_items`; not to be merged or duplicated (spec s.29, mandatory Resources resolution — see `02-module-matrix.md`). |
| Report jurisdiction context | `reportSnapshotResolver.ts`'s per-report resolution at generation time (e.g. India Tax & Cost gating) | Historical snapshots must preserve the jurisdiction context used at generation time (Decision PO-6, Reports). |
| Billing country | Does not exist (no billing/payment-country field was found anywhere in the schema) | Out of scope for all six PO decisions; noted for completeness only. |
| Tax residence | Does not exist (confirmed absent in the discovery baseline, re-confirmed here — no diff to `user_profiles` schema on `origin/main` since the discovery fork point) | Must not be conflated with residence country or primary financial country if ever added (spec s.5's standing warning). |

**Reconfirmation of the current authoritative field (spec s.6, explicit instruction):** unless fresh evidence disproves it, **`user_profiles.country_of_residence` remains the current authoritative authenticated-user jurisdiction source.** Fresh inspection in this closure pass found no schema or code change to this field or its call sites between the discovery fork point and current `origin/main` (`git diff` empty for `lib/services/jurisdiction.ts`, confirmed above) — the discovery baseline's conclusion stands. **`households.primary_country` is explicitly not promoted to an independent competing source** — it remains a passive, one-way copy (§1 above), and no evidence gathered in this closure pass changes that.

**Why residence and primary financial country may need to separate in a future wave (documented, not created here):** today the same field (`country_of_residence`) is asked to answer two different questions — "where does this person live" and "which country's financial products/rules should govern their account" — which are usually but not always the same answer (an NRI is the textbook counter-example the spec itself raises under Decision PO-1). If a future wave decides a separate `primary_financial_country` field is required:
- **Why necessary:** an NRI (Indian-passport holder resident in, say, the UAE or Australia) may have `country_of_residence` reflecting physical residence while their "primary financial country" for retirement-product eligibility (EPF/PPF/NPS, per Decision PO-1) is India.
- **Relationship to residence:** primary financial country would default to residence country at first confirmation, but must be independently editable thereafter (an NRI should be able to set them differently without the app inferring one from the other).
- **Confirmation state:** would need the same explicit confirmation timestamp/source metadata Decision PO-3 already requires for residence country generally — not a separate, weaker confirmation mechanism.
- **Migration treatment:** a new nullable column, backfilled from existing `country_of_residence` (never inferred to a different value at migration time — an existing user's primary financial country must start identical to their current residence country, not silently diverge).
- **Audit requirements:** any future change to either field independently must be logged with timestamp/source, same as Decision PO-3's confirmation audit trail.
- **Conflict handling:** if the two fields ever genuinely disagree (e.g. NRI case), every jurisdiction-sensitive catalogue/calculation decision must state explicitly which of the two fields it uses — this closure does not resolve that per-module question, since no such field exists yet to make the decision concrete.
- **Historical preservation:** exactly as for country changes generally (`09-cross-border-model.md` §4) — introducing this field must never retroactively alter which jurisdiction rules apply to an already-generated historical report or already-recorded catalogue item.

**This field is explicitly not created in this task** — this is documentation of the future decision shape only, per the spec's own instruction.
