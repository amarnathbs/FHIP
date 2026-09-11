# G7 Data-Contract Specification (G7.057–G7.069)

**Scope correction note:** the master spec's own structure caps this phase at exactly 13 topics — `G7.057` (free report geography) through `G7.069` (generic-country limitations), the same first 13 topics `g7-ownership-decisions.md` covers as `G7.029`–`G7.041` — then moves directly to `G8 Executive Authorisation` (page 176). Topics 14–28 of G7 (AU regulatory wording onward, `G7.042`–`G7.056`) receive no data-contract or threat-model phase at all in this master document; their treatment stops at the ownership-decision phase, already complete. This mirrors G6's own document precedent (giving the real contract for each topic rather than repeating the master spec's identical 6-section boilerplate template 13 times) but corrects an earlier draft of this file that incorrectly extended coverage to topics outside this phase's actual page range.

Of the 13 topics in scope, 6 have a genuine contract (a real change was decided in ownership); 7 are marked **N/A — no contract change**, per their own "unchanged"/"deferred"/"doc-only" ownership decision — met honestly, not padded.

## Contract 1 — Report header country context (G7.059 / ownership G7.031)

```ts
// lib/services/reportGeneration.ts (or wherever generateReport() assembles the reports insert)
// BEFORE: country_scope: 'household'  (fixed literal, never read again)
// AFTER: resolved once, at generation time, from the SAME source already used by
// stress_testing's applicabilityNote (reportSectionsPremium.ts) — no second resolution path:
const countryScope = source.profile.countryOfResidence ?? null;
// inserted as reports.country_scope, replacing the literal.
```
**Contract:** no schema change — `reports.country_scope` already exists as a `text` column; this only changes what value it is populated with at write time. **Backward compatible**: every existing report row keeps its stored (stale) `'household'` value untouched — a go-forward population fix, not a backfill. Closes G7.008's own disclosed provenance gap as a side effect.

## Contract 2 — Reporting currency and date (G7.060 / ownership G7.032)

```ts
// New shared helper, lib/utils/reportLocale.ts (or co-located with the existing money formatter):
export function localeForReportingCurrency(reportingCurrency: string): string {
  return reportingCurrency === 'INR' ? 'en-IN' : 'en-AU';
}

// Applied at every call site discovery found hardcoding 'en-AU' independently:
//   lib/services/reportsData.ts
//   components/reports/ReportHistoryTable.tsx
//   components/reports/ReportPreview.tsx (×2 occurrences)
// BEFORE: new Date(x).toLocaleDateString('en-AU', ...)
// AFTER:  new Date(x).toLocaleDateString(localeForReportingCurrency(reportingCurrency), ...)
```
**Contract:** no schema change, no new field — a shared pure function replacing four independent hardcoded literals with the exact locale-selection logic the money formatter (`Intl.NumberFormat`) already uses at each site. **Backward compatible for every AU household** (`'en-AU'` is unchanged); an INR-reporting household's dates switch from AU to IN formatting, which is the correctness fix itself. This is the only place in the master spec's own structure this fix can be specified — the PDF-rendering topic (`G7.048`) that separately named the identical gap sits outside this phase's 13-topic range and reaches no data-contract phase of its own; its own ownership decision explicitly said to track it here rather than duplicate it.

## Contract 3 — Cross-border sections (G7.062 / ownership G7.034)

```ts
// lib/services/reportEligibility.ts — new exported function, no schema change:
export function hasCrossBorderEligibility(countriesInUse: string[]): boolean {
  return countriesInUse.length > 1;
}
// reportEligibility.ts and reportSectionsPremium.ts both replace their independent
// `> 1` / `<= 1` inline checks with a call to this one function.
```
**Contract:** pure function, zero behavioural change (same threshold, same input shape) — follows the exact `isDomesticRecord()` extract-and-share precedent G6.034 already set. Confirmed by construction: both call sites' existing threshold is `> 1`, so replacing the inline literal with a shared function call cannot change any existing report's eligibility outcome.

## Contract 4 — Consolidated sections (G7.063 / ownership G7.035)

```ts
// lib/engines/reportSectionsPremium.ts (or wherever these three sections are built) —
// each of net_worth / cash_flow / executive_summary gains a conditional limitationText,
// reusing the already-resolved d.countriesInUse value G7.034's own sections already consume:
if (d.countriesInUse.length > 1) {
  section.limitationText = section.limitationText
    ? `${section.limitationText} This section blends figures from ${d.countriesInUse.length} countries.`
    : `This section blends figures from ${d.countriesInUse.length} countries.`;
}
```
**Contract:** additive narrative field only (`limitationText` is already a nullable string every report section can carry) — no schema change, no new computation. **Backward compatible**: a single-country household's `countriesInUse.length` is always `1`, so this condition never fires for the overwhelming majority of existing reports.

## Contract 5 — Historical report snapshots (G7.064 / ownership G7.036)

```ts
// lib/services/reportSnapshotResolver.ts (or wherever report_snapshots rows are written) —
// snapshot_metadata_json (existing JSONB catch-all, no migration needed) gains three keys
// at generation time, mirroring G6.033's financial_snapshots columns exactly:
{
  ...existingSnapshotMetadata,
  fxRateAudInr: resolvedFxRateAudInr,       // same value getFxRateAudInr() already resolved
  fxRateDate: new Date().toISOString().slice(0, 10),
  countryOfResidence: source.profile.countryOfResidence ?? null,
}
```
**Contract:** no schema change — `snapshot_metadata_json` already exists precisely for this kind of additive provenance data. **Backward compatible**: existing snapshot rows keep whatever metadata they already have; this only adds three new keys to snapshots generated going forward, matching the "never backfill, NULL/absent means unknown" discipline G6's own Contract 3 established. Note: this data becomes the input the later, out-of-phase `G7.046` (FX lineage display, topic 18, outside this phase's 13-topic range) would read if a future phase implements it — that display change is not specified here, since its own topic never reaches a data-contract pass in this master document.

## Contract 6 — Recommendation applicability (G7.068 / ownership G7.040)

```ts
// lib/services/appCapability.ts — RECOMMENDATIONS.note, doc-accuracy fix only:
// BEFORE: "not yet re-certified as country-neutral"
// AFTER:  "has 28 AU/IN-only-triggering condition rows by design; not country-neutral"
```
```ts
// tests/unit/recommendationsMatcherCountryConditional.test.ts (new file):
// Positive: an AU-scoped rule's condition fires for an AU household.
// Negative: the same rule does NOT fire for an IN household.
// Negative: the same rule does NOT fire for a null/unresolved country_of_residence.
// No change to lib/engines/recommendations/matcher.ts itself — discovery found its logic
// already correct; this closes the confirmed zero-coverage gap only.
```
**Contract:** one doc-string correction (no behavioural change) plus new test-only coverage of existing, unmodified matcher logic.

---

## Topics with no data-contract change (ownership decision was "unchanged" / "reaffirmed" / "deferred" / "doc-only")

- **G7.057 — Free report geography** (ownership G7.029): explicitly deferred — building a domestic-only section needs a `country_code` column on `income_sources`/`expense_items` this phase does not add (that column is G6's own Contract 2, not G7's). Out of this phase's boundary.
- **G7.058 — Premium report geography** (ownership G7.030): no forced reconciliation of the blended-converted view with the per-country-unconverted view is decided in this phase — matches G6.035's own precedent; if that ships, `cross_border_full` reads the same field rather than G7 inventing a second one.
- **G7.061 — Domestic sections** (ownership G7.033): identical deferral to G7.057, tracked once rather than duplicated across Free/Premium.
- **G7.065 — Resources applicability taxonomy** (ownership G7.037): unchanged — the 4-value `jurisdiction` enum and the G1 country registry are deliberately kept as two separate vocabularies, not unified.
- **G7.066 — Resources filtering** (ownership G7.038): reaffirmed, no gap — the manual reader-operated filter never claims to be an authoritative country determination, so there is no substitution risk to close.
- **G7.067 — Resources admin governance** (ownership G7.039): reaffirmed — the mandatory jurisdiction-tagging gate stays as-is; the disclosed admin-gate coupling (staff residence-country gating a globally-relevant CMS) is noted forward for a future cross-module admin-access review, not this phase's call.
- **G7.069 — Generic-country limitations** (ownership G7.041): documentation-only correction to the `RESOURCES` capability manifest's own note (it describes a hypothetical future in-app surface, since none exists today for it to gate) — no functional change.

All seven are **N/A, explicitly no contract change**, per their own ownership decision — met honestly rather than padded with boilerplate.
