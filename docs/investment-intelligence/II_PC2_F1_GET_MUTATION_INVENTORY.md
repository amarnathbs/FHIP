# II-PC2-F1 — GET Handler Mutation Inventory

Full inventory of every `GET` handler under `app/api/investment-intelligence/**`
(44 route files, 26 export a `GET`). For each: what it calls, whether it
reaches a DB write, which tables, and a first-pass classification. Traced by
reading the route file and following every import down to the actual
`.insert(`/`.update(`/`.upsert(`/`.delete(` call site, not by assuming the
route's own comments are accurate (they turned out to be, in every case
checked here, but that was verified, not assumed).

Search commands used: `\.(insert|update|upsert|delete)\(` across
`app/api/investment-intelligence/**`, plus the same pattern against every
service/repository module a GET route imports, plus `persist|emitAuditEvent`
by name.

## Summary

Of 26 GET handlers, **3 reach a database write**: `sip/route.ts`,
`xray/route.ts`, `tax/summary/route.ts` — exactly the three PC2 already
flagged, no additional undisclosed write-on-GET route exists. A fourth,
`positions/[id]/preview/route.ts`, writes a single append-only audit-log row
(`ii_audit_events`) — expected and correct for a preview action, not a
financial-state mutation.

## Full table

| Route | Calls | Engine run? | Writes? | Table(s) written | Classification |
|---|---|---|---|---|---|
| `xray/route.ts` | `loadXrayDataset` → `runXrayAnalytics` → `persistR5Results` | Yes (R5 X-Ray) | **Yes**, when `available` | `ii_r5_analytics_results` | RECOMPUTABLE_DERIVED_CACHE |
| `xray/data-quality/route.ts` | `loadXrayDataset` → `runXrayAnalytics`/`summariseXrayDataQuality` | Yes | No | — | n/a (pure read) |
| `xray/overlap/route.ts` | `loadXrayDataset` → `runXrayAnalytics`/`runPairOverlap` | Yes | No | — | n/a (pure read) |
| `sip/route.ts` | `loadSipDataset` → `runSipAnalytics` (×2, in-memory attribution pass) → `persistR5Results` | Yes (R5 SIP) | **Yes**, unconditional | `ii_r5_analytics_results` | RECOMPUTABLE_DERIVED_CACHE |
| `tax/summary/route.ts` | `loadTaxDataset` → `loadTaxProfile` → `runTaxSimulation` → `persistTaxLots` → `persistTaxLotConsumptions` → `persistCapitalGainsComputations` | Yes (R6 tax engine) | **Yes** | `ii_tax_lots`, `ii_tax_lot_consumptions`, `ii_capital_gains_computations` | AUTHORITATIVE_DERIVED_FINANCIAL_STATE |
| `tax/lots/route.ts` | `loadTaxDataset` → `runTaxSimulation` | Yes | No (deliberately — comment confirms lots are always recomputed fresh, `ii_tax_lots` not read/written here) | — | n/a (pure read) |
| `tax/profile/route.ts` | `loadTaxProfile` | No | No | — | n/a (pure read) |
| `tax/cost-intelligence/route.ts` | none (static stub — no TER data source exists) | No | No | — | n/a (pure read) |
| `analytics/route.ts` | `loadAnalyticsDataset` → `runAnalytics` | Yes (R4) | **No** — R4 already separates persistence into `POST /analytics/recalculate` (`persistAnalyticsRows`, `ii_analytics_results`). GET is pure read. | — | n/a (already Pattern C) |
| `overview/route.ts` | `buildOverviewSummary` (plain table reads/counts) | No | No | — | n/a (pure read); route's own header explicitly documents why it must never fan out into SIP/X-Ray/Tax |
| `positions/route.ts` | direct `ii_holding_snapshots` read | No | No | — | n/a (pure read) |
| `positions/[id]/eligibility/route.ts` | `checkEligibility` (position/account/instrument/truth reads) | No | No | — | n/a (pure read) |
| `positions/[id]/preview/route.ts` | `buildPreview` (reads) + `emitAuditEvent` | No | **Yes**, always | `ii_audit_events` | NON_FINANCIAL_CACHE (append-only audit log — by design, one row per preview, not a derived financial value) |
| `portfolio-truth/route.ts` | direct `ii_portfolio_truth_status` read | No | No | — | n/a (pure read) |
| `publications/route.ts` | direct `ii_fhip_publications` read | No | No | — | n/a (pure read) |
| `reconciliation-cases/route.ts` | direct `ii_reconciliation_cases` read | No | No | — | n/a (pure read) |
| `review/route.ts` | `listReviewItems` | No | No | — | n/a (pure read) |
| `review/[id]/route.ts` | direct `ii_review_items` read | No | No | — | n/a (pure read) |
| `goals/route.ts` | `computeGoalsPagePayload` (explicitly documented "pure computation, no persistence") + `ii_review_items` read | No | No | — | n/a (pure read). NOTE: the sibling function `loadGoalsPage` in the same module DOES insert `goal_forecasts`/upsert `goal_snapshots` on every call, but it is used only by the main (non-II) Goals page, never imported by any II route. |
| `goals/[id]/route.ts` | `computeGoalsPagePayload` + `ii_review_items` read | No | No | — | n/a (pure read) |
| `goal-allocations/route.ts` | direct `ii_goal_allocations` read | No | No | — | n/a (pure read) |
| `accounts/route.ts` | `listIiAccounts` | No | No | — | n/a (pure read) |
| `sources/route.ts` | direct `ii_sources` read (reference data) | No | No | — | n/a (pure read) |
| `source-documents/route.ts` | direct `ii_source_documents` read | No | No | — | n/a (pure read) |
| `source-documents/[id]/status/route.ts` | direct reads (`ii_source_documents`, `ii_document_parse_runs`) | No | No | — | n/a (pure read) |
| `source-documents/[id]/summary/route.ts` | direct reads (5 tables in parallel) | No | No | — | n/a (pure read) |

Routes with no `GET` export at all (excluded — not in scope): `accounts/[id]`
(DELETE only), `analytics/recalculate` (POST), `forecast/refresh` (POST),
`goal-allocations/[id]` (presumably PATCH/DELETE), `goals/[id]/allocations`
(POST), `portfolio-truth/certify` (POST), `positions/[id]/publish` (POST),
`positions/[id]/refresh` (POST), `positions/manual` (POST),
`publications/[id]/republish` / `unpublish` (POST),
`reconciliation-cases/[id]/resolve` (POST),
`review/[id]/acknowledge` / `dismiss` (POST), `review/refresh` (POST),
`sip/simulation` (POST), `source-documents/[id]/parse` / `process` (POST),
`tax/redemption-simulation` (POST). These are explicit command endpoints by
construction and are out of scope for a *read-side* mutation review.

## Idempotency proof at the schema level (static analysis)

For all three writing GETs, the upsert's `onConflict` target was checked
against the actual `CREATE TABLE`/`CREATE UNIQUE INDEX` in the owning
migration — not assumed from the application code alone:

- `ii_r5_analytics_results` (migration `0044`, line 314): `unique (user_id,
  scope_type, scope_id, metric_key, input_snapshot_version, engine_version)`
  — **exactly** matches `persistR5Results`'s `onConflict` string
  (`r5Repository.ts:737`), used by both SIP and X-Ray, `ignoreDuplicates:
  true` (DO NOTHING on conflict — a concurrent duplicate write is a genuine
  no-op, not a race).
- `ii_tax_lots` (migration `0059`): `id uuid primary key`, and the
  application computes `id` deterministically (`deterministicLotId`, a
  UUID v5 hash of the lot's own stable `lotId`) — `upsert(..., { onConflict:
  'id' })` in `taxRepository.ts:465` is therefore a true idempotent write:
  the same lot always upserts to the same row.
- `ii_tax_lot_consumptions` (migration `0059`): `create unique index
  uidx_ii_tax_lot_consumptions_disposal_lot on
  ii_tax_lot_consumptions(disposal_transaction_id, lot_id)` — exactly
  matches `persistTaxLotConsumptions`'s `onConflict:
  'disposal_transaction_id,lot_id'` (`taxRepository.ts:504`).
- `ii_capital_gains_computations` (migration `0059`): `create unique index
  uidx_ii_capital_gains_computations_disposal_lot on
  ii_capital_gains_computations(disposal_transaction_id, lot_id)` — exactly
  matches `persistCapitalGainsComputations`'s `onConflict:
  'disposal_transaction_id,lot_id'` (`taxRepository.ts:577`).

All three writing tables were already hardened by two earlier, dedicated
efforts (`II-PC1-F1` — account-scoped FIFO — and `II-PC1-F2` — current-result
selection over superseded engine-version rows), both independently live-DEV
certified before this dispatch. `taxRepository.ts`'s own header comments
document the exact defects those efforts found and fixed (an FK-violation
that silently discarded every disposal's persistence attempt; a v2/v3
engine-version coexistence bug). This dispatch's job is to check whether
anything remains, not to re-litigate F1/F2.

## One finding carried forward from this inventory into the decision doc

`persistTaxLots` (`taxRepository.ts:458`) stamps `closed_at: new
Date().toISOString()` on every upsert of a fully-consumed lot — including a
lot that was already closed by an earlier run. Because this is an upsert (DO
UPDATE, not DO NOTHING), **the `closed_at` column value changes on every
repeated GET of `/tax/summary` for as long as the lot stays closed**, even
though every other column (units, cost basis, status) stays byte-identical.
Confirmed by grep that no code anywhere in the app reads `ii_tax_lots.closed_at`
(the only other read of `ii_tax_lots` at all, `tax/lots/route.ts`, never
touches the table — it recomputes lots in memory). See the decision doc for
full disposition.
