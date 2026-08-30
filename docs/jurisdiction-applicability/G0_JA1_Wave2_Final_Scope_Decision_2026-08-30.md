# G0-JA-1 Wave 2 — Final Scope Decision (Authoritative Record)

**Date:** 2026-08-30
**Type:** Product Owner decision record — **authoritative**. Where any earlier Wave 2 report, index, register, or wave plan conflicts with this document, **this document governs**.
**Nature:** Documentation only. No application source, test, catalogue, seed, or migration file was changed to produce this record; no DEV or production environment was queried or written; nothing was pushed, merged, or deployed.

---

## 1. Authoritative Wave 2 verdict

> **G0-JA-1 WAVE 2 CONDITIONAL PASS — 11/20 ITEMS FUNCTIONALLY REALIGNED; AUSTRALIAN SHARES APPLICABILITY REDESIGN AND 8-ITEM SEMANTIC CERTIFICATION DEFERRED**

### 1.1 Functional breakdown

| Group | Count | Current status |
|---|---:|---|
| AU-restricted items implemented consistently | 11 | Functionally implemented |
| `investment.australian_shares` | 1 | Classification/data/runtime contradiction unresolved |
| `GLOBAL_WITH_JURISDICTION_VARIANT` items | 8 | Classified only; not functionally or semantically certified |
| **Total** | **20** | **11/20 functionally realigned** |

### 1.2 Claims that are not permitted

No current document may state or imply any of the following. Each is explicitly retracted:

- 20/20 items are fully realigned.
- All 12 restricted items are implemented consistently.
- The eight jurisdiction variants are functional.
- Wave 2 is a FULL PASS.
- Wave 2 catalogue applicability is completely closed.
- Australian Shares eligibility is resolved.

### 1.3 The 20 items, as actually deployed by migration `0102`

Verified directly against `supabase/migrations/0102_g0_wave2_catalogue_applicability.sql` on current `origin/main` — not relayed from an earlier report.

**Group 1 — 11 AU-restricted items, functionally implemented** (`applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY'`, `country_applicability = ['AU']`; class and data agree):

| # | Catalogue identity |
|---:|---|
| 1 | `income.age_pension` |
| 2 | `income.family_tax_benefit` |
| 3 | `liability.smsf_property_loan` |
| 4 | `liability.hecs_help` |
| 5 | `liability.ato_payment_plan` |
| 6 | `retirement.industry_super` |
| 7 | `retirement.retail_super` |
| 8 | `retirement.government_co_contribution` |
| 9 | `retirement.transition_to_retirement` |
| 10 | `retirement.allocated_pension` |
| 11 | `retirement.account_based_pension` |

**Group 2 — 1 unresolved contradiction:**

| # | Catalogue identity |
|---:|---|
| 12 | `investment.australian_shares` |

**Group 3 — 8 items classified only, 0/8 functionally certified** (`applicability_class = 'GLOBAL_WITH_JURISDICTION_VARIANT'`, `country_applicability` deliberately left `NULL`):

| # | Catalogue identity |
|---:|---|
| 13 | `expense.body_corporate` |
| 14 | `expense.council_rates` |
| 15 | `retirement.defined_benefit` |
| 16 | `retirement.employer_contributions` |
| 17 | `retirement.salary_sacrifice` |
| 18 | `retirement.personal_concessional` |
| 19 | `retirement.non_concessional` |
| 20 | `retirement.spouse_contribution` |

`retirement.smsf` is **not** part of this set and was never touched by `0102`; migration `0084` remains the sole source of its AU restriction.

---

## 2. `investment.australian_shares` — unresolved applicability contradiction

### 2.1 Actual deployed state

Migration `0102` (applied, and present on current `origin/main`) left this item as:

```
Catalogue item:        investment.australian_shares
Applicability class:   HOME_OR_CROSS_BORDER_COUNTRY
Country applicability: NULL
Runtime behaviour:     globally creatable
```

This is **internally inconsistent**: the class asserts country-based applicability, while the data and the runtime impose no country restriction at all. Any future code that reads `applicability_class` alone — which the class column's own contract says should be sufficient — will misclassify this item.

### 2.2 This contradiction is open

The rejected local hotfix `2fa2090` and its unmerged migration `0103` **must not be treated as resolving this** (§4). No approved resolution is currently deployed, staged, or authorised.

### 2.3 Approved future design direction (not authorised for implementation here)

- A user with a **confirmed AU home country** may create Australian Shares.
- A user with a **confirmed non-AU home country** may create it **only** through the future verified AU cross-border relationship.
- **Existing** Australian Shares records are **always preserved**, unconditionally.
- **Preferred currency must never grant eligibility.**
- **Missing country must never default to AU.**
- **Invalid country must never default to AU.**

**No implementation of any part of this direction is authorised by this record.** It is owned by Future Phase A (§6).

---

## 3. The eight `GLOBAL_WITH_JURISDICTION_VARIANT` items

### 3.1 Current true state

- Classified: **8/8**.
- **Functional variant coverage: 0/8.**
- There is **no jurisdiction-label resolver and no rendering mechanism** anywhere in the application.
- Current labels are unchanged — no relabelling has occurred.
- **Do not build a resolver now.**

"Classified" means a metadata value was written to `applicability_class`. It does **not** mean the item is functionally implemented, semantically certified, or rendered differently for any user.

### 3.2 Required future treatment

Each of the eight items requires **item-by-item semantic certification** before any rendering mechanism is designed. Each must be classified into **exactly one** of:

| Outcome | Meaning |
|---|---|
| `TRUE_LABEL_VARIANT` | Same financial concept and calculation identity; only wording changes |
| `JURISDICTION_SPECIFIC_PRODUCT` | Separate catalogue identity, rules, and calculations required |
| `NEUTRAL_GLOBAL_ITEM` | One jurisdiction-neutral label used everywhere |

### 3.3 The seven identity tests

An item may be classified `TRUE_LABEL_VARIANT` only on proof that **all seven** remain identical across jurisdictions:

1. Financial meaning
2. Input fields
3. Calculation treatment
4. Tax and regulatory assumptions
5. Reporting treatment
6. Forecast behaviour
7. User eligibility

**If any of the seven differ materially, separate catalogue identities are required** — the item becomes a `JURISDICTION_SPECIFIC_PRODUCT`, not a relabelled shared item.

### 3.4 EPF, PPF and NPS

- They are **not aliases** of Australian Superannuation.
- They **must not be added** to the existing catalogue during this task.
- They **remain separate future Indian retirement products**.
- They **require their own rules, calculations and certification**.

---

## 4. Closure hotfix `2fa2090` — formally rejected

| Field | Value |
|---|---|
| Commit | `2fa2090e7ffc5f8a27d71b114c09d5cab4a7b0bd` (`2fa2090`) |
| Branch | `fix/g0-wave2-closure-hotfix` |
| Historical worktree | `D:/fhip-g0-wave2` |
| Migration it carries | `supabase/migrations/0103_g0_wave2_australian_shares_country_consistency.sql` |

> **REJECTED — DO NOT PUSH, MERGE OR DEPLOY**

### 4.1 Why it is rejected

`2fa2090` contains two behaviours that conflict with the canonical jurisdiction architecture:

1. **Missing/invalid country defaulting to AU** — `resolveCountryForApplicability()` returns `'AU'` whenever the user's country is unresolved, and an unrecognised or forged value (e.g. `'ZZ'`) is indistinguishable from unresolved, so it is also silently treated as AU.
2. **AUD preferred currency acting as an Australian Shares eligibility signal** — `CURRENCY_ALTERNATE_SIGNAL`, scoped to `investment::australian_shares`, lets a currency *preference* stand in for an actual home country.

Both were originally accepted as narrow trade-offs *because no verified country-of-residence field existed*. That premise no longer holds: Mandatory Country Confirmation establishes the approved authoritative country source (§5).

### 4.2 Disposition — what must not happen

Do **not**: push the branch; merge it; deploy it; apply its migration `0103`; cherry-pick its source changes; copy its AU fallback; copy its currency signal; delete or rewrite the branch or commit; rewrite history.

**Keep it, unchanged, as historical evidence of a rejected design.**

### 4.3 Migration `0103`

Migration `0103` is **not approved for application anywhere** — not to DEV, not to production. It is written and locally tested only, exists solely on `fix/g0-wave2-closure-hotfix`, and is confirmed absent from `origin/main`.

---

## 5. Mandatory Country Confirmation — dependency, DEV-certified but not yet released

### 5.1 What it provides

Mandatory Country Confirmation establishes the approved **authoritative country source** for all future applicability decisions:

- `user_profiles.country_of_residence`
- `user_profiles.country_confirmed_at`
- `user_profiles.country_source`

Once its migrations, live DEV certification and controlled production release are complete, an active user will no longer proceed into FHIP with unresolved country.

### 5.2 Authoritative status statement

> Migration `0111` has been applied to DEV and independently live-verified 28/28, with zero residual synthetic users. Mandatory Country Confirmation remains unmerged to `main` and is not production-live.

### 5.3 What must not be claimed

DEV certification is **not** release. Do **not** read the completed DEV migration and 28/28 live verification as merge, deployment, or production readiness, and do **not** state that production users are already confirmation-gated. Three distinct gates must be tracked separately:

| Gate | State |
|---|---|
| DEV migration applied + live certification | **Complete** — `0111` applied to DEV, independently live-verified 28/28, zero residual synthetic users |
| Merge to `main` | **Not complete** |
| Production migration + deployment | **Not complete** |

### 5.4 Current status

| Item | Status |
|---|---|
| Branch | `feature/mandatory-country-confirmation-beta-cleanup` |
| Branch HEAD | `86219687941547188e55b3c5702ad3b9733513a9` (`8621968`, 2026-08-30) |
| MCC-14 code fix | Committed at `8621968` |
| Migration `0111` | `supabase/migrations/0111_mandatory_country_confirmation_delete_cascade_fix.sql` — **applied to DEV and independently live-verified 28/28**, with zero residual synthetic users |
| Merged into `main` | **No** — `8621968` is confirmed *not* an ancestor of `origin/main` |
| Applied to production / deployed to production | **No** |
| Responsive/OAuth/session UX certification | Incomplete |

**Remaining release gates:** responsive/OAuth/session UX certification; merge to `main`; controlled production migration and release. Live DEV certification of `0111` is **no longer** an outstanding gate — it is complete and independently verified.

### 5.5 Consequence for Wave 2

**Wave 2 applicability rework remains paused until Mandatory Country Confirmation is fully released.** No successor applicability implementation may begin before then, because the authoritative country source it must read is not yet available in production.

---

## 6. Future work packages — defined, not started

Neither phase is scheduled, estimated, or started by this record. Each requires **separate Product Owner authorisation**.

### 6.1 Future Phase A — Australian Shares applicability redesign

**Scope**
- Replace the current inconsistent metadata/runtime behaviour.
- Resolve eligibility from the user's **confirmed home country**.
- Add verified cross-border eligibility **only after** the canonical cross-border store exists.
- **Preserve all existing records.**
- **Remove all currency-based and silent-default eligibility signals.**
- Independently certify new creation, existing records, security, and calculations.

**Dependencies**
- Mandatory Country Confirmation production release.
- Future cross-border architecture, where non-AU creation is required.
- Separate Product Owner authorisation.

### 6.2 Future Phase B — Jurisdiction Terminology and Semantic Variant Certification

**Scope**
- Review all eight items **individually**.
- Determine, per item: true variant, separate product, or neutral global item.
- **Do not build resolver infrastructure until at least one true variant is proven.**
- Preserve EPF/PPF/NPS as separate products.

**Dependencies**
- Item-level product decisions.
- Calculation and reporting evidence.
- Separate Product Owner authorisation.

---

## 7. Recorded Product Owner decisions

| # | Decision | Authoritative outcome |
|---:|---|---|
| 1 | Wave 2 completeness | CONDITIONAL PASS at **11/20** functionally realigned. All higher completeness claims retracted. |
| 2 | `investment.australian_shares` | **1 unresolved** class/data/runtime contradiction. Future design direction recorded; implementation not authorised. |
| 3 | Eight variant items | **8/8 classified, 0/8 functional.** No resolver to be built. Item-by-item semantic certification required first. |
| 4 | EPF / PPF / NPS | Separate future Indian retirement products. Not aliases of Superannuation. Not to be added now. |
| 5 | Hotfix `2fa2090` | **REJECTED** — do not push, merge, or deploy. Preserved unchanged as rejected-design evidence. |
| 6 | Migration `0103` | Not approved for application anywhere. |
| 7 | Mandatory Country Confirmation | Approved authoritative country source. Migration `0111` has been applied to DEV and independently live-verified 28/28, with zero residual synthetic users. Mandatory Country Confirmation remains unmerged to `main` and is not production-live. Wave 2 rework paused until it is fully released. |
| 8 | Future phases A and B | Defined, not scheduled, not started. Each needs separate authorisation. |

---

## 8. Terminology — these five states are distinct

To prevent the ambiguity that produced the earlier overstatements, these terms are used in this documentation package with exactly these meanings and are never interchangeable:

| Term | Meaning |
|---|---|
| **Classified** | A metadata value was written to `applicability_class`. Nothing about behaviour follows from this alone. |
| **Functionally implemented** | Runtime behaviour, data, and class agree, and the item's eligibility rule actually takes effect. |
| **Semantically certified** | The item has passed the seven identity tests (§3.3) and been assigned one of the three outcomes. |
| **Deployed** | The migration carrying the change has been applied to an environment. Always name the environment — DEV and production are never interchangeable. |
| **Production-live** | The behaviour is active for real production users. |

Migration `0111` is **deployed to DEV only** and independently live-verified 28/28, with zero residual synthetic users; Mandatory Country Confirmation remains unmerged to `main` and is not production-live. Migration `0102` is **deployed**. The 11 AU-restricted items are **functionally implemented**. The 8 variant items are **classified** only — not functionally implemented, not semantically certified. `investment.australian_shares` is **classified** but its classification contradicts its deployed data and runtime.

---

## 9. Status of this workstream

**G0-JA-1 Wave 2 is PARKED.** No further Wave 2 implementation is authorised. The next Product Owner action is to complete the Mandatory Country Confirmation release; only then may Future Phase A be considered for authorisation.
