# FHIP Jurisdiction Applicability Standard (Permanent)

**Status: Established by G0-JA-1, 2026-08-26.** This is the mandatory design input for every future FHIP module, feature, or catalogue item involving a financial product, calculation, or piece of content that could plausibly differ by country. It codifies what already exists and works (the SMSF reference implementation) rather than inventing new mechanics — see `01-canonical-architecture.md` for the underlying evidence.

## The governing principle

> Show globally relevant functionality to everyone, home-jurisdiction functionality to users of that jurisdiction, and cross-border functionality only where the user actually has or intentionally adds financial interests in another jurisdiction.

Home jurisdiction controls the default experience. Foreign holdings never change the user's home jurisdiction. Cross-border holdings remain financially visible always. Existing records survive a country move, unconditionally. Country filtering controls *relevance*, never *economic ownership*. No jurisdiction-visibility change may ever silently alter Net Worth.

## 1. Canonical sources — use these, never re-derive

| Concept | Canonical source | Never use instead |
|---|---|---|
| User's home jurisdiction | `user_profiles.country_of_residence`, read via `getUserHomeCountry()` (`lib/services/jurisdiction.ts`) | `households.primary_country` (passive copy only); `preferred_currency`/`base_currency` (a currency, not a jurisdiction — `resilienceStress.ts`'s defect is the cautionary example); citizenship (does not exist in this app and must not be added as a jurisdiction proxy, spec s.5) |
| Item creation eligibility | `master_financial_items.country_applicability` via `isItemAvailableForCountry()` / `assertItemCreationAllowedForUser()` (`lib/services/jurisdiction.ts`) | A new bespoke per-component `if (country === 'AU')` check |
| A record's own country tag (distinct from the owner's home country) | Each table's own `country_code` column | Inferring a record's jurisdiction from its `master_item_key` or category alone |

**Status update, 2026-08-27 (G0-JA-1 closure):** the four-class model this document originally proposed (GLOBAL / HOME_JURISDICTION / CROSS_BORDER / GLOBAL_WITH_JURISDICTION_VARIANT) has been superseded by the Product Owner's five approved canonical classes — **GLOBAL, HOME_JURISDICTION, HOME_OR_CROSS_BORDER_COUNTRY, GLOBAL_WITH_JURISDICTION_VARIANT, EXISTING_RECORD_ONLY** — defined once, canonically, in `01-canonical-architecture.md` §7. This document is updated below to reference that section rather than restate a second, now-inconsistent definition. `CROSS_BORDER` is renamed `HOME_OR_CROSS_BORDER_COUNTRY` (same intent: available when the relevant country is primary *or* an explicitly-enabled cross-border country — the rename makes the "or" explicit) and `EXISTING_RECORD_ONLY` is added as a fifth, distinct, per-record runtime state (not a catalogue-wide class) per Decision PO-5's SMSF cross-border scenario table (`09-cross-border-model.md` §5).

## 2. Every future feature must declare, at design time (spec s.53)

1. **Applicability class** — one of the five canonical classes in `01-canonical-architecture.md` §7 (GLOBAL / HOME_JURISDICTION / HOME_OR_CROSS_BORDER_COUNTRY / GLOBAL_WITH_JURISDICTION_VARIANT / EXISTING_RECORD_ONLY). Use `GLOBAL_WITH_JURISDICTION_VARIANT` only when a concept is genuinely universal but its implementation/labelling is genuinely country-specific (e.g. council rates vs. property tax); use `EXISTING_RECORD_ONLY` only as a per-record runtime state layered on top of one of the other four, never as a standalone catalogue-wide classification. Do not add further classes without demonstrating these five are insufficient.
2. **Applicable country codes** — from the existing ISO alpha-2 set (`AU`, `IN` today; extend the `countries` table and the `CountryCode` union together if a new country is ever added, never introduce a second representation).
3. **Home-jurisdiction creation rule** — exactly which country code(s) may create a *new* instance.
4. **Cross-border new-creation rule** — may a non-home-jurisdiction user create one anyway, and under what condition (explicit cross-border declaration? Never? Always?). Do not leave this implicit.
5. **Existing-record behaviour** — must default to "preserved, fully visible, fully counted, fully editable" unless a specific, disclosed reason requires otherwise (there is no current precedent in this app for ever doing otherwise, and none is anticipated).
6. **Country-change behaviour** — what happens to this feature's data/state when the owning user's `country_of_residence` changes. Follow `09-cross-border-model.md` §4's worked table as the template; explicitly state whether the feature needs its own re-derivation hook (like Forecasting's currently-missing one) or is naturally unaffected (like the core grids).
7. **Calculation behaviour** — confirm and document that jurisdiction-driven visibility never subtracts from a calculation engine's totals; only creation/UI-offer logic may be jurisdiction-gated.
8. **Report behaviour** — null-when-not-applicable (never a fabricated zero, never an empty section rendered with a misleading heading), following the Investment Intelligence Tax & Cost precedent exactly.
9. **Server enforcement requirement** — decide, explicitly, whether this feature needs (a) API-layer gating only (call `assertItemCreationAllowedForUser()` from the relevant POST route — the default, minimum requirement for any jurisdiction-restricted catalogue item), (b) a DB-level trigger as well (required when the feature has additional integrity rules beyond simple jurisdiction gating, e.g. SMSF's reactivation case), or (c) no gating (GLOBAL features). **Client-side/UI-only hiding is never sufficient by itself for a regulated or product-specific creation restriction** (spec s.35, s.77).
10. **Required jurisdiction regression tests** — at minimum the applicable subset of GEO-01..10 / APP-01..10 (`08-testing-strategy.md`), scoped to the new feature.

## 3. Reuse checklist — do not build a second version of any of these

- Applicability predicate: `isItemAvailableForCountry()` — do not write a new `if (countryApplicability...)` check anywhere.
- Home-country resolution: `getUserHomeCountry()` — do not re-read `user_profiles.country_of_residence` inline in a new file; import the shared function so a future change to its fail-closed behaviour propagates everywhere at once.
- Server-side creation gate: `assertItemCreationAllowedForUser()` — call this from any new catalogue-linked POST route the moment that category gets its first jurisdiction-restricted item. It is currently wired into `app/api/retirement/route.ts` only, because retirement is currently the only category with a restricted item — **this is the reason it isn't wired into the other six catalogue routes today, not evidence that they don't need it once they gain a restricted item.**
- `country_applicability` column convention: `char(2)[]`, NULL = globally applicable, non-null = the exact ISO codes it's restricted to. Already used identically by `master_financial_items` (0084), `goal_types` (0009, dormant), and `fdh_categories`/`fdh_subcategories`/`fdh_classification_rules` (0045, present in validation but non-discriminating in practice). Any new applicability column must use this exact shape.

## 4. Development Checklist (spec s.54) — attach to every future PR touching a financial feature

- [ ] Applicability class declared (GLOBAL / HOME_JURISDICTION / HOME_OR_CROSS_BORDER_COUNTRY / GLOBAL_WITH_JURISDICTION_VARIANT / EXISTING_RECORD_ONLY — see `01-canonical-architecture.md` §7)
- [ ] Country codes declared, using the existing ISO alpha-2 codes only
- [ ] UI filtering (if any) implemented by extending `country_applicability` + `listMasterItems()`/`isItemAvailableForCountry()` — not a bespoke per-component check
- [ ] API/server enforcement added if this feature is a *new* jurisdiction-restricted catalogue item (call `assertItemCreationAllowedForUser()` from its POST route; add a DB trigger only if additional integrity rules beyond simple gating are needed)
- [ ] Existing records preserved — proven with a before/after row-count check against real DEV data (same style as `05-live-dev-usage-audit.md`), not just asserted
- [ ] Cross-border behaviour tested — does an out-of-home-jurisdiction user's *existing* holding of this type remain visible/counted? (must be YES unless explicitly and separately decided otherwise, with sign-off recorded)
- [ ] Country-change behaviour tested — GEO-01..10 subset relevant to this feature
- [ ] Financial totals unaffected by visibility change — confirm Net Worth/income/liabilities/retirement totals identical pre/post for every user whose access to this feature the change touches, except users for whom the change is the intended reclassification
- [ ] Reports checked — does this feature's data appear/disappear correctly in Free/Premium reports for both an applicable and a non-applicable user, with `null`-not-fabricated-zero for the non-applicable case?
- [ ] Regression tests included — unit test for the pure applicability logic, PGlite cert for schema/trigger behaviour, live-DEV verification for anything RLS/Auth/PostgREST-dependent (spec s.64)

Do not force this checklist into an inappropriate location merely to tick a box — a genuinely GLOBAL feature with no jurisdiction dimension at all only needs the first line checked off ("GLOBAL, all countries, no further action") and can skip the rest with that one-line justification.
