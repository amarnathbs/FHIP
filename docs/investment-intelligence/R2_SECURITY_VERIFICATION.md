# R2 — Security Verification

Status: FINAL

## 1. Environment constraint, stated plainly (same as R1)

This sandbox has no Docker/Podman and no direct Postgres connection string to DEV (`vqycarelcoijzwlpkpcz`) — the identical wall every migration-dependent phase in this project's history has hit (R1's `R1_RLS_SECURITY_REPORT.md` documents this in full). Migrations `0039`-`0041` have **not** been applied to DEV in this session. Every claim below is either (a) a direct, hand-verified inspection of the actual migration SQL text and actual TypeScript source (not an assertion from memory), or (b) explicitly marked **BLOCKED pending migration application**, never silently skipped or asserted as passing.

## 2. RLS coverage — every new table, verified by direct inspection

```
grep -c "enable row level security" supabase/migrations/0039_*.sql supabase/migrations/0040_*.sql supabase/migrations/0041_*.sql
  -> 0039: 1   0040: 1   0041: 3   (total 5)
grep -c "^create table" (same files)
  -> 0039: 1   0040: 1   0041: 3   (total 5)
grep -c "^create policy" (same files)
  -> 0039: 1   0040: 1   0041: 3   (total 5)
```

Every new table has exactly one `enable row level security` and exactly one policy — zero tables created without RLS, zero tables with RLS enabled but no policy (which would fail-closed anyway, but is worth confirming didn't silently happen by omission).

| Table | Ownership | Policy | Verified how |
|---|---|---|---|
| `ii_document_parse_runs` | owner-only | `for all using (auth.uid()=user_id) with check (...)` | Direct read of migration `0039` — identical shape to every R1 owner-only table |
| `ii_transaction_source_links` | owner-only | same shape | Migration `0040` |
| `ii_scheme_alias_map` | shared/reference | `for select using (true)`, no write policy for authenticated role | Migration `0041` — identical shape to `ii_instrument_identifiers` |
| `ii_portfolio_truth_status` | owner-only | same shape | Migration `0041` |
| `ii_reconciliation_config` | shared/reference | `for select using (true)`, no write policy | Migration `0041` — identical shape to `ii_tax_rule_versions` |

No new RLS *shape* was invented — every policy is a byte-for-byte structural match to an existing, already-reviewed R1 policy pattern.

## 3. Additive-only migration safety

```
grep -i "drop table\|drop column\|delete from\|truncate" supabase/migrations/0039_*.sql supabase/migrations/0040_*.sql supabase/migrations/0041_*.sql
  -> no matches in any of the three files
```

Every `alter table ... drop constraint` is immediately followed by an `alter table ... add constraint` with a **strict superset** of the previously-allowed values (`event_type`, `ii_source_documents.status`, `ii_transactions.transaction_type`) — hand-verified value-by-value while writing each migration (see the migration files' own inline comments, which reproduce the full prior value list verbatim before appending new ones). `ii_reconciliation_cases.discrepancy_type`'s new check constraint uses `not valid` + a separate `validate constraint` (no table lock/scan required to add it, and the one existing R1 fixture-created case value was checked and, where it did not already fit the new enum, the fixture itself was corrected — see the migration's own comment and `lib/fixtures/investment-intelligence/04-discrepant-reconciliation.json`'s `value_mismatch` value).

Existing indexes/constraints are untouched. New indexes are all justified inline in the migration comments (idempotency partial indexes, dedup fingerprint partial index, lookup indexes matching existing "latest per position" query patterns).

## 4. Ownership verification on every mutating code path

Every new R2 API route calls `requireUser()` first (verified: `grep -l requireUser app/api/investment-intelligence/**/route.ts` returns all 15 route files, matching the total file count exactly). Every service-role (`createAdminClient()`) call site in new R2 code re-verifies ownership against the AUTHENTICATED user id before doing anything else:

- `documentProcessing.ts`'s `processSourceDocument(input)` — first statement is `admin.from('ii_source_documents').select('*').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle()`; every subsequent write inside the function uses the same already-verified `userId`, never a value read from the request body.
- `documentProcessing.ts`'s `recertifyPosition(userId, accountId, instrumentId)` — first statement re-verifies `ii_accounts` ownership; its ONE caller (`portfolio-truth/certify/route.ts`) additionally checks ownership itself before calling it (defence in depth, not reliance on the service function alone).
- `accountResolution.ts`'s `resolveOrCreateAccount(userId, input)` — every query scoped `.eq('user_id', userId)`; only ever called from `documentProcessing.ts` with the already-verified id, never exposed directly to a route.
- `storage.ts`'s new `downloadSourceDocumentObject(objectKey)` — a low-level storage primitive with no ownership check of its own BY DESIGN (matches R1's existing upload/signed-URL/delete functions in the same file) — its only caller (`processSourceDocument`) always derives `objectKey` from the already-ownership-verified `ii_source_documents` row, never from user input directly.

`grep -rn "createAdminClient" lib/services/investment-intelligence app/api/investment-intelligence` (9 files) — every call site listed and individually reviewed; none is reachable from a request path that has not already run `requireUser()` and, for anything touching another row's ownership, an explicit `.eq('user_id', ...)` check.

`reconciliation-cases/[id]/resolve/route.ts` (extended in R2) re-checks both ownership (`.eq('user_id', user.id)`) AND not-already-resolved (`existing.status === 'resolved' -> 409`) before mutating — directly matching the R1 methodology the task's own "critical lesson from R1" section describes (seed a real owned row, verify via an independent read afterward) — this pattern is unchanged from R1's already-audited route and only extended with new optional fields.

## 5. Privacy / logging

- `grep -rn "console\." lib/services/investment-intelligence app/api/investment-intelligence components/investment-intelligence` -> **zero matches**. No R2 code path logs anything to the console.
- **Password**: `input.password` (the only place a caller-supplied document password exists in memory) is used exactly once — passed directly into `extractPdfText(bytes, password)` — and never appears in any subsequent variable, database write, audit-event metadata, or thrown-error message. Verified by direct inspection of every `password` occurrence in `documentProcessing.ts` (11 occurrences, all either the parameter itself, the `PdfExtractionFailureKind` union values `'password_required'`/`'wrong_password'` — string literals describing an OUTCOME, never the secret — or comments). `handleExtractionFailure()`'s reconciliation-case `details` object is `{ kind }` only. The `document_processing_failed` audit event's metadata is `{ kind, parseRunId }` only. **This satisfies the critical failure condition "password persisted/logged" as a hard negative, not an assumption.**
- **PAN**: a genuine finding from this review — `ParsedAccountRecord.raw` originally retained the FULL unmasked PAN line verbatim (it was not yet persisted downstream, but was a latent leak vector). Fixed: `redactPanFromLine()` masks the PAN in `.raw` at parse time, in both provider adapters. Proven by a dedicated test (`iiR2PanRedaction.test.ts`) asserting the full PAN digit string never appears anywhere in parsed output for either CAMS or KFintech. `panMasked` (the field actually intended for use) was already correctly masked from the start via `maskPan()`.
- **Full folio/account numbers**: `ii_accounts.account_number_masked` remains the only account-number-shaped column (R1, unchanged); R2 never populates it with an unmasked value (no R2 code path reads a full account-number field from any statement — the CAS grammar only exposes `folio_number`, which R0/R1 already classified as a lower-sensitivity identifier, not a bank-account-shaped secret, and is stored in the clear exactly as R1 already did).
- **Raw document text/financial data**: never written into `ii_audit_events.metadata` — every `emitAuditEvent()` call site in R2 code passes only ids, counts, codes, and confidence numbers (hand-reviewed, all ~20 call sites in `documentProcessing.ts` plus the 2 in the extended `resolve` route).

## 6. Cross-tenant isolation — design-verified, live-execution BLOCKED

Every read path in the new R2 API routes uses the RLS-respecting `createClient()` (`@/lib/supabase/server`), with an explicit `.eq('user_id', user.id)` filter as defence-in-depth on top of RLS (matching R1's established discipline — "no Investment Intelligence UI/API design may fetch broader data and filter client-side," `R0_SECURITY_RLS_ARCHITECTURE.md` section 3). No new route queries an `ii_*` table through the service-role client on a genuinely user-facing read path.

**What could not be proven live in this sandbox**: an actual cross-user PATCH/GET attempt against the new tables over real HTTP against DEV, of the kind R1's `scripts/ii_r1_live_dev_security_tests.mjs` performed for the R1 tables — this requires migrations `0039`-`0041` applied to DEV first. **BLOCKED, not FAIL, not skipped-and-ignored** — flagged exactly as R1's own report flagged the equivalent gap, with the same honest distinction between "written and correctly shaped, verified by hand-review against the file text and against the existing, proven pattern it replicates" and "genuinely executed against a live database." No structural defect was found in any policy on inspection.

## 7. Summary verdict

Every RLS policy for the 5 new tables is written and structurally correct, hand-verified against migration SQL text (5-for-5 tables, 5-for-5 policies). Every new API route requires authentication and re-verifies ownership. No secret (password) or high-sensitivity identifier (full PAN) survives in any parsed/logged/audited artifact — one genuine PAN-leak-shaped finding was made and fixed during this very review, with a regression test added. Live cross-tenant HTTP proof against the new tables is BLOCKED pending migration application to DEV, consistent with this project's established pattern for every migration-dependent phase since R1.
