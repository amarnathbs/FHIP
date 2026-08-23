# FDH-4 — Canonical CSV Architecture

One pipeline. No parallel engine.

```text
FDH-3  Secure Document Lifecycle  (upload, storage, RLS, retention state machine)
        |
R7     CSV intake + safety            lib/financial-data-hub/bank-csv/csv.ts
        |
R7     Institution/format detection   lib/financial-data-hub/bank-csv/detection.ts
        |
R7+FDH4 Bank adapter                  lib/financial-data-hub/bank-csv/adapters/{registry,auAdapters,inAdapters,genericAdapters}.ts
        |                              (FDH-4 added 4 declarative adapters; zero new adapter *code path*)
R7     Canonical transaction normalisation   lib/financial-data-hub/bank-csv/normalize.ts -> fdh_transactions
        |
R7     Deterministic deduplication    lib/financial-data-hub/bank-csv/dedup.ts + fingerprint.ts
        |
R7     Statement reconciliation       lib/financial-data-hub/bank-csv/reconciliation.ts -> fdh_reconciliation_results
        |
R7     Orchestration/certification    lib/financial-data-hub/bank-csv/orchestrator.ts -> certification_status
        |
        Review-ready FDH records (fdh_transactions, review_status; no Input Data write)
```

Orchestration entry points (`services/bankCsvUploadService.ts`, `services/bankCsvProcessingService.ts`) and the API surface (`app/api/financial-data-hub/bank-csv/**`) are unmodified by FDH-4 — the adapter registry they consume grew from 6 to 10 entries; nothing about how they call it changed.

## What FDH-4 actually changed

1. **`lib/financial-data-hub/bank-csv/adapters/auAdapters.ts`** — added `AU_ANZ_DEBIT_CREDIT_V1`, `AU_MACQUARIE_DEBIT_CREDIT_V1`.
2. **`lib/financial-data-hub/bank-csv/adapters/inAdapters.ts`** — added `IN_AXIS_DEBIT_CREDIT_V1`, `IN_KOTAK_DEBIT_CREDIT_V1`.
3. **`lib/financial-data-hub/bank-csv/adapters/registry.ts`** — re-exports the 4 new adapters; `AU_ADAPTERS`/`IN_ADAPTERS` arrays widened.
4. **`supabase/migrations/0066_fdh4_bank_adapter_coverage_expansion.sql`** — pure additive seed: 4 `fdh_parser_registry` rows, 4 `fdh_parser_versions` rows (`status='certified'`), `coverage_status` advanced to `parser_certified` for exactly `(AU,anz)`, `(AU,macquarie_bank)`, `(IN,axis_bank)`, `(IN,kotak_mahindra_bank)` — following migration 0064's own precedent verbatim. **Not yet applied to DEV or production** (no DDL-execution credential in this environment — see `FDH4_COMPLETION_REPORT.md` residuals).
5. **8 new fixture files** (`tests/fixtures/r7-bank-csv/{au_anz,au_macquarie,in_axis,in_kotak}_debit_credit.{csv,profile.json}`) — synthetic, non-identifying, auto-discovered by the existing independent-oracle harness (`scripts/r7_oracle_compare.ts`).
6. **`tests/unit/fdh4AdapterCoverage.test.ts`** — 20 new certification cases (detection positive, cross-adapter false-positive negative controls, hand-computed reconciliation incl. a deliberate negative control).
7. **Two new live-DEV certification scripts** (`scripts/fdh4_live_dev_certification.ts`, `scripts/fdh4_live_scale_certification.ts`) — no production code, certification tooling only.

Everything else in the pipeline — detection, normalization, dedup, reconciliation, the transaction table, the reconciliation table, the API routes, the orchestrator — is untouched R7 code, reused exactly as certified.

## Adapter contract (unchanged, per spec section 10)

R7's `BankCsvAdapter` (`adapters/types.ts`) is deliberately **declarative, not behavioural** — it does not implement `detect()`/`validate()`/`parse()`/`reconcile()` itself. Those verbs live centrally in `detection.ts`/`normalize.ts`/`reconciliation.ts`, which every adapter shares:

```ts
interface BankCsvAdapter {
  id: string; institutionCode: string | null; country: 'AU' | 'IN' | null;
  version: string; certificationState: 'certified' | 'experimental'; displayName: string;
  signature: { requiredHeaders: string[]; optionalHeaders?: string[]; expectedColumnCount?: number };
  amountConvention: 'single_signed' | 'debit_credit_columns' | 'dr_cr_indicator';
  dateFormat: SupportedDateFormat; delimiter: string;
  columnRoles: { transactionDate; postedDate?; valueDate?; description; amount?; debit?; credit?; drCrIndicator?; balance?; reference? };
  scoreHeader(header: readonly string[]): number;
}
```

This is why FDH-4's adapter-coverage work required **zero new engine code**: a 9th/10th/11th/12th adapter is a data object plus a fixture, not a new code path. Spec section 10's instruction — "do not create a second FDH-specific adapter interface if R7 already has a suitable one" — was followed; the existing interface needed no extension at all for the 4 new banks.

## Economic classification boundary (unchanged, spec section 12)

FDH-4 adds no classification logic. `credit_debit` records transaction *direction* only; `economic_transaction_type` is always written as `'unknown'` at ingestion (`normalize.ts`), `classification_method` as `'unclassified'`. Credit-is-not-income and debit-is-not-expense remain enforced purely by omission — nothing downstream of R7's normalizer infers economic meaning.
