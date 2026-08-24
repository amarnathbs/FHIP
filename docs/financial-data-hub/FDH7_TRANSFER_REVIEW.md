# FDH-7 — Transfer Review

FDH-6 owns transfer detection; FDH-7 owns nothing new here — the entire confirm/reject/missing-counterpart workflow already existed and is reused verbatim.

## Actions (spec 33), all pre-existing

`POST /api/financial-data-hub/transaction-links/{linkId}/review` (R8) with `{ decision: 'confirm' | 'reject' }`:
- **CONFIRM MATCH**: link -> `confirmed`; both underlying transactions have `economic_transaction_type` written to `'transfer'` via `applyTransferClassOnConfirm()` (FDH-6's central gap-closure fix) — never independently contributing income/expense again (spec 35, verified in `FDH7_FINANCIAL_INTEGRITY_CERTIFICATION.md`'s transfer negative control).
- **REJECT MATCH**: link -> `rejected`, DB-trigger-enforced one-way (`pending -> rejected` only); the underlying transactions are untouched and remain eligible for normal classification (spec 36).
- **MISSING COUNTERPART_ACCOUNT** (spec 37): a `transaction_id_to IS NULL` link stays open indefinitely (FDH-1's `uq_fdh_links_open` partial index design) until a future statement's import resolves it — no code path forces the transaction to expense/income while waiting.

FDH-7 adds no new UI action beyond confirm/reject; "upload counterpart later" / "mark as external payment" are product-UI framings of the existing open-link state, not new backend transitions (SELECT DIFFERENT COUNTERPART / MARK AS NOT A TRANSFER both resolve to the existing `reject` decision plus, if desired, a fresh `user_manual` link — no new schema needed, `created_by_method` already supports it).

## Split conflict guard (spec 48, new in FDH-7)

`transactionSplitService.ts#splitTransaction` refuses to split a transaction that is currently the CONFIRMED side of an `internal_transfer`/`credit_card_settlement` link unless every allocation is also `economic_transaction_type = 'transfer'` — the transfer relationship must be rejected first. Deterministic, documented in `FDH7_TRANSACTION_SPLITS.md`.

## Summary exclusion (spec 58, 106 — the critical certification item)

Confirmed transfers never create false income + expense in the Approved Financial Summary — see `FDH7_APPROVED_FINANCIAL_SUMMARY.md` and the dedicated negative control in `tests/unit/fdh7ApprovedSummaryOracle.test.ts`.
