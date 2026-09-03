# G3 — Registration and Existing-User Alignment

Implementation and certification record. Branch `feature/g3-registration-existing-user-alignment`,
originally based on `origin/main` at `02097d5`, since reconciled with `origin/main` at `bd45308`
(Admin A0.2 Wave 4, II-PC1-F1 and II-PC1-F2, merged clean with zero conflicts).

## 0. Where the evidence in this document comes from

Every database result quoted here was produced against **a freshly rebuilt local PostgreSQL**
(PGlite, all 123 migrations replayed in order), **not** against live DEV. No statement in this
document should be read as "verified on DEV" — nothing has been run against DEV, because the
migration has not been applied there and the credential-containment prerequisite is not satisfied
(see the programme report). Application-layer results come from the Vitest suite. Where a claim is
architectural rather than executed, it says so.

---

## 1. What G3 changes, in one paragraph

Registration is extended from the two FULL-experience countries (AU, IN) to all six countries the
G1 registry already describes (AU, IN, GB, US, SG, AE). G2's `GLOBAL` landing bucket becomes a
prompt to pick a real country, never a stored value. Confirming one of the four GENERIC countries
requires an explicit, versioned acknowledgement of what is and is not available there. Reporting
currency stays exactly AUD/INR and becomes fully independent of country. Optional cross-border
relationships can be declared through the existing G1 table. Nothing about an existing AU or IN
user changes.

---

## 2. The two-tier country model (the central design decision)

MCC's `is_country_confirmed()` (migration 0104) joins `countries.is_supported` and backs a
trigger on ~85 financial tables. G1 (0122) seeded GB/US/SG/AE with `is_supported = false`.

The obvious way to open generic registration would have been to set `is_supported = true`. That
was **rejected**: it would have granted generic users write access to every financial table in one
statement — the exact "generic country inherits AU/IN domestic treatment" outcome G3 must prevent,
and something G4 has not certified.

Instead migration `0127` introduces a **second, strictly weaker predicate** and keeps the tiers
permanently distinct:

| Tier | Predicate | Requires `is_supported`? | Countries | Guards |
|---|---|---|---|---|
| 2 (existing, untouched) | `is_country_confirmed()` | Yes | AU, IN | ~85 financial tables |
| 1 (new) | `is_country_registration_confirmed()` | No | all six | `cross_border_relationships`, `country_change_previews` |

**Consequence:** the interim pre-G4 boundary is enforced *by the database*, on every financial
table, for free. A GB user who reached `/api/assets` directly would still be rejected with
`COUNTRY_CONFIRMATION_REQUIRED` (`42501`) by the pre-existing 0104 trigger, which this migration
does not modify in any way.

`countries.is_supported` therefore keeps its established meaning verbatim and remains true for
AU/IN only.

---

## 3. Country model

| Code | Country | Experience | Registration | Domestic capability |
|---|---|---|---|---|
| AU | Australia | FULL | Allowed | As enabled in the registry (universal + domestic calculations + domestic retirement + FX + regulatory guidance + country-specific catalogue; **not** domestic tax outputs, **not** approved billing/pricing) |
| IN | India | FULL | Allowed | As enabled in the registry (as AU, but domestic tax outputs **enabled** and domestic retirement **disabled**) |
| GB | United Kingdom | GENERIC | Allowed | Universal modules + cross-border declarations only |
| US | United States | GENERIC | Allowed | Universal modules + cross-border declarations only |
| SG | Singapore | GENERIC | Allowed | Universal modules + cross-border declarations only |
| AE | United Arab Emirates | GENERIC | Allowed | Universal modules + cross-border declarations only |
| any other | — | UNAVAILABLE | Refused | None — honest unavailable state, no fake assignment offered |

G3 changed exactly **four registry rows**: `country_capabilities.REGISTRATION` set to `true` for
GB, US, SG and AE. No AU or IN capability row was touched. No country row was added or removed.

---

## 4. Canonical types

`lib/services/jurisdiction.ts` is the single authoritative country owner.

```
AUTHORITATIVE_COUNTRY_CODES     = ['AU','IN','GB','US','SG','AE']   -> type CountryCode
FULL_EXPERIENCE_COUNTRY_CODES   = ['AU','IN']                       -> type FullExperienceCountryCode
```

`lib/constants.ts` no longer declares its own `CountryCode`; it re-exports the canonical ones. The
`components/retirement/smsf/types.ts` `CountryCode` is a *record-level* SMSF holding country and is
deliberately unchanged (record-country expansion is G6 scope).

`toFullExperienceCountryOrNull()` is the single sanctioned narrowing. A generic country maps to
`null` — never to `'AU'`, never to `'IN'` — which is exactly the value every domestic call site
already refuses to act on.

Only two production call sites needed narrowing after the widening (the compiler found them):

- `lib/services/twinData.ts` — switched to `getUserFullExperienceHomeCountry()`, so a generic
  country takes the existing honest `country_unresolved` exit instead of being bucketed into the
  AU cohort. AU/IN behaviour byte-identical.
- `lib/services/billingAuthority.ts` — pinned to `isFullExperienceCountry()` so the widening could
  not silently weaken an already-certified negative control. Pre-G3 behaviour preserved for every
  possible input.

---

## 5. Registration journey

1. Visitor picks AU / India / Global on the landing page (G2, unchanged).
2. Registration and onboarding proceed. The onboarding country select now **starts blank** —
   previously it was pre-filled `AU`, a real country the user had never chosen.
3. `/confirm-country` renders options **built from the live registry**, so a country the registry
   has deactivated or whose `REGISTRATION` capability is off is never offered.
4. The G2 cookie is read **server-side only** (it is httpOnly) and does exactly one thing: choose
   the dropdown's initial value. `GLOBAL` preselects nothing and shows an explicit "Global is not a
   country" prompt.
5. The user reads the FULL or GENERIC coverage explanation for the country they selected, derived
   from the registry's own `experience_level`.
6. A GENERIC country requires ticking an acknowledgement, never pre-checked. Changing country
   clears it.
7. `POST /api/user/country/confirm` re-reads the registry, re-derives the experience level, ignores
   any client-supplied level or capability flag (there is no request field for either), validates
   the acknowledgement version, and writes through the canonical MCC path.
8. An audit event records the confirmation, the derived experience level and the disclosure version.
9. A repeat confirmation of the same country with the same acknowledgement is an **idempotent
   replay**: existing state returned, **no second audit event**.
10. FULL users land on `/dashboard`; GENERIC users land on `/global-setup`.

**A forged G2 cookie** changes a dropdown's initial value and nothing else: it cannot widen the
registry-derived option list, cannot skip confirmation, and never reaches the confirm API (which has
no cookie access at all).

---

## 6. FULL/GENERIC disclosure

Single source: `lib/services/countryDisclosure.ts`, version `g3-generic-coverage-2026-09`.

**GENERIC body (exact wording):**

> Global coverage provides jurisdiction-neutral financial-health tools. Local tax, retirement,
> regulatory and country-specific calculations are not currently available for your country.

**Acknowledgement label (exact wording):**

> I understand that FHIP does not currently provide local tax, retirement, regulatory or
> country-specific calculations for my country, and I confirm this is genuinely my country of
> residence.

**FULL body** deliberately promises only "the country-specific functionality currently enabled" and
points at the registry — it does not claim EPF/PPF/NPS exist, and does not claim Australian tax
outputs are certified, because the registry says otherwise.

**Storage:** three additive `user_profiles` columns (`generic_disclosure_version`,
`generic_disclosure_acknowledged_at`, `generic_disclosure_country`) plus an `audit_events` row.
No new table, therefore no new RLS surface.

**Enforcement — two layers.**

*Outer (G3-R5 closure).* Confirmation is a controlled workflow. Only
`confirm_country_of_residence()` (SECURITY DEFINER RPC) may set
`country_confirmed_at`, `country_source` or any `generic_disclosure_*` column to a non-null
value; `trg_enforce_controlled_confirmation_columns` rejects a direct write by any authenticated
caller. The RPC writes the profile row **and** its `audit_events` record in **one transaction**,
so a confirmed country with no audit trail — or a stored acknowledgement with no audit trail —
is unreachable rather than merely discouraged.

Exactly one direct transition is permitted: a pure **de-confirmation**, where all five columns go
to NULL together. Revoking your own confirmation only ever removes access, and `PUT
/api/user/profile` relies on it to force re-confirmation after a country change (MCC spec 5.7).

*Inner (defence in depth).* `trg_enforce_generic_disclosure` independently refuses to let
`country_confirmed_at` be set for a GENERIC country unless the same row carries a matching
acknowledgement for that exact country. It applies to `service_role` too — there is no legitimate
path, background job or administrative script included, that should confirm a generic residence
without the disclosure. This is what still holds if the RPC itself were ever changed.

### Why the outer guard exempts non-`authenticated` callers

The threat is an authenticated browser/API client writing directly through PostgREST under RLS.
Migrations, psql sessions, background jobs and `service_role` are already inside the trust
boundary and are exempted explicitly — exactly as MCC's `enforce_country_confirmed()` and G1's
`enforce_controlled_country_columns()` both do. In real Supabase, PostgREST always stamps a role
claim on an end-user request, so the guard fires precisely where it must.

---

## 7. Reporting currency

Exactly `AUD` and `INR`, on the Profile page, unchanged from before G3. What changed is that the
independence is now explicit and tested:

- `COUNTRY_TO_CURRENCY` is keyed by `FullExperienceCountryCode`, so there is **no GB/US/SG/AE
  entry** — a currency cannot be guessed for a generic country as a compile-time fact.
- `profileSchema` has no cross-field refinement tying currency to country; all 12
  country/currency combinations validate.
- Onboarding initialises AUD for AU and INR for IN (a genuinely new profile only) and leaves a
  generic country's currency **blank**, requiring an explicit choice. The old code was
  `=== 'IN' ? 'INR' : 'AUD'`, which would have handed every generic user AUD.
- Existing users' `preferred_currency` is never read or rewritten by migration 0127.

---

## 8. Cross-border declarations

Reuses G1's `cross_border_relationships` table and API routes. New in G3: a Profile UI panel, and
`trg_enforce_cross_border_country_is_foreign`, which rejects a declaration naming the user's own
residence country and (on INSERT) a country the registry does not offer.

G3 collects the declaration only. No overseas totals, no FX conversion, no domestic/overseas split,
no NRI treatment, no consolidated forecast — those are G6.

---

## 9. Interim pre-G4 boundary

Three independent layers, all failing closed:

1. **Database** — `is_supported` stays AU/IN-only, so the 0104 trigger blocks generic users on all
   ~85 financial tables. Unbypassable from any client.
2. **API** — `countryConfirmationBlockResponse()` refuses GENERIC users **by default**, so all ~241
   country-gated routes are protected without touching 241 files. Exactly four routes opt in via
   `requireCountryConfirmedUserAllowingGeneric`: cross-border GET/POST, cross-border PATCH,
   primary-country preview, primary-country confirm.
3. **Routing** — `proxy.ts` redirects a GENERIC user to `/global-setup` from anything outside the
   allowlist `{/global-setup, /profile, /confirm-country, /onboarding}`.

The allowlist names what is **permitted**. A module added tomorrow is blocked for generic users by
default.

**What a generic user may do:** complete registration, confirm residence, read `/global-setup`,
use `/profile`, choose AUD/INR, declare cross-border relationships, run the G1 country-change
workflow, sign out.
**What remains blocked:** every financial module, every domestic calculation, SMSF, catalogue
creation, reports, billing confirmation.

---

## 10. Existing users

**No data change.** Migration 0127 writes no `user_profiles` row (only additive columns with NULL
defaults), touches no financial table, no FX row and no report snapshot.

`§11.3 — no duplicate migration`: the "existing-user confirmation" programme was completed by MCC
and is **not** rebuilt here. G3 verifies MCC's continued operation rather than duplicating it.
`is_country_confirmed()` and `enforce_country_confirmed()` are not redefined by 0127 — asserted
directly in `tests/unit/g3RegistrationAlignment.test.ts`.

---

## 11. Migration handoff

```
File:     supabase/migrations/0127_g3_registration_country_expansion.sql
SHA-256:  D4E72FF7A6E1DEA1B0410580E1A2837A9CFAC34EC554B2E0620DBAA6610659EA
Size:     36591 bytes / 613 lines
```

This is the POST-RECONCILIATION checksum, taken after merging `origin/main`
(`bd45308`) and after the G3-R5 closure added section 9 (the
`confirm_country_of_residence()` RPC and its controlled-column guard). It
supersedes the two earlier checksums recorded during development.

### MANDATORY PRE-APPLICATION CHECK

Run this **before** applying `0127`. The migration adds a CHECK constraint
restricting `user_profiles.preferred_currency` to AUD/INR. If any existing row
holds something else the ALTER will fail — and that is the correct outcome.
**Do not convert such a row.** Stop and report the counts; a non-AUD/INR
reporting currency means real user data was written through a path this
programme has not accounted for, and deciding what it should become is a
Product Owner call, not a migration's.

```sql
-- Aggregate only. No identifiers.
select preferred_currency, count(*) as n
from user_profiles
group by preferred_currency
order by n desc;
-- Expected: only 'AUD', 'INR' and possibly NULL.

select count(*) as rows_that_would_block_the_constraint
from user_profiles
where preferred_currency is not null
  and preferred_currency not in ('AUD', 'INR');
-- MUST be 0. If it is not, STOP and report.
```

Next free migration number verified as `0127` by `npm run check:migrations`
(`0079`, `0080`, `0081`, `0103` remain unused). `0125` was reserved by the then-in-flight Admin
A0.2 Wave 4 workstream and deliberately not taken — Wave 4 has since merged and **did** take
`0125`, so that reservation proved correct.

`npm run check:migrations:against-main` reports **no cross-branch collision** against the current
`origin/main` (`0e21039`), which now carries `0125` and `0126`.

**Not applied to DEV.** Product Owner authorisation for this exact file is required first.

### Verification after application

```sql
-- All six countries registration-eligible; is_supported still AU/IN only.
select c.country_code, c.experience_level, c.is_supported,
       coalesce(cc.enabled, false) as registration
from countries c
left join country_capabilities cc
  on cc.country_code = c.country_code and cc.capability = 'REGISTRATION'
order by c.country_code;
-- Expect: AU/IN FULL+is_supported=true; GB/US/SG/AE GENERIC+is_supported=false;
--         registration=true for all six.

-- The two tiers are genuinely different.
select public.is_country_registration_eligible('GB') as gb_may_register,   -- expect true
       public.is_country_registration_eligible('NZ') as nz_may_register;   -- expect false

-- The seven new functions exist.
select proname from pg_proc
where proname in ('is_country_registration_eligible','is_country_registration_confirmed',
                  'enforce_country_confirmed_registration','enforce_generic_disclosure_acknowledgement',
                  'enforce_cross_border_country_is_foreign','confirm_country_of_residence',
                  'enforce_controlled_confirmation_columns')
order by proname;  -- expect 7 rows

-- The three new constraints exist.
select conname from pg_constraint
where conname in ('countries_country_code_is_real_iso_check',
                  'user_profiles_generic_disclosure_complete_check',
                  'user_profiles_preferred_currency_supported_check')
order by conname;  -- expect 3 rows

-- The controlled-confirmation guard is armed (G3-R5).
select tgname from pg_trigger
where tgname in ('trg_enforce_controlled_confirmation_columns','trg_enforce_generic_disclosure')
order by tgname;  -- expect 2 rows

-- Existing users untouched (aggregate only, no identifiers).
select count(*) filter (where country_of_residence='AU' and country_confirmed_at is not null) as au_confirmed,
       count(*) filter (where country_of_residence='IN' and country_confirmed_at is not null) as in_confirmed,
       count(*) filter (where country_of_residence is null)                                   as missing,
       count(*) filter (where generic_disclosure_version is not null)                         as generic_ack,
       count(*) filter (where billing_country is not null)                                    as billing_confirmed
from user_profiles;
-- Expect generic_ack = 0 and billing_confirmed = 0 immediately after application.
```

---

## 12. Deliberately out of scope

| Concern | Owner |
|---|---|
| Application-wide capability realignment | G4 |
| `retirementMemberData.ts`'s `=== 'IN' ? 'IN' : 'AU'` fallback and its sibling AU-default | G5 |
| Cross-border calculations, NRI treatment | G6 |
| Reports and Resources localisation | G7 |
| CloudFront production activation, generic production rollout | G8 |
