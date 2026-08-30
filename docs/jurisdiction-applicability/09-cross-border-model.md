# Cross-Border Model & Country-Change Risk Analysis (spec s.31-37, G — J of report structure)

## 1. What activates Cross-Border applicability today (as-built, not aspirational)

There is **no explicit user-facing "I have cross-border interests" declaration anywhere in the product** (confirmed: `secondary_country` is dormant, no onboarding/settings flow writes it — `01-canonical-architecture.md` §2). Cross-border status is instead **entirely implicit and per-record**: any row in `assets`/`liabilities`/`investments`/`retirement_accounts` whose own `country_code` differs from the owner's current `country_of_residence` is, by construction, a cross-border holding. `lib/engines/dashboard.ts`'s `countriesInUse` aggregate is the closest thing to a "does this household have cross-border activity" signal, and it is derived exactly this way (union of all recorded `country_code` values).

This matches spec s.31's own worked example almost exactly: "an Australian resident with NPS, Indian mutual funds, Indian property" is represented today simply as an AU-resident user with some rows tagged `country_code='IN'`, no separate cross-border "mode" or flag required. **This is a reasonable minimal design, not a gap by itself** — but it means there is no single place to answer "is this household cross-border?" other than re-deriving it from the record set each time, and no product surface exists today to let a user proactively declare an upcoming cross-border holding before they record the first row (e.g. before adding their first NPS account, there's no "add a second jurisdiction" step).

## 2. Product-level cross-border rule per jurisdiction-specific item (spec s.32)

Only one catalogue item has an explicit, coded cross-border policy today: **SMSF**.

| Question (spec s.32) | SMSF's actual answer | Where enforced |
|---|---|---|
| New creation while resident in home jurisdiction (AU)? | Yes | DB trigger + `assertItemCreationAllowedForUser` via `app/api/retirement/route.ts` |
| New creation while resident elsewhere (IN)? | No — rejected | Same trigger, `errcode='42501'` |
| Existing-record visibility while abroad? | Preserved, fully visible | Trigger only fires on INSERT/reactivation, never on ordinary reads/updates |
| Editable while abroad? | Yes (balance, notes, holdings — everything except *re-activating* an archived fund) | Same trigger scope |
| Financial calculations while abroad? | Unaffected — `retirement_accounts.current_balance` counted in Net Worth identically regardless of current country | `lib/engines/dashboard.ts` has no country filter |
| Reports? | Unaffected — no country-gate found in the report resolver for SMSF specifically | `reportSnapshotResolver.ts` |

**No other catalogue item has any of these six questions answered in code today.** The 20 AU-flavoured items flagged in `02-module-matrix.md` (Industry Super, Retail Super, HECS/HELP, etc.) currently answer "yes" to every column above simply because nothing restricts them at all — which is a *safe* default (no economic value is ever hidden) but not a *designed* cross-border policy. Any future restriction of these items must decide all six columns explicitly, not infer them from the SMSF precedent by analogy (each product's actual legal/regulatory character may differ — e.g. HECS/HELP is a personal debt obligation, unlike SMSF's account-type structure, and "should an IN-resident who took on HECS debt while an AU resident still make repayments / see it in liabilities after moving" is a genuinely different question than SMSF's).

## 3. The one-foreign-asset-does-not-unlock-everything principle (spec s.31)

No code path was found anywhere that unlocks additional catalogue items based on the mere presence of a foreign-country record. `listMasterItems()`/`isItemAvailableForCountry()` only ever consult the *user's own resolved home country* — never scan the user's existing holdings to decide what else to offer. **This principle is already correctly satisfied, structurally, because the alternative (holdings-driven unlocking) was never built.** Worth stating explicitly for the standard doc (`07-jurisdiction-standard.md`) so a future developer doesn't introduce it by well-intentioned "smart defaults."

## 4. Country-change behaviour (spec s.36-37, report section J)

Traced what currently happens, module by module, when `country_of_residence` changes (no dedicated "change country" flow exists — this assumes a generic profile-update writes the column directly):

| Module | Effect of a country change | Evidence | Risk |
|---|---|---|---|
| Existing financial records (assets/liabilities/investments/retirement) | **Unaffected** — none of these tables have any trigger or read-path keyed off `country_of_residence` for filtering their own rows | `lib/engines/dashboard.ts` totals unconditional; no trigger found on these 4 tables referencing `user_profiles` except SMSF's own | LOW — correct, matches spec s.10/s.36 exactly |
| Catalogue offer for *new* creation | **Immediately updates** — `listMasterItems()`/`/api/master-items` re-resolves `getUserHomeCountry()` on every request, no caching found | `lib/services/masterItems.ts`, `app/api/master-items/route.ts` | LOW — correct, live re-resolution |
| SMSF creation/reactivation gate | **Immediately updates** (DB trigger reads `user_profiles` live on every INSERT/UPDATE) | Migration `0084` | LOW — correct |
| `households.primary_country` | **Stale** — never re-copied after the initial onboarding write; a subsequent `country_of_residence` change is not mirrored | `OnboardingWizard.tsx:154` only fires at onboarding submission; no other write site found | LOW *today* only because nothing currently reads `households.primary_country` for logic — see `01-canonical-architecture.md` §1. **Would become a real bug the moment anything starts trusting it as current.** |
| `forecast_profiles.country_code` | **Stale** — copied once at forecast-profile creation (`getOrCreateForecastProfile()`), never re-derived on a later country change | `forecastData.ts:26-57` | **MEDIUM** — unlike `households.primary_country`, this field is actively used (feeds the entire assumption cascade). A user who moves AU→IN keeps seeing AU-tuned inflation/return/retirement-age assumptions in Forecasting until/unless something explicitly re-derives their forecast profile. No such re-derivation path exists today. |
| Financial Twin cohort | **Immediately updates**, EXCEPT the silent-AU-default defect (`04-calculation-dependency-matrix.md`) means a country change *to* an unresolved state (if that were ever possible) or a load-time race could momentarily mis-benchmark | `twinData.ts` re-reads on every call, no caching found | Defect already tracked separately |
| `resilienceStress.ts` home-country stress filter | **Never updates from a country change at all** — it never reads `country_of_residence` in the first place, only `preferred_currency` | `resilienceStress.ts:84` | Defect already tracked separately (`04-calculation-dependency-matrix.md`) |

**Net worth impact of a country change alone: confirmed $0** for every module actually traced (assets/liabilities/investments/retirement/dashboard totals) — no defect found that would change a computed financial total purely from a country change. **Forecasting projections would change** (different assumption set applies to a going-forward forecast run once profile/country re-derivation *is* built or manually triggered), which is expected/desired behaviour, not a Net-Worth violation — flagged here only so a future regression gate (GEO-10, `08-testing-strategy.md`) explicitly distinguishes "Net Worth unchanged" (must hold) from "Forecasting assumptions may legitimately change" (acceptable, even desired).

## 5. Auto-conversion check (spec s.37)

No code path was found that reclassifies a record's `master_item_key`, `category`, or type based on a country change. Searched for any `UPDATE ... master_item_key` or equivalent reclassification trigger beyond migration-time one-off backfills (`0072`-`0074`'s AIR consolidation, which is a deliberate one-time data-cleanup already certified and out of scope here) — none found tied to `country_of_residence` changes. **No auto-conversion risk identified.**

## 6. SMSF and cross-border reconciliation architecture (Decision PO-5, spec §10 — RESOLVED, documented, NOT implemented)

The four DEV SMSF rows owned by IN-resident users (`05-live-dev-usage-audit.md` §5) are **preserved as-is per Decision PO-5** — not deleted, not modified, not assumed invalid. They may represent: an Australian now resident in India; a legitimate Australian cross-border holding; an NRI/multi-country case; a test fixture; or a profile whose country genuinely changed after the SMSF was created. **This closure did not, and could not, determine which** from read-only aggregate queries alone (unchanged conclusion from the discovery baseline) — Decision PO-5 explicitly authorises only a "read-only lineage/fixture-status investigation where authorised", and does not authorise deletion, which "requires conclusive test-data identification and separate Product Owner authority" not granted here.

### 6.1 Six concepts this architecture must keep distinct (Decision PO-5's explicit requirement)

| Concept | For the 4 India-profile SMSF cases, today | Canonical source (§8, `01-canonical-architecture.md`) |
|---|---|---|
| Residence country | Unknown from aggregates alone — assumed equal to `country_of_residence` today (no separate residence field exists) | `user_profiles.country_of_residence` |
| Primary financial country | Same field as residence today (not yet separated — §8) | `user_profiles.country_of_residence` |
| Cross-border relationship | Not explicitly stored for any of the 4 cases — inferred only from the SMSF record itself existing under an IN-resident owner | Does not exist as an explicit set today (§8) |
| Record country | The SMSF fund's own jurisdiction is AU by construction (SMSF is an Australian legal structure; `smsf_holdings.country_code` FK exists per migration `0084`) — this does not change even if the owner's residence changes | Each SMSF-linked row's own country metadata |
| Capability to create a **new** SMSF | **No** for all 4 cases today — the DB trigger (`0084`) rejects new creation/reactivation for any non-AU-resident owner, with no exception for "has an existing cross-border relationship to AU" (that concept does not exist yet) | `trg_retirement_accounts_smsf_au_gate` |
| Permission to view/maintain the **existing** record | **Yes** for all 4 cases today — the trigger only fires on INSERT/reactivation, never on ordinary reads/updates (`01-canonical-architecture.md` §5-6) | Absence of any read/update-blocking trigger |

### 6.2 Existing SMSF gates, assessed layer by layer (spec §10)

| Layer | Current enforcement | Expresses the future distinction? |
|---|---|---|
| UI | `FinancialDataGrid`/retirement page offers SMSF as a creatable item unconditionally in the UI layer itself — the actual block happens server-side | No — UI-only hiding was never relied on as the sole gate (correct per `07-jurisdiction-standard.md` §2 item 9), but it also does not yet distinguish "no cross-border relationship" from "unconfirmed country" from "confirmed non-AU with no relationship" |
| Server/API | `assertItemCreationAllowedForUser()` via `app/api/retirement/route.ts` — binary AU/not-AU check only | No — binary today, no `HOME_OR_CROSS_BORDER_COUNTRY`-shaped "explicit AU relationship" exception exists |
| Service layer | `lib/services/jurisdiction.ts`'s `isItemAvailableForCountry()` — binary NULL/matching-array check | No — the same binary limitation, by design (this is the generic predicate every catalogue item uses; SMSF's AU-only case happens to be expressible in it today because SMSF's `country_applicability=['AU']` needs no exception) |
| Database trigger/function | `trg_retirement_accounts_smsf_au_gate` (migration `0084`) — reads `user_profiles.country_of_residence` directly, rejects any non-AU value including NULL | **No — this is the layer that cannot express the future distinction without a change**, see §6.3 |
| RLS | Tenant-scoped row visibility only — not jurisdiction-aware, and does not need to be (correct separation of concerns) | N/A — RLS is not, and should not become, the jurisdiction gate |
| Catalogue applicability | `master_financial_items.country_applicability=['AU']` for SMSF | Same binary limitation as the service layer |
| Reports | No SMSF-specific country gate found in `reportSnapshotResolver.ts` (confirmed in the discovery baseline, re-confirmed here — no diff) | N/A — reports correctly show existing SMSF value regardless of current country, matching Decision PO-5's "existing SMSF records remain visible" / "economic value remains included in totals" requirement already |
| Net-worth/retirement aggregation | `lib/engines/dashboard.ts` — unconditional (§`04-calculation-dependency-matrix.md`) | N/A — already correct, no gate exists here at all (by design) |

### 6.3 Can the existing trigger express the future distinction? (spec §10, explicit question)

**No, not as currently written.** `trg_retirement_accounts_smsf_au_gate` (migration `0084`) implements a single binary rule — "is the owner's current `country_of_residence` exactly `'AU'`" — with no concept of an explicit cross-border relationship, no concept of "unconfirmed vs. confirmed-non-AU", and no concept of `EXISTING_RECORD_ONLY` (it does not need one today, since it never blocks existing-record access in the first place — only creation/reactivation). Expressing the future scenario table below (§6.4) inside a single trigger would require the trigger to also consult a not-yet-built explicit cross-border-relationship store (§8's "cross-border countries" row) — which does not exist yet.

**Bounded later-wave remediation requirement (not a change made now):** a future wave introducing the explicit cross-border-relationship table (Wave 4, `06-implementation-waves.md`) must also revise this trigger — atomically, with the new table — to add exactly one new allowed path: "non-AU primary WITH an explicit, stored AU cross-border relationship MAY create/reactivate, subject to whatever additional authority Decision PO-5's 'subject to authority' language requires" (row 2 of §6.4). **This closure does not weaken, does not change, and does not schedule a specific migration number for this trigger.** The current security guarantee (reject every non-AU-resident creation/reactivation attempt, with zero exceptions) must remain in force, unmodified, until its atomic replacement is implemented, tested, and deployed together with the cross-border-relationship store it depends on — never as two separate deployments where the trigger is loosened before the relationship store exists to make the loosening safe.

### 6.4 Future target-state scenario table (spec §10, exact table — documented target, not implemented)

| Scenario | View existing SMSF | Maintain existing SMSF | Create new SMSF | Included in totals |
|---|---:|---:|---:|---:|
| Confirmed AU primary | Yes | Yes | Yes, subject to normal validation | Yes |
| Non-AU primary + explicit AU cross-border | Yes | Yes, subject to authority | Future policy-controlled | Yes |
| Non-AU primary without AU cross-border + existing record | Yes | EXISTING_RECORD_ONLY pending confirmation | No | Yes |
| Unconfirmed country + existing SMSF | Yes | Restrict sensitive changes pending confirmation | No | Yes |
| Non-AU primary with no record and no AU context | No catalogue exposure | N/A | No | N/A |

Mapped against today's actual enforcement: the discovery baseline's live data shows all 4 India-profile SMSF cases currently sit somewhere between row 2 and row 4 of this table (a confirmed non-AU primary country, an existing record, no explicit cross-border relationship recorded anywhere since that concept doesn't exist yet) — **today's binary trigger treats them exactly as row 3/4 already require** ("existing record visible and included in totals, no new creation") purely as a side effect of never blocking reads/updates, not because the trigger was designed with this table in mind. This is a favourable coincidence, not evidence the trigger already implements the nuanced table — it does not distinguish row 2 from row 3 at all (both currently just "not row 1, so creation blocked"), which is exactly the gap §6.3 identifies.

### 6.5 Preservation guarantee (Decision PO-5, restated as a standing architecture rule)

Existing SMSF records remain visible; economic value remains included in totals; legitimate existing holdings remain maintainable; **existing ownership does not automatically grant permission to create a new SMSF** (row 3/4 of §6.4 — an existing record is not itself a cross-border relationship); new SMSF creation requires the applicable Australia capability through the eventual canonical cross-border-relationship context (row 2), not through the mere fact of already owning one. Data removal for any of the 4 cases requires conclusive test-data identification and separate Product Owner authority — **neither exists as of this closure; none of the 4 records were touched, queried for deletion, or reclassified in any way during this task.**
