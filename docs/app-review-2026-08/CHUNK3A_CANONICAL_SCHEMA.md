# Chunk 3a — Assets/Investments/Retirement Canonical Schema Design

Additive schema design for the "FHIP — Assets, Investments & Retirement"
spec ("Spec 2") and Spec 1 §9/§21-22, off Chunks 1-2
(`b311ca3` on `feature/app-review-input-integrity-production`, based on
`main`@`fe7a094`). **Additive only** — no deprecation/merging of existing
duplicate catalogue items, no data migration of existing rows, no Financial
DNA changes. Those are 3b (catalogue de-duplication + migration) and 3c
(Financial DNA) — see the handoff section at the end.

---

## 1. `financial_holding_id` identity inspection (item 1, Spec 2 §44)

Spec 2 §44 explicitly instructs: *"Do not create this abstraction merely for
architectural elegance if the current schema already solves identity
safely. Inspect first."*

**Finding: the current schema already solves it. No new abstraction was
built.**

- `master_financial_items.item_key` is already a stable, unique-per-category
  code for a *catalogue entry* (`unique(category, item_key)`, migration
  `0004_financial_data_grid.sql:11`), never reused or renamed once live —
  `seed_master_items.sql`'s own header says so, and migration `0031`
  (Chunk 1) demonstrates the discipline in practice (deprecate-in-place, add
  a new row, never rename).
- Every user-owned register (`assets`, `investments`, `retirement_accounts`,
  etc.) already has its own immutable `id uuid primary key default
  gen_random_uuid()` identifying one specific user's holding row. Other
  tables already reference it (e.g. `financial_records_audit.entity_id`).
  Editing a row's value, owner, currency, purchase details, SMSF mode, etc.
  never changes its `id`.

The combination of a holding row's own `id` (durable per-holding identity)
plus its `master_item_key` (durable per-catalogue-type identity, nullable
for custom rows) already gives every holding a stable identity that
survives edits — exactly what Spec 2 §44 asks for. A synthetic
`financial_holding_id` column would be a pure synonym for the existing `id`
with no new capability.

**The one scenario where a synthetic cross-table identity might eventually
matter**: 3b's future catalogue consolidation, where a row currently in
`assets` (e.g. `commercial_property`) gets consolidated into the
`investments` table — the destination row would get a *new* `id`, so
anything that had referenced the old `assets.id` (there is nothing today,
per a repo-wide grep for FK references into these tables beyond
`financial_records_audit`, which is itself append-only/audit-log) would lose
the link. That is a real but narrow concern, and it is 3b's to assess when
it actually designs the consolidation mechanics — not something to
pre-build speculatively in a chunk explicitly scoped to "additive schema
design only." **This finding meaningfully narrows item 1's scope**: no
`financial_holding_id` migration, no dual-write, no ORM-level change — just
the category-metadata columns below.

---

## 2. Category metadata on `master_financial_items` (item 1, Spec 1 §9 / Spec 2 §46)

**Migration**: `supabase/migrations/0033_master_item_category_metadata.sql`
(adds columns, all additive with safe defaults) +
`0034_master_item_category_metadata_seed.sql` (populates the 88 existing
asset/investment/retirement rows — 39 + 32 + 17 per the discovery doc's
pre-Chunk-1 count; the live catalogue now also has the `collectibles` row
Chunk 1 added under `asset`, which is populated too).

New columns: `requires_purchase_date`, `supports_purchase_date`,
`requires_purchase_price`, `supports_purchase_price`, `requires_country`,
`requires_currency`, `supports_income_link`, `supports_liability_link`,
`current_value_source` (`balance` \| `market_value` \| `calculated` \|
null), `future_flow_source` (boolean), `purpose_dimension` (`personal` \|
`investment` \| null).

**UI wiring**: `components/grid/FinancialDataGrid.tsx` +
`lib/grid/configs.ts` + new pure module `lib/grid/fieldVisibility.ts`.
`assetGridConfig`'s `purchase_price`/`purchase_date` fields are now marked
`metadataDriven: true`; `FinancialDataGrid.tsx` calls
`resolveFieldVisibility(row, field)` per row to decide show/hide/require/
read-only, replacing the previous behaviour of showing both fields
uniformly for all 39+ asset types regardless of whether "purchase price"
even makes sense (e.g. a savings account balance).

Behaviour:
- Not supported + no saved value → field hidden (rendered as `—`).
- Not supported + a value **was already saved** (e.g. metadata changed
  after the fact) → field stays **visible, read-only** — no saved
  `purchase_date` is ever silently dropped.
- Supported → shown, editable, required only if the metadata says so.
- Custom rows and any row whose metadata hasn't loaded (e.g. before these
  migrations are applied) fall back to today's exact behaviour: always
  shown, never required.

**Disclosed judgement calls** (see `0034`'s own inline comments for the
full reasoning):
- `requires_purchase_date`/`requires_purchase_price` are **false for every
  item** in this seed, even where `supports_*` is true. These fields are
  optional today for every asset type, and per this chunk's backward-
  compatibility constraint, turning any of them into a hard requirement is
  a Product Owner business-rule decision, not a default this pass should
  set unilaterally. The wiring is complete and ready — flipping a specific
  `item_key` to `requires_purchase_date = true` needs a one-line `UPDATE`,
  no code change.
- `purpose_dimension` is left **null** for `holiday_home`, `vacant_land`,
  `farm` — the discovery doc flags these three as genuinely ambiguous with
  no existing signal to disambiguate at the catalogue level (unlike
  gold/silver/collectibles/commercial-property, which have a same-key row
  in the other module to anchor the classification against). A future
  phase could add a real per-user-row purpose toggle for these three; this
  migration does not invent one.

---

## 3. SMSF Summary/Detailed mode (items 2-3, Spec 2 §23, §38-42)

**Migration**: `supabase/migrations/0035_smsf_structured_model.sql`.

- `retirement_accounts.smsf_mode` (`summary` \| `detailed` \| null). Null
  for every account today (including every existing `smsf`-type account) —
  this migration changes no existing row.
- New table `smsf_holdings` (`id`, `user_id`, `retirement_account_id`,
  `holding_type` — `cash|shares|etfs|managed_funds|term_deposits|
  property|other` — `value`, plus the property-specific fields below),
  linked to `retirement_accounts`, RLS-protected.
- **Mode-switching discipline (Spec 2 §41)**: enforced structurally, not by
  a runtime check that could be bypassed. `lib/engines/smsf.ts`'s
  `computeSmsfTotal(account, holdings)` is an `if (mode === 'detailed')
  { sum holdings } else { return current_balance }` — an if/else, never an
  addition of both sources — so a stale `current_balance` left over from
  before an account switched into Detailed mode can never be summed on top
  of the holdings total. Verified against Spec 2's exact worked example in
  `tests/unit/smsf.test.ts`: cash 50,000 + shares 150,000 + property
  500,000 = 700,000, and explicitly asserted **not** 1,400,000 even when a
  stale 700,000 `current_balance` is also present on the account.
  `isDoubleCounted()` is a second, independent assertion helper for the
  same invariant.

### SMSF property (item 3, Spec 2 §23/§42)

`smsf_holdings.holding_type = 'property'` carries `acquisition_price`,
`acquisition_date`, `country_code`, `currency_code`,
`linked_income_source_id` (→ `income_sources.id`, for the rental-income
link) and `linked_liability_id` (→ `liabilities.id`, for the loan link).
This is the **one canonical place** SMSF property can be entered — no
standalone "SMSF property" option was added to the plain
assets/investments/liabilities grids, so no new double-entry path exists
going forward.

**Explicitly out of scope for this sub-chunk**: reconciling any SMSF
property a user may have *already* mis-entered as a plain `asset.
investment_property`/`investment.property` row (this schema didn't exist
before now, so nothing could have used it correctly). That reconciliation
is 3b's data-migration job.

---

## 4. Retirement member/account/contribution separation (items 4-5, Spec 1 §21-22, Spec 2 §29-36)

**Migration**: `supabase/migrations/0036_retirement_member_contribution_model.sql`.

### Member-concept inspection (parallel to item 1's inspection)

Before adding a new `retirement_members` table, this migration checked
whether the app already has a clean per-member concept, per the task's
explicit "check first" instruction. **It does**: `household_members`
(`0009_module7_goals.sql:11-22`) already has `id`, `user_id`, and a
`relationship` enum including `self`/`spouse`/`partner`/`child`/`parent`/
`other_dependant`/`other`, plus its own full CRUD API
(`app/api/household-members/`). **But it currently has zero consumers** —
confirmed via a full-repo grep: no page renders it, no engine reads it, only
its own API routes reference it. Rather than build a second, competing
`retirement_members` table, this migration:

- adds `target_retirement_age` directly onto `household_members` (a
  person-level planning fact belongs on the person-identity row, not a
  retirement-module-specific shadow table), and
- adds a nullable `retirement_accounts.household_member_id` FK to link an
  account to the member whose target age governs it.

Also extended `lib/validation/householdMember.ts`'s Zod schema with the
same optional `target_retirement_age` field, so the pre-existing
`household-members` API can actually persist it once the migration is
applied — otherwise the column would exist with no write path.

**Backward compatibility**: `retirement_accounts.target_retirement_age`
(the original per-account field, `0004_financial_data_grid.sql`) is **not**
dropped, renamed, or stopped being written — every existing account keeps
its value, and the Financial Twin (`lib/services/twinData.ts`,
`lib/engines/twin/metricDerivation.ts`) keeps reading it completely
unchanged. `household_member_id` defaults to null. Wiring app consumers
over to the new per-member field, and only showing a spouse's field "when a
spouse/partner genuinely exists on the household" (per the task brief), is
UI/consumer work explicitly left to 3b/3c — this sub-chunk adds schema, not
pages.

### Account-vs-contribution separation (Spec 2 §34-36) + spouse contribution as a relationship (Spec 1 §21, Spec 2 §36)

New table `retirement_contributions` (`id`, `user_id`,
`retirement_account_id`, `contribution_type` — the 6 Class-F catalogue
concepts — `amount`, `frequency`, `contributor` — `self` \| `spouse` —
`is_active`, `notes`), RLS-protected. A spouse contribution is simply a row
with `contributor = 'spouse'` whose `retirement_account_id` points at the
**recipient** member's account — "who contributes to whose account" per
Spec 2's framing — falling naturally out of `contributor` being a real
column rather than a separate table or an inferred label. No new table or
special-casing was needed for item 5 beyond this.

Pure functions in `lib/engines/retirementAccounts.ts`, tested against Spec
2's exact worked example in `tests/unit/retirementAccounts.test.ts`:
`computeRetirementAccountCurrentValue({ current_balance: 200000 })` returns
`200000`; adding a `1,000/month` employer contribution
(`sumRetirementContributionsMonthly`) computes `1000` as a separate monthly
flow figure, and the account's current value is asserted to remain
`200000`, explicitly **not** `201000`.

**A live defect this design surfaces** (not fixed here — flagged for 3b):
`dashboard.ts:540` already correctly treats `retirement_accounts.
current_balance` as the sole current-value source (it does *not* add
`employer_contribution`/`personal_contribution` on top — those only feed a
separate `retirementContributionRate` metric). But the 6 Class-F catalogue
items (`employer_contributions`, `salary_sacrifice`, etc.) are *today*
offered as ordinary tickable items in the Retirement grid — ticking one
creates a normal `retirement_accounts` row like any other, with whatever
number the user types going straight into `current_balance`. Since
`dashboard.ts` sums every `retirement_accounts` row's `current_balance`
identically regardless of `master_item_key`, a user who ticks "Employer
Contributions" and enters e.g. `12,000` (meaning "$1,000/month × 12") has
that phantom balance summed straight into `totalRetirement`, double-
counting against their real super account. This is exactly the class of bug
Spec 2's worked example warns about, confirmed to exist in the *current*
flat-catalogue model. Fixing it requires moving those 6 catalogue rows off
the flat grid onto `retirement_contributions` (a UI/data-migration change),
which is 3b/3c's job — this sub-chunk only builds the schema that makes the
fix possible.

---

## 5. India retirement catalogue: EPF, PPF, NPS (item 6, Spec 2 §32)

**Migration**: `supabase/migrations/0037_india_retirement_catalogue.sql`.
Pure addition — no existing retirement catalogue row touched. Three new
active `retirement`-category rows: `epf`, `ppf`, `nps`, `sort_order`
180/190/200 (continuing after the existing max of 170, so no other item's
order is disturbed).

Structural classification (per the task's "enough not to misclassify, not
deep research" scope):
- **EPF** (Employees' Provident Fund) and **PPF** (Public Provident Fund):
  balance-style accounts — `current_value_source = 'balance'`, no purchase
  concept.
- **NPS** (National Pension System): has both an account balance *and* a
  Tier I/II contribution-tier structure. This migration classifies it at
  the same balance-style level as EPF/PPF (the account balance is what
  matters for net worth) and does **not** attempt to model NPS's tier
  structure — a known, disclosed gap for a future phase, not glossed over.

---

## 6. Retirement-income/decumulation product review (item 7, Spec 2 §37)

**Investigated, not touched** (this is 3b's consolidation territory).

- **`allocated_pension` and `account_based_pension` — confirmed genuine
  duplicates.** Within Australia's superannuation system (FHIP's only
  currently-supported jurisdiction for this catalogue), "Account-Based
  Pension" is the standard term used since Australia's 2007 Simplified
  Superannuation reforms; "Allocated Pension" is the legacy pre-2007 name
  for the same underlying product. There is no functional distinction FHIP
  would ever model differently between the two — this is the same pattern
  as the already-flagged `term_deposits`/`gold`/`silver` exact-key
  duplicates, just with different spellings across the same category
  instead of across two categories. **Recommendation for 3b**: deprecate
  `allocated_pension` (the legacy-named one) in favour of
  `account_based_pension`, following the exact same deprecate-in-place
  precedent as migration `0031`.
- **`transition_to_retirement` (TTR) — confirmed genuinely distinct, not a
  duplicate.** A TTR pension is accessible *while still working*, from
  preservation age, under different contribution caps and tax treatment,
  specifically as an income-stream-alongside-employment strategy — a
  structurally different product from a standard post-retirement
  account-based/allocated pension. No consolidation recommended for this
  item.

No catalogue rows were deprecated or merged as part of this finding — per
this sub-chunk's constraints, that action (and the 2-3 known populated-row
reconciliation from the discovery doc's DEV scan) is explicitly 3b's to
execute.

---

## 7. RLS verification (all new tables)

Every new user-owned table (`smsf_holdings`, `retirement_contributions`)
carries its own `user_id` column and the exact same owner-only policy
already used by every other user-owned table in this codebase:
`enable row level security` + `for all using (auth.uid() = user_id) with
check (auth.uid() = user_id)` (matching `0001_foundation.sql`,
`0003_module2.sql`, and `household_members` in `0009_module7_goals.sql`).

**Note on the task brief's "check `lib/financial-data-hub`/FDH-1/II
convention" pointer**: this worktree is on
`feature/app-review-input-integrity-production`, off `main`@`fe7a094`. The
FDH-1 and Investment-Intelligence branches referenced in prior session
memory are separate, still-unmerged branches not present in this checkout
(`find . -iname "*financial-data-hub*"` returns nothing here) — so this
migration follows this branch's own actual, consistently-applied
convention instead, which is identical in substance (owner-only `auth.uid()
= user_id` policy, RLS enabled on every user table).

**Disclosed limitation, stated honestly per this chunk's verification
discipline**: this sandbox has no DDL execution capability (no live
DEV/production access) and — re-checked at the start of this sub-chunk,
same as the discovery doc's original finding — still has no PGlite/
`db-rebuild-check`-style tooling on this branch. A genuine *live*
adversarial "User A cannot read User B's row" exploit test (the kind
previously run for FDH-1/Investment-Intelligence per prior session memory,
which had actual DEV database access) is **not possible in this
environment**, and no such claim is made. What was verified instead,
directly against the migration SQL text in
`tests/unit/chunk3aSchemaRls.test.ts`: every new table (1) enables RLS, (2)
carries its own `user_id` column, and (3) has a policy using the exact
`auth.uid() = user_id` predicate on both `using` and `with check` —
catching the real regression risks available to catch in this sandbox
(RLS forgotten entirely, wrong column, weaker predicate, a missing table),
without overstating what a static text check can prove about a running
database.

---

## 8. Files changed

**New migrations**:
- `supabase/migrations/0033_master_item_category_metadata.sql`
- `supabase/migrations/0034_master_item_category_metadata_seed.sql`
- `supabase/migrations/0035_smsf_structured_model.sql`
- `supabase/migrations/0036_retirement_member_contribution_model.sql`
- `supabase/migrations/0037_india_retirement_catalogue.sql`

**New library code**:
- `lib/engines/smsf.ts` — SMSF Summary/Detailed aggregation (item 2)
- `lib/engines/retirementAccounts.ts` — current-value/contribution
  separation (items 4-5)
- `lib/grid/fieldVisibility.ts` — metadata-driven field visibility (item 1)

**Modified**:
- `components/grid/FinancialDataGrid.tsx` — reads master-item metadata,
  wires `resolveFieldVisibility()` into both the desktop table and mobile
  card renderers, extends `isRowSaveable`/`missingRequiredCount`
- `lib/grid/configs.ts` — `assetGridConfig`'s `purchase_price`/
  `purchase_date` marked `metadataDriven: true`
- `lib/grid/types.ts` — `GridFieldDef.metadataDriven` added
- `lib/services/masterItems.ts` — selects/exposes the new metadata columns
- `lib/validation/householdMember.ts` — optional `target_retirement_age`

**New tests** (`tests/unit/`):
- `smsf.test.ts`, `retirementAccounts.test.ts`, `fieldVisibility.test.ts`,
  `chunk3aSchemaRls.test.ts`

**Not touched, deliberately**: `supabase/seed_master_items.sql`,
`supabase/production_bootstrap_part*.sql`, `supabase/combined_*.sql` —
these are one-time/historical bootstrap artifacts; per Chunks 1-2's own
precedent, ongoing catalogue changes go through numbered migrations only.

---

## 9. Regression

Reproduced against the Chunks 1-2 baseline (also independently re-verified
at the start of this sub-chunk):

| Check | Before (Chunks 1-2) | After (Chunk 3a) |
|---|---|---|
| `tsc --noEmit` | 0 errors | 0 errors |
| `vitest run` | 17 files, 154 tests, 154 passed | 21 files, 182 tests, 182 passed |
| `eslint .` | 5 errors, 6 warnings | 5 errors, 6 warnings (unchanged — all 5/6 pre-existing, none in new/touched files) |
| `next build` | exit 0 | exit 0 |

No PGlite/`db-rebuild-check` tooling exists on this branch — re-confirmed
absent, not fabricated as present. No migration was applied to DEV or
production; none of this sandbox's constraints allow it.

---

## 10. Handoff — what 3b and 3c still need to do

**3b (catalogue de-duplication + data migration)**:
- Deprecate/merge the ~16 duplicate/overlapping catalogue items from the
  discovery doc's §3.6 (Class B/C items) — untouched by this sub-chunk.
- Deprecate `allocated_pension` in favour of `account_based_pension`
  (§6 above's confirmed finding), following `0031`'s precedent.
- Migrate the Class-F retirement catalogue rows (`employer_contributions`,
  `salary_sacrifice`, `personal_concessional`, `non_concessional`,
  `government_co_contribution`, `spouse_contribution`) off the flat
  Retirement grid and onto the new `retirement_contributions` table —
  this is the actual fix for the phantom-balance double-count defect
  documented in §4 above. Update `dashboard.ts` to stop summing any
  `retirement_accounts` row whose `master_item_key` is one of these six
  (or, better, stop creating such rows at all once the grid UI changes).
- Reconcile the 2-3 known populated-duplicate-row instances the discovery
  doc's DEV scan found (§5 of the discovery doc).
- Build the actual data-entry UI for `smsf_holdings` (Detailed-mode
  holdings entry, including the property sub-form) and
  `retirement_contributions` — no page exists yet; this sub-chunk is schema
  + pure calculation logic only, per its "additive schema design only"
  scope.
- Backfill/offer a UI path for existing SMSF-type retirement accounts to
  adopt `smsf_mode`, and for any property that may have been mis-entered as
  a plain Asset/Investment row to be re-homed into `smsf_holdings` where it
  genuinely belongs.
- Add a UI for `household_members` (currently API-only, zero consumers) so
  a spouse/partner can actually be added and their
  `target_retirement_age`/`retirement_accounts.household_member_id` link
  set — and wire the Financial Twin/Forecasting/dashboard consumers of
  `target_retirement_age` over to the new per-member source once that UI
  exists.
- Apply migrations `0033`-`0037` to DEV, then re-run this chunk's RLS test
  suite as a genuine live adversarial exploit test (the kind this sandbox
  could not run) before considering the schema production-ready.

**3c (Financial DNA)**:
- Once 3b's owner-occupied/investment-property purpose signal
  (`purpose_dimension`, populated by this sub-chunk's `0034`) is fully
  reconciled across the consolidated catalogue, wire it into
  `financialDna.ts`'s debt-dependence formula per the discovery doc's §4
  finding (the `goodDebt`/`badDebt` split already exists in `dashboard.ts`
  but DNA never references it).
- No Financial DNA code was touched in this sub-chunk, per its explicit
  constraints.
