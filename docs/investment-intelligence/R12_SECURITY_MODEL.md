# R12 — Security Model

## Field classification (spec sections 76-77) — no new table created, but the reused table is reclassified

R12 creates **zero new tables**. It writes into existing `ii_*` tables. Per-column classification for
the columns R12's new code paths actually write:

| Table.column | Classification | Who may write |
|---|---|---|
| `ii_instruments.*` | SYSTEM_AUTHORITATIVE (canonical instrument identity) | Service-role only (`resolveOrCreateInstrument`), never the authenticated client |
| `ii_instrument_identifiers.*` | SYSTEM_AUTHORITATIVE | Service-role only |
| `ii_transactions.*` | SYSTEM_AUTHORITATIVE (the reconstructed ledger, even when the underlying evidence is user-declared) | Service-role only, via `importManualFixture()` — the authenticated user has USER_EDITABLE input at the API-request layer (`iiManualDirectPositionSchema`), but never a direct table write |
| `ii_holding_snapshots.*` (`units`, `value`, `price_source`, `quality_status`) | SYSTEM_AUTHORITATIVE / DERIVED (calculated holding, valuation provenance) | Service-role only — **this is the exact field class the R12-P0 discovery found was NOT correctly restricted** (see below) |
| `ii_scheme_tax_classification.*` | SYSTEM_AUTHORITATIVE (tax classification result) | Service-role only |
| `ii_fhip_publications.*` | SYSTEM_AUTHORITATIVE (reconciliation/publication status) | Service-role only, unchanged pre-existing R3/R11 model |

USER_EDITABLE surface for R12 is entirely at the API request boundary (`POST /api/investment-intelligence/positions/manual`
body), never a direct table grant.

## The real gap found and fixed (spec sections 76, 80, 140's "same-user authoritative holding forgery")

`ii_holding_snapshots` still carried migration 0033's original `"own ii_holding_snapshots" for all
using (auth.uid() = user_id) with check (...)` policy — the same defect class this project has
repeatedly found and fixed on other tables (`ii_transactions`/`ii_reconciliation_cases` in 0087,
`ii_review_items` in 0069, `fdh_statement_uploads.reconciliation_status` in 0065). A full grep of
`app/` + `lib/` for `.insert(`/`.update(`/`.upsert(` against `'ii_holding_snapshots'` found **zero**
authenticated-client call sites — every real write is via `createAdminClient()`. Fixed in migration
0092: SELECT-only for the authenticated role, matching the post-0087 `ii_transactions` shape exactly.
**Live-reproduced RED on real DEV** (`scripts/r12_live_dev_verification.mjs`, LIVE-R12-02 — a real
user's own JWT successfully PATCHed their own row's `value` to 999999999 and `units` to 1, HTTP 200) —
not hypothetical. **GREEN reproduced on a post-migration rebuild** (`scripts/r12_post_migration_pglite_verification.mjs`,
NC6) since this session cannot apply DDL to the real hosted DEV project (see `R12_LIVE_DEV_VERIFICATION.md`
for the exact tool-capability limitation).

## Valid-FK attacks (spec section 78) / cross-user (spec section 79)

`scripts/r12_live_dev_verification.mjs` uses real Supabase auth users (real signup, real password
sign-in, real access tokens) — not malformed UUIDs. User B (a real second synthetic user) attempting
to read or write User A's real `ii_holding_snapshots` row is blocked (LIVE-R12-03a/b) — the ownership
`USING` clause was always correct; only the same-user COLUMN-level forgery was the gap.

## Professional access (spec section 82) / raw documents (spec section 83)

R12 introduces no new professional-access surface and does not touch R11's professional
structured-data-vs-raw-document boundary. An equity/ETF position published to `investments` becomes
visible to a professional exactly as a mutual fund position already is, through R11's existing,
unmodified permission architecture — no new unrestricted access path was created.

## Audit (spec section 84)

`importManualFixture()`'s existing audit trail (`ii_audit_events`: `upload`/`parse`/`parse_completed`)
covers every R12 manual-entry write. R12 does not add a dedicated audit event for tax-classification
seeding (a reference-data write, treated the same as other admin-curated reference data like
`ii_security_classifications`, which is also not separately audited) — a deliberate, disclosed scope
decision given the round's time budget, not an oversight.
