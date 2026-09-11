# G8 Data-Contract Specification (G8.057–G8.065)

**Scope note, same discipline as `g7-data-contracts.md`**: the master spec's own structure caps this phase at exactly 9 topics — `G8.057` (release baseline and lineage) through `G8.065` (GB generic account) — the same first 9 topics `g8-ownership-decisions.md` covers as `G8.029`–`G8.037` — then moves directly to the Appendices (page 242). Topics 10–28 (US generic account onward) receive no data-contract phase at all in this master document; their treatment stops at the ownership-decision phase, already complete.

Of the 9 topics in scope, only **1** has a genuine code contract; the other 8 are correctly marked N/A per their own ownership decision (process-level, documentation-only, reaffirmed-unchanged, or explicitly deferred pending a Product Owner ruling this phase does not make unilaterally).

## Contract 1 — AU account: correct the "not IN becomes Australia" currency-mismatch copy (G8.063 / ownership G8.035)

```tsx
// components/grid/FinancialDataGrid.tsx — around line 1026
// BEFORE:
`Doesn't match ${draft.country_code === 'IN' ? "India's" : "Australia's"} currency...`
// AFTER — reuse the same canonical country-label resolution the already-fixed
// call sites use (retirementMemberData.ts / resilienceStress.ts's "G5-D1
// FIXED" pattern), never a second inline ternary:
`Doesn't match ${countryLabelFor(draft.country_code)}'s currency...`
// where countryLabelFor() is the existing shared label lookup (COUNTRY_LABELS
// / jurisdiction.ts's own label resolver) — no new function is introduced,
// this call site is migrated onto the one already-established, already-
// tested pattern the other two call sites use.
```
**Contract:** display-string change only — no schema, no new computation. **Backward compatible** for every existing AU/IN row (identical output for `'AU'`/`'IN'`); the fix is that a null/legacy/future-GB-US-SG-AE `country_code` no longer gets mislabelled "Australia's" by default.

---

## Topics with no data-contract change (ownership decision was "process-level" / "reaffirmed unchanged" / "documentation-only" / "explicitly deferred pending Product Owner ruling")

- **G8.057 — Release baseline and lineage** (ownership G8.029): process-level gap (no version/build-ID surfaced anywhere); named for Product Owner operational awareness, no code artifact to contract.
- **G8.058 — Feature-flag inventory** (ownership G8.030): the one real action is a documentation correction (`ENVIRONMENT_VARIABLES.md` gains the 5 undocumented flags) — no schema/code change, matching G6/G7's own precedent of filing doc-only decisions N/A.
- **G8.059 — Migration inventory** (ownership G8.031): process/tooling gap (the collision-guard tool's blind spot); named for a future tooling investment, not a data contract this phase specifies.
- **G8.060 — AU visitor** (ownership G8.032): the one real item — confirming CloudFront-Viewer-Country header injection is actually live on the production Amplify distribution — is an **infrastructure verification**, not a code change; it is also explicitly named as requiring direct Product Owner/infrastructure confirmation, not something this repository's own code can resolve.
- **G8.061 — India visitor** (ownership G8.033): same decision and same reasoning as G8.060, tracked once.
- **G8.062 — Global visitor** (ownership G8.034): reaffirmed unchanged — no gap found, nothing to contract.
- **G8.064 — India account** (ownership G8.036): the one finding (Investment Intelligence's India-only scoping by data-shape coincidence) is explicitly **not authorised for a fix** in this phase, matching G7's own identical deferral of the equivalent report-layer risk one level up — an accepted, disclosed residual risk, not a contracted change.
- **G8.065 — GB generic account** (ownership G8.037): the one finding (forced AUD/INR-only currency for a GBP household) is explicitly **not authorised for a fix** — extending currency support is a separate, larger G5-adjacent decision outside this phase's boundary.

All eight are **N/A, explicitly no contract change**, per their own ownership decision — met honestly rather than padded with boilerplate, matching the discipline `g6-data-contracts.md` and the corrected `g7-data-contracts.md` both already established.
