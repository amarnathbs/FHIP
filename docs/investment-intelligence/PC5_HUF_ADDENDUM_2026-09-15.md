# PC5 Addendum — HUF (Hindu Undivided Family) as an India-only business entity

**Phase:** M4B, a scoped fast-follow to PC5 (M4)
**Branch:** `mission/m4b-huf-2026-09-15`, branched from PC5's own `1481d1ec4e0f046a064f19792bc8cd6e1976c338`
**Date:** 2026-09-15
**Production authority:** **NONE.** Nothing here is applied to production, merged to `main`, or pushed.

---

## 0. Verdict

> **CONDITIONAL PASS.**

Every line of application code, validation, UI, test and migration is written and verified.
The single reason this is not an unconditional pass is that **migration 0154 cannot be applied
to DEV from this environment**, so four of the sixteen live-DEV scenarios are honestly reported
`BLOCKED_ON_0154` rather than `PASS`. That blocker is identical in kind and cause to the one
PC5 itself carried for migration 0153, is re-verified fresh below rather than inherited, and
needs one operator action to clear.

| Evidence stream | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| Full `npx vitest run` | **16 files / 22 tests failing — byte-identical to PC5's documented baseline. ZERO new failures.** |
| New + amended unit tests | **87 tests across 4 files, all passing** (12 + 38 + 37 across the three amended files, plus the unchanged LR-11B suite) |
| Live-DEV matrix (`scripts/m4b_huf_live_dev_matrix.ts`) | **12 PASS / 4 BLOCKED_ON_0154 / 0 FAIL**, zero residue |
| PGlite post-migration verification (`scripts/m4b_huf_pglite_migration_verification.mjs`) | **19 PASS / 0 FAIL** on a real Postgres with all 149 migrations applied |
| Lint | **no finding in any file this phase touched** (repo baseline of 35 errors / 86 warnings unchanged) |
| Family Trust behaviour | **unchanged**, proven three independent ways — §7 |

---

## 1. The Product Owner's decision, and what it closes

Verbatim, 2026-09-15:

> *"it is similar to family trust, create this in similar line for only Indian users. All
> features of family trust need to adopt for HUF which is similar in nature."*

This closes **PO-PC5-1**, the named open decision PC5 raised and deliberately refused to close
itself (`PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md` §9, and K.5's CONDITIONAL PASS at
§K.5). PC5 offered the Product Owner three options and the decision selects **option (a)**:

> *"(a) accept that an HUF-held folio is recorded as a `business_entities` row, which requires
> widening `entity_type` beyond `('company','family_trust')`"*

Migration 0154 implements exactly and only that, plus the India restriction the decision adds.
PC5's option (b) — *"build real HUF entity semantics including its India tax treatment"* — is
**not** implemented, and is not claimed to be; see §9.

---

## 2. The Family Trust precedent, as it exists TODAY on this branch

Read in full and verified against the shipped code, not against LR-13's plan document. Family
Trust turned out to be **five** touch points, not the four the dispatch anticipated — the
valuation engine is the fifth, and it is a *deliberate non-change*.

| # | File (as of `1481d1ec`) | What Family Trust actually did | What M4B did alongside it |
|---|---|---|---|
| 1 | `supabase/migrations/0136_lr13_family_trust_entity_type.sql` | `drop constraint` + `add constraint ... check (entity_type in ('company', 'family_trust'))`. Additive, non-destructive, no backfill, no RLS change. | `supabase/migrations/0154_huf_entity_type_india_gate.sql` PART 1 — the identical drop+recreate, to `('company', 'family_trust', 'huf')`. |
| 2 | `lib/validation/businessEntity.ts:17` | `entity_type: z.enum(['company', 'family_trust']).default('company')` — on the **create** schema only. `businessEntityUpdateSchema` has no `entity_type` key at all, so entity type is **create-only**. | Widened to a shared `BUSINESS_ENTITY_TYPES` const `['company','family_trust','huf']`. Update schema still has no `entity_type` key — verified by test CTRL-5. |
| 3 | `lib/services/businessEntityData.ts:31` | `createBusinessEntity()` spreads the validated input (`{ ...input, user_id: userId }`) rather than hardcoding `'company'`. | **No functional change needed** — already type-agnostic. Comment only, recording why the India gate is deliberately *not* enforced at this layer. |
| 4 | `app/(app)/companies/page.tsx` | `BusinessEntityType` union, `ENTITY_TYPE_LABEL` map, `<option value="family_trust">`, heading "Companies & Trusts", per-entity display badge via `ENTITY_TYPE_LABEL[entity.entity_type]`. | All four extended for `'huf'`, with the selector option and the heading/description **conditional on India**. The label map is unconditional — see §5. |
| 5 | `lib/engines/businessEntityValuation.ts` | **Nothing.** `BusinessEntityRow` has no `entity_type` field at all, so `computeBusinessEntityNetAssetValue()` and `computeBusinessEntityOwnershipValue()` *structurally cannot* branch on entity type. | **Nothing**, for the same reason. Proven rather than assumed by three new tests. |

Two further sites the dispatch did not name but which do reference `'family_trust'` as a live
branch, and which M4B therefore also had to handle:

| # | File | Family Trust's branch | M4B |
|---|---|---|---|
| 6 | `lib/pc5/optionSets.ts:219,226` | `e.entity_type === 'family_trust' ? 'Family trust' : 'Company'` and the paired `ownerRole` ternary | Replaced with a lookup map + `businessEntityOwnerRole()`. **An HUF entity would otherwise have silently been labelled and filed as a "Company"** — a real defect this phase closes. |
| 7 | `components/ui/AppShell.tsx:107` | label updated to "Companies & Trusts" | **Deliberately NOT changed** — reasoned in §5. |

Also verified as needing no change (the string `'family_trust'` appears, but only as a
*comment* or as a value of the separate `OWNER_VALUES` vocabulary):
`lib/constants.ts`, `lib/grid/configs.ts`, `lib/grid/types.ts`,
`components/grid/FinancialDataGrid.tsx`, `lib/engines/householdContext.ts`,
`lib/aie/adapters/insurance/{documentCatalogue,write}.ts`,
`lib/services/investment-intelligence/types.ts`, `scripts/pc5_live_dev_matrix.ts`.

---

## 3. The India gate — the one thing Family Trust did not need

Family Trust is jurisdiction-**agnostic** by explicit design. Two independent statements of
that, both still live on this branch:

- `supabase/migrations/0134_lr11_business_entity_registry.sql` header, and
- `app/api/business-entities/route.ts:6-10` (pre-M4B text): *"there is no jurisdiction gate
  here at all — WP-09's own lesson is that Company/Trust must NOT copy SMSF's AU-only
  assumption without actual evidence a restriction is warranted."*

HUF is different in kind, and the Product Owner scoped it explicitly. **No new gating pattern
was invented.** FHIP has an established idiom and M4B reuses it at three layers.

### 3a. What "India" means here, precisely

**`user_profiles.country_of_residence === 'IN'`**, resolved through
**`getUserFullExperienceHomeCountry()` — `lib/services/jurisdiction.ts:172`**, which wraps
`getUserHomeCountry()` (`lib/services/jurisdiction.ts:148-161`) and narrows to the two
FULL-experience countries.

This is the canonical authoritative home-jurisdiction field. Not `households.primary_country`
(explicitly rejected by `jurisdiction.ts`'s own header), not the entity's own `country_code`
(informational and nullable, migration 0134), not `currency_code`, and never a request-body
value. It **fails closed**: `getUserHomeCountry`'s header forbids the `?? 'AU'` fallback for a
security-relevant gate, and a GENERIC-experience country (GB/US/SG/AE) narrows to `null` and is
refused exactly as an unresolved one is.

It composes with Mandatory Country Confirmation rather than duplicating it: the route already
sits behind `requireCountryConfirmedUser` (`lib/api.ts:87`), so by the time the HUF gate runs
the user has *confirmed* a country; the gate then asks whether that country is India.

### 3b. The three layers, with citations

| Layer | Mechanism | Precedent reused, with file:line |
|---|---|---|
| **DB backstop** (unbypassable) | `trg_business_entities_huf_india_gate`, a `before insert or update of entity_type, is_active, user_id` trigger comparing `user_profiles.country_of_residence` to `'IN'`, raising SQLSTATE `42501`. **Not `security definer`**, so its own SELECT is RLS-scoped and a forged `user_id` fails closed. | **`supabase/migrations/0084_geo_jurisdiction_smsf.sql:115-150`** — `retirement_accounts_smsf_au_gate()`, the mirror-image AU-only gate. Copied near-verbatim including the non-`security definer` choice, the transition-only rule, and the `42501` errcode. |
| **Route guard** (readable 403) | `getUserFullExperienceHomeCountry()` + `if (homeCountry !== requiredCountry) return bad(..., 403, 'ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY')` in `app/api/business-entities/route.ts` POST. | **`app/api/financial-data-hub/investment-statement/upload/route.ts:44-52`** (AU-only), and its paired `.../account-match/route.ts:38-46` for the machine-readable `errorCode` convention. |
| **UI affordance** (convenience only) | `app/(app)/companies/page.tsx` fetches `/api/user/profile`, reads `country_of_residence`, and simply **omits** the `<option value="huf">` for a non-India user. Never a disabled or explained option. | **`components/retirement/smsf/SmsfSection.tsx:33-36, 66`** — `const canCreate = countryOfResidence === 'AU'`, whose own header says in terms that this is *"convenience only… the real gate is server-side."* |

### 3c. Why the DB trigger is not optional

`business_entities`' RLS policy is `for all using (auth.uid() = user_id) with check (auth.uid()
= user_id)` (`supabase/migrations/0134...:150-151`). An authenticated user can therefore
`POST /rest/v1/business_entities` **directly through PostgREST with their own token**, never
touching the Next.js route. The route guard alone would be bypassable by anyone who can read a
network tab. This is precisely the situation GEO-2 faced for SMSF, and it is why 0084 added a
trigger rather than trusting `lib/validation/smsf.ts` alone.

Proven, not asserted — PGlite scenario 2, §6b: an AU user's direct insert is refused by the
database with *"huf: a Hindu Undivided Family can only be created by users whose home
jurisdiction (country_of_residence) is India."*

---

## 4. The vocabulary question (dispatch step 5), resolved

> **Does `'huf'` belong in the canonical `OWNER_VALUES` enum (and therefore in PC5's
> still-unapplied `0153` `ii_ownership_allocation.owner_role` CHECK), or is
> `business_entities.entity_type` a separate vocabulary?**

### Resolution: **they are SEPARATE vocabularies. `'huf'` goes into `entity_type` ONLY.**
`OWNER_VALUES` stays at eight. **0153's `owner_role` CHECK is left unamended** (a clarifying
comment was added to it, since 0153 is still unapplied and a reader will now ask why `'huf'` is
absent — the comment changes no SQL).

### The evidence, in the order it settles the question

**(i) The Family Trust FEATURE precedent touched `entity_type` only.** This is decisive,
because it is the precedent the Product Owner named. Migration
`0136_lr13_family_trust_entity_type.sql` is a **two-statement file**: drop the CHECK, add the
CHECK. It does not touch `OWNER_VALUES`, any register's `owner` CHECK, or
`ii_fhip_publications.published_owner`. The `'family_trust'` value already sitting in
`OWNER_VALUES` was put there by **migration 0004**, years earlier, for an unrelated purpose —
0136's own header says so: *"Reuses the exact literal 'family_trust' already used elsewhere in
this codebase (lib/constants.ts's OWNER_VALUES, migration 0004) — no new vocabulary
introduced."* The overlap is **historical accident, not design**.

**(ii) `'company'`/`'family_trust'` are RETIRED in `OWNER_VALUES`.** `lib/constants.ts:91-106`
defines `LEGACY_ENTITY_OWNER_RESTRICTIONS` and states the reason: they *"pre-date the real
Company/Family Trust entity workspace and are cosmetic-only free-text owner tags with no
valuation, consolidation, or RLS logic of their own"*, carrying a disclosed double-counting
risk, and *"no longer offered as a choice for a BRAND-NEW row on any of the 7
financial-data-grid registers."* `ownerDisplayLabel()` even renders them as "(Legacy)".
**"Adopt all features of family trust" cannot sensibly mean "adopt a retired tag."**

**(iii) PC5 itself already ruled on the ninth-value option — against.** `optionSets.ts`'s own
header and the certification §K.5 both call it out: widening the `owner` CHECK on all seven
registers plus `ii_fhip_publications.published_owner` would be *"inventing a ninth ownership
value with no valuation, consolidation or net-worth semantics behind it… Making the same
mistake a third time, in the phase whose own instruction forbids inventing entity types, would
be indefensible."* The Product Owner asked for an entity like Family Trust; they did not ask
for that.

**(iv) The blast radius confirms it.** Adding a ninth value would require, at minimum: the
`owner` CHECK on `income_sources`, `expense_items`, `assets`, `liabilities`, `investments`,
`retirement_accounts`, `insurance_policies` (all from migration 0004),
`ii_fhip_publications.published_owner`, `lib/constants.ts` `OWNER_VALUES` + `OWNER_OPTIONS`,
`lib/services/investment-intelligence/types.ts` `FHIP_OWNER_VALUES`, and 0153's
`owner_role`. Migration 0154 touches **none** of them — verified live in PGlite scenario 4.

### The consequence, and the one sub-decision it forces

If HUF is not an owner role, an HUF *entity* still needs a coarse register-level `ownerRole`
when PC5 offers it as an owner option. The pre-M4B ternary
(`e.entity_type === 'family_trust' ? 'family_trust' : 'company'`) would have silently filed it
as **`'company'`** — factually wrong, and a real latent defect this phase closes.

`businessEntityOwnerRole()` (`lib/pc5/optionSets.ts`) maps **`'huf'` → `'other'`**. Reasoning,
recorded because it is a judgement call:

- **Not `'family_trust'`**: an HUF is *not* a trust. Different formation, different governing
  law, different treatment under the Income Tax Act. Filing it under the trust role in the one
  jurisdiction where that distinction is legally operative would be a falsehood, not a
  simplification.
- **`'other'` is honest here, where PC5 said it would not be.** PC5's objection to `'other'`
  (*"carries none of its distinct tax treatment"*) was raised when HUF had **no entity
  representation at all**, so `'other'` would have been the *entire* record. Migration 0154
  removes that premise: the HUF's identity now lives on `owner_business_entity_id` →
  `business_entities.entity_type = 'huf'`, which is what the UI displays and what consolidation
  actually reads. `ownerRole` is a coarse tag with **no financial behaviour attached** —
  verified: `lib/engines/householdContext.ts` discriminates only `'smsf'`, and no valuation
  engine branches on owner role at all.
- It follows the same precedent by which `other_dependant` already maps to `'other'`.

**Disclosed for the Product Owner** as decision **PO-M4B-1** in §9 — not because it is
uncertain, but because it is a judgement the Product Owner may wish to revisit.

---

## 5. Two deliberate deviations from "adopt all features of family trust"

Both are places where copying Family Trust exactly would have contradicted the *other* half of
the instruction ("for only Indian users"). Recorded rather than silently decided.

**(a) The global nav label was NOT changed** (`components/ui/AppShell.tsx:107` stays
"Companies & Trusts"). LR-13 *did* update it. But this array is global and rendered before any
country is known: `lib/nav/appNavCapability.ts:165` filters by **capability decision, never by
country**, and no India-only capability key exists in `country_capabilities` today (the only
key that differentiates AU from IN at all is `DOMESTIC_RETIREMENT`). Naming HUF there would
advertise an India-only concept to every Australian user — the opposite of SMSF's established
rule (*"prefer removing irrelevant options entirely"*). The **page** is country-aware instead
and retitles to "Companies, Trusts & HUF" for an India user. The reasoning is recorded inline
at the nav entry so a later phase does not "fix" it.

**(b) `ENTITY_TYPE_LABEL` covers `'huf'` unconditionally**, even though the *selector* option is
India-gated. This is deliberate and copies SMSF's own rule (`SmsfSection.tsx:19-23`): an
existing entity created while the owner lived in India must stay fully visible and editable
after a move abroad. Only the offer to create a **new** one follows the user's current country.
The DB trigger implements the same asymmetry — edit and archive are never blocked, but
reactivation and conversion are (PGlite scenario 3, all five checks).

---

## 6. Migration 0154 — number, and why

### 6a. Numbering, re-verified fresh

The mission's standing finding is that `main`'s tooling under-reports the true next-free number,
because migrations `0149`-`0152` are live on DEV **and** production while absent from `main`'s
folder. So the tooling was **not** trusted on its own. Three independent checks, all run
2026-09-15 on this branch:

| Check | Result |
|---|---|
| `node scripts/check-migration-versions.mjs` | `OK: 148 active migrations, one file per version, next version is 0154.` |
| `node scripts/check-migration-versions-against-branch.mjs` | `OK: no cross-branch migration collisions between "HEAD" (148 files) and "origin/main" (136 files).` |
| `node scripts/pc5_migration_baseline_probe.mjs` (read-only, **both** live databases) | 0149's `aie_document_intake.purge_status`/`.purge_due_at` and 0150's `aie_ai_cost_ledger` **PRESENT on DEV and PRODUCTION** (confirming the standing finding still holds); **all four of 0153's objects ABSENT on both** (confirming 0153 is still unapplied and may be edited in place). |
| `scripts/m4b_huf_live_dev_matrix.ts` GATE-2 (**behavioural**, this phase's own) | A real `entity_type = 'huf'` insert on DEV is refused with SQLSTATE **23514** on `business_entities_entity_type_check` — proving 0154 has not somehow already run. |

**0154 is genuinely next-free**, sits cleanly on top of live 0149-0152 state, alongside the
still-unapplied 0153, and collides with nothing.

### 6b. What 0154 contains

- **PART 1** — `drop constraint` + `add constraint business_entities_entity_type_check check
  (entity_type in ('company', 'family_trust', 'huf'))`. Exactly 0136's pattern.
- **PART 2** — `business_entities_huf_india_gate()` + `trg_business_entities_huf_india_gate`.
  Exactly 0084 PART 2's pattern.
- Rollback SQL for both halves, in the file header.
- No new table, no new column, no RLS change, no backfill.

### 6c. 0153 was amended — comment only

0153 is still unapplied on both databases (probe above), so editing it in place is legitimate
and no redundant follow-up `ALTER` was created. **The amendment is a comment block only.** Its
`owner_role` CHECK is byte-for-byte unchanged at eight values, and the PGlite run asserts that
against the real rebuilt constraint rather than against the file.

---

## 7. Family Trust is unchanged — proven three ways

The instruction was to add HUF *alongside* Family Trust, never to alter it. Three independent
streams, each of which would have caught a regression the others might miss:

1. **Its own pre-existing tests, unmodified and passing.** `tests/unit/businessEntityValuation.test.ts`'s
   `LR-13 — schema accepts family_trust as a valid entity_type` block and
   `tests/unit/businessEntityRoutes.test.ts`'s *"creates a Family Trust entity when entity_type
   is explicitly requested"* were **not edited**. Both pass: **38/38** and **12/12** in their
   files. `tests/unit/lr11bLegacyOwnerTagRestriction.test.ts` — the suite that pins
   `'company'`/`'family_trust'` as legacy tags — is **untouched and passing** (part of the
   37/37 run). The one test whose *title and comment* were edited
   (`pc5OptionSetsAndLinks.test.ts`'s HUF assertion) had **its assertions left intact** and
   strengthened, never weakened; the edit is disclosed in the file itself.
2. **New explicit negative controls.** Route test **CTRL-4** creates a Company *and* a Family
   Trust for **both** an AU and an IN user — four combinations — proving the HUF gate did not
   make the jurisdiction-agnostic types jurisdiction-dependent. Valuation test asserts
   `computeBusinessEntityOwnershipValue([company, familyTrust])` is still exactly `220_000`,
   the same number the pre-existing LR-13 test asserts.
3. **Live and real-Postgres.** Live-DEV **H-06**: Family Trust and Company both create for both
   an India and an Australia user against the real DEV database (`{"ftIn":"family_trust",
   "ftAu":"family_trust","coAu":"company"}`). PGlite scenario 1: Family Trust and Company
   insert for both countries against the real rebuilt schema *with 0154 applied*; scenario 3's
   last check confirms the trigger **never fires** for either type in any country.

---

## 8. Evidence in full

### 8a. Unit tests

| File | Tests | Result |
|---|---|---|
| `tests/unit/businessEntityRoutes.test.ts` | 12 (7 pre-existing + 5 new M4B) | **12 PASS** |
| `tests/unit/businessEntityValuation.test.ts` | 38 (30 pre-existing + 8 new M4B) | **38 PASS** |
| `tests/unit/pc5OptionSetsAndLinks.test.ts` + `tests/unit/lr11bLegacyOwnerTagRestriction.test.ts` | 37 (33 pre-existing + 4 new M4B) | **37 PASS** |

New coverage, mirroring LR-13's own §7 shape and adding what HUF specifically needs:

- create-as-`huf` succeeds for an IN user (the parallel of LR-13's create-as-`family_trust`);
- schema-shape negative control — an arbitrary fourth type is still rejected, and `'HUF'`,
  `'huf_trust'`, `'llp'`, `''` all fail;
- **CTRL-1** a non-India user is refused `403 ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY` **and no row
  is written**;
- **CTRL-2** fails closed for an *unresolved* country, a `null` country, and a
  GENERIC-experience country (GB);
- **CTRL-3** a client-supplied `country_code: 'IN'` / `currency_code: 'INR'` cannot buy the gate
  off;
- **CTRL-4** Company and Family Trust remain jurisdiction-agnostic (§7);
- **CTRL-5** `entity_type` is create-only — a `PATCH` smuggling `entity_type: 'huf'` alongside a
  rename applies the rename and **drops** the type change;
- the valuation engine is entity_type-agnostic (three tests, including an INR→AUD fx case);
- the vocabulary boundary — every allowed `entity_type` maps into the canonical eight, `'huf'`
  maps to `'other'` and *not* to `'family_trust'`, and Family Trust/Company keep their exact
  pre-M4B roles.

### 8b. Live-DEV matrix — `npx tsx scripts/m4b_huf_live_dev_matrix.ts`

Real disposable users, real password sign-in, real DEV database
(`vqycarelcoijzwlpkpcz.supabase.co`), real production service functions. **12 PASS / 4
BLOCKED_ON_0154 / 0 FAIL.**

| ID | Scenario | Result |
|---|---|---|
| GATE-1/2 | 0154 not applied to DEV; the live CHECK genuinely refuses `'huf'` (SQLSTATE 23514) | **PASS** (→ SUBSTRATE mode) |
| SETUP-1 | four disposable users created (IN, AU, GB-generic, unconfirmed) | **PASS** |
| H-01 | `getUserFullExperienceHomeCountry` resolves `IN`/`AU` live and narrows GB and unset to `null` | **PASS** |
| H-02a | an India user **passes** the jurisdiction gate (the gate is not the blocker) | **PASS** |
| H-02b | an India user creates a real HUF row | **BLOCKED_ON_0154** |
| H-03 ×3 | an AU / GB / unconfirmed user is refused `403` **before any write** | **PASS ×3** |
| H-04 | a body-supplied `country_code: IN` cannot buy the gate off | **PASS** |
| H-05 | an AU user's **direct PostgREST** insert is refused by the database | **BLOCKED_ON_0154** |
| H-06 | Family Trust + Company still create for both IN and AU | **PASS** |
| H-07 | the HUF's ownership-scaled share reaches Net Worth via the same consolidation path | **BLOCKED_ON_0154** |
| H-08 | `resolveOwnerOptions` surfaces the HUF with the right detail and `ownerRole` | **BLOCKED_ON_0154** |
| H-09 | every owner role in the **live** option set is one of the canonical eight | **PASS** |
| CLEANUP | every user and row independently **re-queried** absent | **PASS — zero residue** |

`BLOCKED_ON_0154` means PC5's own SUBSTRATE semantics: the code genuinely reached the database
and the only missing thing was the schema. Materially different from "not tested".

**A real platform guard was discovered by this run**, disclosed rather than worked around: a
GENERIC-experience residence country (GB) **cannot be marked confirmed** without a matching
coverage-disclosure acknowledgement — `enforce_generic_disclosure_acknowledgement`, migration
`0127_g3_registration_country_expansion.sql:235-264`, which deliberately applies to
`service_role` too. The fixture was corrected to satisfy it, so the GB user is the *real* state
a GB user reaches rather than an impossible one.

### 8c. PGlite post-migration verification — `node scripts/m4b_huf_pglite_migration_verification.mjs`

Because 0154 cannot be applied to hosted DEV, the four blocked scenarios were proven against a
**real Postgres** with the entire 149-migration chain applied — the identical documented
substitute `scripts/r12_post_migration_pglite_verification.mjs` established for migration 0092
under the same constraint. Real CHECK constraints, real triggers, real RLS with a real
`set role authenticated` and a real `auth.uid()`. **19 PASS / 0 FAIL.**

This proves what the live matrix structurally cannot until an operator acts: the whole chain
applies cleanly; the widened CHECK accepts `'huf'` and still accepts and rejects exactly what it
did before; the India gate refuses a non-India user's HUF **at the database**, closing the
direct-PostgREST bypass; the gate never fires for Company or Family Trust in any country; an
existing HUF stays editable and archivable after its owner moves abroad while reactivation and
conversion are re-gated; a forged `user_id` fails closed; and no `'huf'` reached the `owner`
CHECK on any of the seven registers, or `ii_ownership_allocation.owner_role`, or
`ii_fhip_publications.published_owner`.

> **A harness defect was found and fixed during this run, and is disclosed because the first
> result it produced was wrong in the reassuring direction.** The first draft used `set local
> role authenticated`. PGlite autocommits each statement, so a transaction-local GUC is
> discarded before the next query and `auth.uid()` reads NULL — silently disabling RLS. The
> forged-`user_id` control reported "NOT REFUSED — forgery succeeded", which was a **harness**
> failure, not a product one. Fixed by adopting `scripts/db-rebuild-check/rls.mjs`'s own
> `asTenant` technique: session-scoped `set_config(..., false)` plus a **hard assertion that
> `auth.uid()` really is the intended user before any claim is made**. The final run asserts
> `0 vacuous statement(s)` as its own reported line.

### 8d. Regression

| | |
|---|---|
| Full suite on this branch | **16 files / 22 tests failing** |
| PC5's documented baseline (`PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md` §7) | **16 files / 22 tests failing** |
| **New failures introduced by M4B** | **ZERO** |
| Independently re-measured at the base commit `1481d1ec` | `tests/unit/smsfHouseholdIsolation.test.ts` fails **8/40 before any M4B change** — identical to its post-change result |
| Typecheck | `tsc --noEmit` **clean** |
| Lint | **zero findings in any file M4B touched**; repo baseline unchanged |

The 22 baseline failures are PC5's own documented inheritance: nine `resources*` suites failing
at **collection** time for missing DEV env vars (0 failing assertions — environmental), and
seven suites with genuine pre-existing assertion failures in SMSF/debt-ratio/isolation
territory, none of which M4B touches.

---

## 9. Open items for the Product Owner

**PO-M4B-1 — an HUF entity's coarse register-level owner role is `'other'`.** Resolved on
evidence (§4) and implemented, but recorded because it is a judgement the Product Owner may
wish to revisit. The HUF's real identity is never lost — it lives on
`business_entities.entity_type = 'huf'`, which is what the UI shows and what consolidation
reads. Changing this later would mean minting a ninth `OWNER_VALUES` value and widening nine
constraints; it is not a one-line change.

**PO-M4B-2 — HUF tax semantics are NOT implemented.** Exactly as Family Trust ships with no
trustee/beneficiary/distribution-rule model, HUF ships with no karta, coparcener, HUF-deed or
partition model, and is **not** linked to `ii_tax_profiles.taxpayer_type = 'RESIDENT_HUF'`
(migration 0061), which remains a separate income-tax *filing status*. This is PC5's option (b),
which the Product Owner's decision did not select. An HUF's value reaches Net Worth through the
identical `ownership_percentage` consolidation Company and Family Trust use — the user's own
declared economic share, however it is legally structured. Stated plainly so no later phase
inherits a false assumption.

## 10. The one blocker

> **An operator must apply migrations 0153 and 0154 to DEV.**

Re-verified fresh, not inherited: `node scripts/pc5_ddl_capability_probe.mjs` (2026-09-15) finds
**no** exec/DDL RPC among PostgREST's exposed functions on DEV, **no** Management-API token
(`SUPABASE_ACCESS_TOKEN`/`SUPABASE_MANAGEMENT_TOKEN`/`SUPABASE_PAT` all absent) and **no**
direct Postgres connection string (`DATABASE_URL`/`POSTGRES_URL` absent). Applying a migration
requires Supabase dashboard or CLI access this environment does not have.

Once applied, re-running `npx tsx scripts/m4b_huf_live_dev_matrix.ts` should turn all four
`BLOCKED_ON_0154` lines into `PASS` — the script detects 0154 automatically and switches to FULL
mode. Their expected behaviour is already proven against a real Postgres (§8c); what re-running
adds is confirmation on the *hosted* database specifically.

Nothing else is outstanding. **No production authority is requested or assumed.**
