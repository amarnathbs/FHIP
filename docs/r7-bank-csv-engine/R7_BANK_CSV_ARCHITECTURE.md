# R7 — Bank CSV Engine: Architecture

## 1. Ownership boundary

Canonical bank-data ownership remains with the Financial Data Hub (FDH). R7 introduces **zero** new `ii_*` tables. It extends the existing, previously-writer-less FDH-1 schema:

| Table | Owner phase | R7's role |
|---|---|---|
| `fdh_statement_uploads` | FDH-1 (0046), widened FDH-3 (0058) | Detection/certification columns added (0064) |
| `fdh_transactions` | FDH-1 (0047) | Dedup/type-hint columns added (0064); **first writer** |
| `fdh_duplicate_candidates` | FDH-1 (0047) | **First writer** |
| `fdh_reconciliation_results` | FDH-1 (0048) | **First writer** |
| `fdh_data_quality_results` | FDH-1 (0048) | **First writer** |
| `fdh_data_provenance` | FDH-1 (0048) | **First writer** |
| `fdh_review_items` | FDH-1 (0048) | Written for account-ambiguity/duplicate/reconciliation-failure cases |
| `fdh_financial_accounts` | FDH-1 (0046) | `account_fingerprint` populated for the first time |
| `fdh_parser_registry` / `fdh_parser_versions` | FDH-1 (0045) | 8 adapters registered, 6 certified |
| `fdh_csv_mapping_templates` | **new (R7)** | Generic-mapping storage |
| `fdh_transaction_corrections` | **new (R7)** | Layered user corrections |
| `fdh_document_audit_events.event_type` | FDH-3 (0058) | Widened (additive) with 10 R7 event types |

No column, table, or index anywhere in R7 contains `units`, `nav`, `folio`, `holding`, `instrument`, `security_master`, `valuation`, or `portfolio` (verified by `tests/unit/r7SchemaContract.test.ts`).

## 2. Module layout

```
lib/financial-data-hub/bank-csv/          -- pure engine, zero DB access
  constants.ts        safe intake limits, versions
  csv.ts               encoding/delimiter detection, safe RFC4180 parser, formula-injection guard
  dateFormats.ts        deterministic date parsing (never locale-guessed)
  amount.ts             exact-magnitude money-text parsing
  detection.ts           the format/adapter detection pipeline
  adapters/               BankCsvAdapter registry (6 certified + 2 experimental)
  normalize.ts           canonical transaction normalisation (one path, adapter or mapping)
  fingerprint.ts          economic fingerprint + source-row hash
  dedup.ts                4-layer dedup decision logic
  reconciliation.ts       balance rollforward + date coverage
  accountIdentity.ts      account fingerprint + fail-safe resolution
  orchestrator.ts          ties the above into one deterministic, DB-free pipeline
  pagination.ts            FDH-local fetchAllRows (duplicated from II, see file header)
  repository.ts             paginated DB reads feeding the pipeline

lib/financial-data-hub/services/
  bankCsvUploadService.ts        upload + account resolution
  bankCsvProcessingService.ts    detect / map / process orchestration (DB writes)
  bankTransactionActionsService.ts  duplicate-resolution / correction

app/api/financial-data-hub/bank-csv/**        upload, detect, map, process, status, reconciliation
app/api/financial-data-hub/bank-transactions/**  list, get, duplicate-resolution, correction

supabase/migrations/0064_r7_bank_csv_engine_foundation.sql
```

**Pure-core / thin-shell split.** Every parsing, normalisation, dedup and reconciliation decision lives in `bank-csv/*` as pure functions taking plain data and returning plain data — no Supabase client anywhere in that directory except `repository.ts` (read-only paginated fetches) and `pagination.ts`. This is what makes the 198-case vitest certification suite run in under 5 seconds with zero database dependency, and it's what the independent Python oracle compares against directly (`scripts/r7_oracle_compare.ts` imports `runBankCsvPipeline` and nothing else from the engine).

## 3. Processing state machine

R7 reuses FDH-1's `processing_status` lifecycle (`created → uploaded → validating → queued → processing → extracted → review_required/ready_for_approval → approved`, plus `rejected`/`failed`) rather than inventing a parallel one. A **new, separate** `certification_status` column (`certified` / `partial` / `review_required` / `rejected`) records R7's own conclusion about the import — set together with, never instead of, a `processing_status` transition. See `R7_CANONICAL_TRANSACTION_CONTRACT.md` §4 for the exact mapping and `lib/financial-data-hub/domain/documentLifecycle.ts` for the transition table (unmodified by R7).

Detection sub-status (`detection_status`: `detected`/`ambiguous`/`unsupported`/`manual_mapping_required`/`invalid`) and dedup sub-status (`fdh_transactions.dedup_status`) are further, finer-grained states layered on top — following the exact precedent `lib/financial-data-hub/domain/uploadSubstate.ts` set for FDH-3's UX-facing substates.

## 4. Same-user forgery hardening

FDH-1's `fdh_transactions`/`fdh_statement_uploads` RLS policy is the house-standard broad `for all using (auth.uid()=user_id)`. Before R7, neither table had a writer, so this was never exercised. R7 introduces genuinely authoritative columns onto both, so migration 0064 adds:

- Two `BEFORE UPDATE` triggers blocking the `authenticated` role from writing R7's authoritative columns directly (detection/certification results, dedup fingerprints — full list in the migration).
- Five `BEFORE INSERT` triggers making `fdh_transactions`, `fdh_reconciliation_results`, `fdh_data_quality_results`, `fdh_data_provenance`, and `fdh_duplicate_candidates` engine-authoritative-insert-only (zero regression risk — none had a writer before R7).
- One narrowing trigger on `fdh_duplicate_candidates` permitting exactly one legitimate authenticated-role transition (resolving your own pending candidate) and blocking everything else.

R7's service layer therefore uses the service-role client for these specific writes — a documented **third** sanctioned service-role file alongside `services/storage.ts` and `services/auditLog.ts` (see `bankCsvProcessingService.ts`'s header comment). See `R7_SECURITY_VERIFICATION.md` for the full live forgery-test evidence.

## 5. FDH/II import-graph isolation

`tests/unit/fdh1Isolation.test.ts` (pre-existing, FDH-1, Product Owner Decision 2) asserts no file under `lib/financial-data-hub/**` imports from `lib/services/investment-intelligence/**` or `lib/engines/investment-intelligence/**`. R7's pagination helper is therefore a **duplicated**, not imported, copy of the identical `fetchAllRows` contract II converged on (`lib/financial-data-hub/bank-csv/pagination.ts`) — discovered as a genuine regression during this build (see `R7_TESTING_AND_VERIFICATION.md` §2) and fixed before merge.

## 6. Investment-transfer boundary

`transaction_type_hint = 'investment_transfer_candidate'` is a bounded, deterministic string hint on a cash-movement row — never a unit, NAV, folio, or holding. No code path in R7 writes to `ii_transactions`, `ii_tax_lots`, or any `ii_*` table. See `R7_CANONICAL_TRANSACTION_CONTRACT.md` §7 and certification cases R7-TC156-158.
