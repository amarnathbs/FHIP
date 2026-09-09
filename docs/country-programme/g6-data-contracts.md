# G6 Data-Contract Specification (G6.057–G6.084)

Concrete schema/type/API contracts for the 10 real changes decided in `g6-ownership-decisions.md`. The master spec's own per-topic template is identical across all 28 topics in this phase (same "Required work"/country-matrix/data-integrity/security/verification checklist, topic name substituted) — rather than repeat 28 largely-empty boilerplate sections, this document gives the actual contract for each of the 10 real changes, and explicitly marks every topic whose ownership decision was "unchanged" as **N/A — no contract change**, so the phase's own completeness requirement is met honestly rather than padded.

Every contract below satisfies the same repeated checklist from the master spec: authoritative inputs only (never currency/locale/client-supplied country), AU/IN/GENERIC/unresolved paths preserved, original values/record identity never rewritten, and RLS/ownership follows the existing owner-only + cross-referenced-child pattern (G6.049).

## Contract 1 — Widen `country_code` on assets/liabilities/investments/retirement_accounts (G6.031/040/041/G6.057/059/068/069)

```sql
-- Migration (additive, no data migration — existing rows are already AU/IN):
alter table assets drop constraint assets_country_code_check;  -- if a named CHECK exists; else no-op, FK already allows it
alter table liabilities drop constraint liabilities_country_code_check;
alter table investments drop constraint investments_country_code_check;
alter table retirement_accounts drop constraint retirement_accounts_country_code_check;
-- (No new CHECK added — country_code is already `char(2) references countries(country_code)`,
--  a plain FK. The restriction today is Zod-only; the DB has never had a narrower CHECK than
--  the FK itself. Confirm exact constraint names via \d+ before writing the real migration.)
```
```ts
// lib/validation/{asset,liability,investment,retirement}.ts
country_code: z.enum(AUTHORITATIVE_COUNTRY_CODES).optional() // was z.enum(['AU','IN'])
```
**Response contract:** unchanged shape — `country_code` was always `char(2)|null` at the API boundary; only the accepted value set widens. **Backward compatible**: every existing AU/IN value remains valid.

## Contract 2 — New `country_code` column on income_sources/expense_items/insurance_policies (G6.042/043/G6.070/084)

```sql
alter table income_sources add column country_code char(2) references countries(country_code);
alter table expense_items add column country_code char(2) references countries(country_code);
alter table insurance_policies add column country_code char(2) references countries(country_code);
-- Nullable, no default, no backfill — existing rows get NULL (unattributed), matching the
-- "preserve existing source values, never rewrite history" data-integrity rule. A NULL
-- country_code is a valid, permanent state (pre-G6 rows), not a transient one to be cleaned up.
```
```ts
// lib/validation/{income,expense,insurance}.ts — new optional field, all existing payloads
// (with no country_code key at all) remain valid:
country_code: z.enum(AUTHORITATIVE_COUNTRY_CODES).optional().nullable()
```
**Response contract:** GET responses gain a new `country_code: string | null` field. **Backward compatible**: additive field, no existing consumer breaks.

## Contract 3 — FX-rate lineage on `financial_snapshots` (G6.033/047/G6.075)

```sql
alter table financial_snapshots add column fx_rate_aud_inr numeric(12,6);
alter table financial_snapshots add column fx_rate_date date;
-- Populated at write-time only (loadDashboard()'s upsert), never backfilled for historical
-- rows — a pre-G6 snapshot legitimately has NULL here, meaning "rate unknown, do not attempt
-- retroactive reconciliation," matching "treat unavailable... as unavailable, not zero."
```
```ts
// lib/services/dashboardData.ts — loadDashboard()'s upsert payload gains two fields:
{
  ...existingUpsertFields,
  fx_rate_aud_inr: fxRateAudInr,          // the same value already resolved by getFxRateAudInr()
  fx_rate_date: new Date().toISOString().slice(0, 10),
}
```
**Read contract:** `SnapshotRow` (dashboard.ts) gains optional `fxRateAudInr: number | null`, `fxRateDate: string | null` — consumers that don't care (twinData.ts, resilienceData.ts) ignore the new fields; a future currency-drift-aware trend UI can use them.

## Contract 4 — `isDomesticRecord()` shared helper (G6.034/G6.062)

```ts
// lib/services/jurisdiction.ts — new pure function, no schema change:
export function isDomesticRecord(
  recordCountryCode: CountryCode | null | undefined,
  homeCountryCode: CountryCode | null | undefined
): boolean | null {
  // null = "cannot classify" (either side unresolved) — never assume domestic on missing data.
  if (!recordCountryCode || !homeCountryCode) return null;
  return recordCountryCode === homeCountryCode;
}
```
**Contract:** pure function, no I/O, no new type exported beyond the existing `CountryCode`. `resilienceStress.ts`/`reportSectionsPremium.ts` replace their private inline comparisons with a call to this function — zero behavioural change, confirmed by construction (same comparison, same null-handling).

## Contract 5 — Converted per-country net-worth field (G6.035/G6.063/077)

```ts
// lib/engines/dashboard.ts — DashboardSummary gains one new field, additive:
interface DashboardSummary {
  // ...existing fields unchanged (netWorth, assetsByCountry, etc. — all untouched)...
  netWorthByCountryConverted: { countryCode: string; value: number }[]; // NEW
}
// Computed alongside the existing unconverted byCountry() rollups: same per-country grouping,
// but each row's value passes through reportingValue() before summing — reusing the exact
// currency-conversion function already used for the blended `netWorth` total, not a new one.
```
**Contract:** additive field only. `netWorth`, `assetsByCountry`, etc. are byte-identical to today — this is purely a new, third view, per the "never mixes incompatible entity populations" AC-09 discipline (same pattern LR-11 used for `businessEntityOwnershipValue`).

## Contract 6 — Goal-funding cross-currency conversion (G6.037/G6.065)

```ts
// lib/services/goalsData.ts — loadLinkedContributionSources() SELECT gains one column:
.select('id, current_value, current_balance, currency_code')  // currency_code is new

// lib/services/goalFundingAllocation.ts — computeLiveLinkedFundingValue() signature gains
// the goal's own currency + the fx rate, both already available to every caller:
function computeLiveLinkedFundingValue(
  source: GoalFundingSource,
  currentValueById: Map<string, { value: number; currencyCode: string }>, // was Map<string, number>
  goalCurrencyCode: string,       // NEW
  fxRateAudInr: number            // NEW
): number {
  const linked = currentValueById.get(source.linkedRecordId);
  if (!linked) return 0;
  const converted = convertToReportingCurrency(linked.value, linked.currencyCode, goalCurrencyCode, fxRateAudInr); // reuses fx.ts
  return source.mode === 'percentage' ? converted * (source.allocationPercentage / 100) : source.allocatedAmount;
  // NOTE: fixed-amount sources are NOT converted — they are already a goal-currency-denominated
  // figure the user entered directly, per the existing contract; only percentage-of-linked-value
  // sources need conversion, since only they read a foreign-currency-denominated balance.
}
```
**Backward compatibility:** for the overwhelmingly common case (goal and linked record share a currency), `convertToReportingCurrency()` is a no-op passthrough (fx.ts's own `if (localCurrency === reportingCurrency) return localAmount`) — zero numeric change for any existing single-currency household.

## Contract 7 — Wire `CROSS_BORDER` capability into its bypassing route (G6.046/G6.074)

```ts
// app/api/user/cross-border-relationships/route.ts — replace the direct legacy gate call:
// BEFORE: const { user, unauthenticated } = await requireCountryConfirmedUserAllowingGeneric();
// AFTER:
const { user, unauthenticated } = await requireModuleCapability('CROSS_BORDER', 'VIEW'); // GET
const { user, unauthenticated } = await requireModuleCapability('CROSS_BORDER', 'CREATE'); // POST
```
**Contract:** no schema change. Behavioural contract: while `G4_APP_CAPABILITY_LAYER_ENABLED` stays off (current production state), `requireModuleCapability` degrades to byte-identical `requireCountryConfirmedUser()` behaviour per its own documented fallback — **zero production behaviour change until G4 is separately authorised**, exactly matching every other G4-migrated route's own precedent (Income/Expenses/Insurance).

## Contract 8 — Preview route's real cross-border check (G6.050/G6.078)

```ts
// app/api/user/primary-country/preview/route.ts — replace the hardcoded literal:
// BEFORE: cross_border_relationships_retained: true  (never checked)
// AFTER:
const { count } = await supabase
  .from('cross_border_relationships')
  .select('id', { count: 'exact', head: true })
  .eq('user_id', user.id)
  .eq('status', 'active');
// response field renamed for honesty, since "retained" implies a check that didn't happen before:
active_cross_border_relationships_count: count ?? 0,
```
**Contract change note:** the response field `cross_border_relationships_retained: true` (boolean) is replaced with `active_cross_border_relationships_count: number` — a breaking rename for this one field. Justified because the old field made a false-precision claim (a hardcoded `true` presented as if verified); no known consumer of this preview endpoint's exact field name exists outside the one UI component that renders it (`app/(app)/profile/page.tsx`'s primary-country change flow), which is updated in the same change.

## Contract 9 — NRI-disclaimer / country_of_residence cross-check (G6.054/G6.082)

```ts
// lib/services/investmentIntelligenceReportData.ts — residencyProfile derivation gains a
// cross-check, no schema change (reads an already-available field, country_of_residence):
const residencyProfile = {
  ...deriveFromTaxpayerType(taxProfile.taxpayerType),
  // NEW: if the self-declared type says "resident" but country_of_residence is not IN,
  // force the NRI caveat back on rather than trusting the self-declaration alone.
  nriRulesMayApply: deriveFromTaxpayerType(taxProfile.taxpayerType).nriRulesMayApply
    || (countryOfResidence !== 'IN'),
};
```
**Contract:** no new field, no schema change — a precision fix to existing derivation logic. `taxpayerType`'s own meaning and storage are untouched (still explicit-only, never inferred, per the existing UI copy's own promise) — this only widens when the *disclaimer* is shown, never overrides the user's own declared taxpayer type itself.

## Contract 10 — `secondary_country` readers migrated to `cross_border_relationships` (G6.029/G6.057)

```ts
// lib/services/twinData.ts and lib/ai/context/financialContextObject.ts — replace:
// BEFORE: const crossBorderIndicator = Boolean(profile.secondary_country);
// AFTER:
const { count } = await supabase
  .from('cross_border_relationships')
  .select('id', { count: 'exact', head: true })
  .eq('user_id', userId)
  .eq('status', 'active');
const crossBorderIndicator = (count ?? 0) > 0;
```
**Contract:** no schema change to either table (`secondary_country` column itself is NOT dropped in G6 — dropping a column used elsewhere, even if currently unread post-migration, is a separate, later cleanup decision, not bundled into this phase per the "smallest canonical correction" discipline). Behavioural contract: `crossBorderIndicator` becomes `true` for a household with an active declared relationship (the intended, correct signal) rather than `true` only for the narrower legacy `secondary_country in {'AU','IN'}` case — this is a widening of correctness, not a breaking change, since the old signal was already acknowledged as legacy/superseded.

---

## Topics with no data-contract change (ownership decision was "unchanged")

G6.058 (NRI eligibility — G6.030 decision: unchanged), G6.060 (currencies — G6.032: unchanged), G6.061 (FX lineage — folded into Contract 3), G6.064 (cash-flow — G6.036: unchanged), G6.066 (forecast — G6.038: unchanged), G6.067 (retirement/pension — G6.039: unchanged), G6.071 (SMSF — G6.044: unchanged, reaffirmed), G6.073 (FDH — G6.045: unchanged), G6.076 (audit events — G6.048: existing pattern reused, no new table), G6.079 (API contracts — G6.051: validation-strategy convention applied only to the 10 real changes above, no separate contract of its own), G6.080 (migration safety — G6.052: process, not a data contract), G6.081 (regulatory — G6.053: unchanged), G6.083 (reconciliation — G6.055: unchanged, no harness) — all **N/A, explicitly no contract change**, per their own ownership decision.
