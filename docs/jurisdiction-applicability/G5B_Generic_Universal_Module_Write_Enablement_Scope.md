# G5B — Generic Universal-Module Write Enablement: Scoping Document

Status: **SCOPED, NOT STARTED.** Per the Product Owner's G5 continuation ruling
(2026-09-05): "If the database work is too large for the present G5 branch,
formally split it into G5B ... complete G5B before starting G6." This document
is that split. No schema change, no migration, no application code change is
made by this document. It exists so a future implementer (human or agent) can
start G5B without re-deriving the architecture from scratch.

Branch: to be created from `feature/g5-existing-module-realignment` at the
commit that closes G5 (this document's own commit, or later). Do not start
G6 work on any branch until G5B reaches a certified verdict — this is an
explicit Product Owner sequencing constraint, not a suggestion.

---

## 1. The problem, precisely

Every user-owned financial-data table in FHIP that accepts direct
authenticated `INSERT` is protected by exactly ONE shared database trigger
function, `enforce_country_confirmed()` (migration `0104`, onboarding-exemption
fixed in `0105`), applied individually per table but always calling the same
predicate: `is_country_confirmed(user_id)`.

`is_country_confirmed()` (migration `0104`) is:

```sql
select exists (
  select 1 from user_profiles up
  join countries c on c.country_code = up.country_of_residence and c.is_supported
  where up.user_id = p_user_id and up.country_confirmed_at is not null
);
```

`countries.is_supported` is `true` for AU/IN only (migration `0001`'s original
column, reused verbatim by `0104`; explicitly NOT touched by G1's later
`experience_level`/`selectable` columns — see migration `0122`'s own comment,
quoted in `lib/services/jurisdiction.ts`: "a country may be
`experience_level=GENERIC` ... without becoming `is_supported=true` for MCC
residence purposes"). So today, **every GENERIC-experience user
(GB/US/SG/AE) — even one who has explicitly confirmed their country and
completed onboarding exactly like an AU/IN user — is rejected with
`COUNTRY_CONFIRMATION_REQUIRED` (`42501`) on every one of these tables**:

- The 8 foundational tables from `0104`: `income_sources`, `expense_items`,
  `assets`, `liabilities`, `investments`, `retirement_accounts`,
  `insurance_policies`, `user_goals`.
- The 69 further "GENERIC-classified" tables from `0105`'s full inventory
  (direct `user_id` column, same trigger function) — e.g. `households`,
  `financial_snapshots`, `goal_contributions`, `retirement_members`, etc.
- The 3 bespoke-owner-column tables from `0105` (`professional_notes` via
  `author_user_id`, `financial_twin_insights`/`financial_twin_metric_results`
  via a join to the parent run) — same rule, different trigger function.

Meanwhile, the separate G4 application-capability layer
(`lib/services/appCapability.ts`) has already independently evidence-reviewed
three of those eight foundational tables' modules — **INCOME**
(`income_sources`), **EXPENSES** (`expense_items`), **INSURANCE**
(`insurance_policies`) — and found no country/currency hardcode and no
missing per-item gate, certifying their VIEW as genuinely universal. Their
`CREATE`/`UPDATE` operations are deliberately held at
`UNAVAILABLE_FOR_GENERIC_WRITE` (see `OPERATIONS_WRITE_NOT_YET_CERTIFIED` in
`appCapability.ts`) specifically because — as that file's own comments say —
the database backstop already blocks any GENERIC `INSERT` regardless of what
the resolver decides, so there was nothing unsafe about leaving the
capability flag off *for now*. G5B is that "for now" being resolved.

**Net effect the Product Owner is closing**: a brand-new GENERIC user can
complete registration, confirm their country, complete onboarding — and then
be unable to record so much as one income row or one expense row anywhere in
the app, even though the code that would handle that row has been reviewed
and contains nothing AU/IN/GENERIC-unsafe. The blocker is purely the
single shared trigger's blanket "is_supported" check, not any known
correctness problem in the write path.

---

## 2. Why this is NOT a G5 (this-branch) fix

The prior G5 dispatch and this continuation were scoped around two
already-confirmed AU-default code defects (`lib/services/retirementMemberData.ts`,
the FDH-11 investment-statement bridge) — both application-layer,
single-file, no-migration fixes. Item 3 is categorically different:

- It requires a **schema change** (a new capability manifest, at least one
  new/replaced trigger function) — governance for this task explicitly
  forbids applying any migration to DEV/production without direct Product
  Owner approval, and forbids attempting a rushed, under-tested database
  permission model.
- It requires **default-deny correctness proof across ~80 tables**, not 2
  files — a much larger certification surface than G5-D1/G5-D2.
- It requires **drift-proofing between two independently-maintained
  manifests** (the TypeScript `appCapability.ts` module manifest and
  whatever new DB-side manifest this introduces) — a new invariant with no
  existing test to extend, unlike G5-D1/D2 which slotted into
  already-established canonical helpers (`jurisdiction.ts`).
- Getting any of the above wrong in either direction is a real security
  regression (over-permissive: a GENERIC user's forged direct-PostgREST
  INSERT reaches a domestic-only table like `assets`; under-permissive: the
  fix silently fails to actually unblock the three certified-universal
  tables, leaving the Product Owner's stated problem unsolved) — exactly the
  class of risk governance point 5 says must not be attempted under time
  pressure alongside two other closure areas in one sitting.

---

## 3. In scope for G5B

1. **A default-deny, per-table/per-operation database write-capability
   model**, replacing the blanket `is_country_confirmed()` INSERT check for
   GENERIC-experience users specifically — FULL (AU/IN) behaviour must be
   provably byte-identical to today for every table (no AU/IN regression is
   acceptable; this is purely about what changes for GENERIC).
2. A **capability manifest** (a new table, e.g. `mcc_generic_write_capabilities
   (table_name text, operation text check (operation in ('INSERT')), 
   generic_write_allowed boolean not null default false, certified_at
   timestamptz, certified_reason text, primary key (table_name, operation))`
   or equivalent) seeded so that:
   - `income_sources`, `expense_items`, `insurance_policies` →
     `generic_write_allowed = true` (matching the three app-layer modules
     G4 already certified VIEW-universal and evidence-reviewed for write
     safety in this continuation's toolchain/live-DEV work — re-confirm the
     evidence review is still accurate before seeding, do not just copy it
     forward unchecked).
   - Every other currently-covered table (5 remaining foundational tables:
     `assets`, `liabilities`, `investments`, `retirement_accounts`,
     `user_goals`; all 69 GENERIC-classified tables from `0105`; the 3
     bespoke-owner tables) → `generic_write_allowed = false`, i.e. no
     behaviour change from today.
   - Any table not yet in the manifest at all → **denied** (default-deny is
     the literal absence of a `true` row, not a separate flag) — this must
     be true both for tables that exist today and are simply omitted by
     mistake, and for any table created by a future migration that never
     adds itself to the manifest.
3. A **generic (or small, owner-shape-keyed set of) trigger function(s)**
   that, for INSERT specifically:
   - Keep every existing exemption unchanged: `service_role` bypass,
     onboarding-incomplete bypass (migration `0105`'s fix).
   - Still require a genuinely confirmed country (`country_confirmed_at is
     not null` and a recognised `country_of_residence`) for EVERY user
     regardless of experience level — this is NOT a relaxation of "must be
     confirmed," only of "must be AU/IN." An unconfirmed user of any country
     must still be rejected exactly as today.
   - For a confirmed FULL (AU/IN) user: unchanged (`is_supported` check
     passes as today).
   - For a confirmed GENERIC user: additionally allowed only when
     `(TG_TABLE_NAME, 'INSERT')` has `generic_write_allowed = true` in the
     manifest.
   - Must NOT redefine `is_country_confirmed()`'s existing signature/meaning
     in place — other consumers (`lib/services/countryGate.ts`'s
     application-layer classification, and any other direct SQL caller) must
     not silently change behaviour. Add a new predicate
     (e.g. `is_write_permitted(p_user_id uuid, p_table text)`) instead, and
     have the trigger(s) call the new predicate, not overload the old one.
4. **Drift-proofing between the TypeScript and DB manifests.** Concretely:
   - Make each `ModuleCapabilityRule` in `appCapability.ts` carry an
     explicit, machine-readable list of the table(s) its CREATE operation
     writes to (today this is prose in the `note` field, not data — G5B
     must make it structured).
   - Add a test (`tests/unit/` or a live-DEV script) that reads both
     manifests and asserts: every module whose `CREATE` policy would resolve
     to `ENABLED` for a GENERIC user has ALL of its declared tables at
     `generic_write_allowed = true` in the DB manifest, and — the other
     direction — every DB manifest row with `generic_write_allowed = true`
     is claimed by at least one app-layer module that actually permits
     GENERIC create. Neither manifest may say yes while the other says no.
   - Decide (Product Owner input needed) whether the DB migration or the
     `appCapability.ts` flip ships first, or whether they must ship in the
     same reviewed change — shipping the app-layer flip first would show a
     GENERIC user a live "Add" control the DB still 42501s on; shipping the
     DB migration first silently reopens a write the UI still hides
     (safe, but leaves the Product Owner's stated problem unsolved until the
     second half lands). Recommendation: same PR/change, migration applied
     first in DEV, live-verified, then the two app-layer manifest entries
     flipped and verified against the now-updated DEV database, both merged
     together.
5. **Migration file(s), prepared only** — written to
   `supabase/migrations/` with the next free number at the time G5B actually
   starts (re-run `npm run check:migrations` and
   `check:migrations:against-main` first — this repo has hit the same
   sibling-branch migration-number collision five distinct times per
   `MEMORY.md`), and handed off for Product Owner DEV SQL-Editor application.
   G5B must NOT apply its own migration.
6. **A live-DEV certification script** (extend the
   `mcc_livedev_terminal_certification.mjs` pattern — synthetic
   `*@fhip-test.invalid` identities only, cleaned up with independent
   re-verification) that, once the Product Owner has applied the migration
   to DEV, proves:
   - A GENERIC user CAN insert into `income_sources`, `expense_items`,
     `insurance_policies` (both via the real app route once flipped, and via
     a direct PostgREST INSERT using that user's own real JWT — the DB is
     the layer of record, so both paths must work, not just the app route).
   - A GENERIC user CANNOT insert into any of the other ~80 covered tables
     (a real negative-control sweep across the full table list, not a
     sample) — reuse `scripts/mcc_full_table_inventory.mjs`'s discovery
     method to regenerate the current table list at G5B's own start, since
     new tables will have been added between `0105` and G5B.
   - AU/IN behaviour is unchanged across the same full sweep (no new
     `is_supported`-path regression).
   - MCC-14's user-deletion cascade behaviour (migration `0111`) is
     unaffected (different trigger/path; verify by regression, do not modify).
   - The onboarding-incomplete exemption still holds for a GENERIC user
     exactly as for AU/IN (the exemption is orthogonal to experience level).

## 4. Explicitly deferred / out of scope for G5B

- **ASSETS, LIABILITIES, INVESTMENTS, RETIREMENT, GOALS.** G4's own manifest
  notes already disclose real, unremediated domestic hardcodes in these five
  (hardcoded AU/IN `country_code`/`currency_code` enums in validation, a
  missing `assertItemCreationAllowedForUser`-equivalent gate on Assets).
  G5B's database model must default-deny them exactly as today. Opening any
  of them to GENERIC writes is a separate, later, application-layer
  remediation task — it must not be attempted as part of G5B, and G5B's own
  manifest must not accidentally default them to allowed.
- **SCORES, DNA, RESILIENCE `CREATE`/`UPDATE`.** These are derived/computed
  modules with no direct user-facing "create a score" form; G4 already
  established there is nothing a GENERIC caller could ever validly write or
  delete here. Leave `OPERATIONS_WRITE_NOT_YET_CERTIFIED` (or an equivalent
  explicit "moot" policy) untouched unless a future dispatch finds an actual
  write surface.
- **RLS `SELECT`/`UPDATE`/`DELETE` policies.** G5B is scoped to the
  `BEFORE INSERT` backstop only, exactly mirroring migration `0104`/`0105`'s
  own stated scope ("Blocks INSERT only ... existing rows, and edits to them,
  are never touched").
- **MCC-14 cascade-aware delete fix.** Referenced only as a regression
  check; G5B must not modify it.
- **Billing/pricing/FX capabilities, Resources CMS write gating.** Untouched;
  not part of the Product Owner's ruling.
- **Any change to which countries are `is_supported`, `selectable`, or have
  a given `experience_level`.** G1/G3 registry data is out of scope; G5B
  only changes what a table's trigger checks, never the registry itself.

## 5. What a future implementer needs to know before starting

- Reuse, do not re-derive: `scripts/mcc_full_table_inventory.mjs` (table
  discovery), `scripts/mcc_classify_tables.mjs` (owner-shape classification),
  `scripts/mcc_table_classification.json` (the last-known classification —
  re-run the discovery script first, do not trust this file as current),
  `lib/services/jurisdiction.ts` (the only place "known country" /
  "full-experience country" is defined), `lib/services/appCapability.ts`
  (the only place a module's capability decision is defined).
- The three candidate tables' safety review (no country/currency hardcode,
  no missing per-item gate) was done by the G4 agent, not independently
  re-verified live against DEV data by this continuation beyond the
  code-reading and reasoning documented in this file and the accompanying
  G5 report. Re-confirm before seeding the manifest with `true` for them —
  do not treat "G4 said so" as sufficient without your own check, per this
  project's own stated verification standard.
- `is_country_confirmed()` is read by more than the trigger — grep for it
  before changing its signature. `countryGate.ts`'s application layer uses
  its own logic (not necessarily calling this SQL function directly, but the
  same conceptual predicate) — confirm no double-drift is introduced.
- The `.env.local` in this worktree points at DEV
  (`vqycarelcoijzwlpkpcz`). There is no production access for this work
  under any circumstance (per this task's own governance) — G5B inherits
  the same constraint.

## 6. Sequencing constraint (Product Owner ruling, verbatim)

> If the database work is too large for the present G5 branch, formally
> split it into G5B ... but complete G5B before starting G6.

G6 must not begin until G5B reaches a certified verdict (FULL PASS or an
explicitly-accepted CONDITIONAL PASS) from the Product Owner. This is a hard
gate, not a scheduling preference.
