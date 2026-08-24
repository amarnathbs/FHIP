# FDH-6 — Live DEV Certification

Script: `scripts/fdh6_live_dev_certification.ts` (`npx tsx scripts/fdh6_live_dev_certification.ts [appBaseUrl]`). Mirrors the proven shape of `scripts/r7final_live_dev_certification.mjs` / `scripts/fdh5_live_dev_certification.ts` — real running Next.js app for every user-facing action, real DEV Supabase REST (service-role) for test-data setup / ground-truth verification / cleanup only.

## Mandatory flow coverage (spec section 105)

`FDH-3 upload -> CSV or PDF parser -> canonical transaction -> R8 merchant/category -> FDH-6 economic class -> transfer/recurring/etc -> review state` — exercised twice, once per source format:

- **CSV** (`FDH6-CSV-01..03`): real upload through `/api/financial-data-hub/bank-csv/upload`, real `/detect` + `/process` (R7/FDH-4's certified CBA adapter), then the real `/api/financial-data-hub/bank-transactions/categorise` route (R8's classification engine, unmodified) — the full chain, live.
- **PDF** (`FDH6-PDF-01..06`): real upload through `/api/financial-data-hub/bank-pdf/upload` (FDH-5's certified native-text adapter, synthetic fixture built with the SAME `buildBankPdfFixture` helper FDH-5's own live cert uses), real `/process`, then the SAME classification route — proving PDF-sourced transactions receive identical downstream intelligence to CSV-sourced ones (spec section 95's cross-format equivalence), including one of FDH-6's own new economic-class rules (`BROKER FUNDING` -> `asset_purchase`) resolving correctly from a PDF-sourced transaction.

## Matched transfer + no double-counting (spec sections 108, 22, 128)

`FDH6-XFER-01..08`: two accounts, a matched $750 debit/credit pair, real classification proposes a `pending` `internal_transfer` link (never auto-confirmed). Before confirmation, neither side is `transfer`. The user confirms via the real `/transaction-links/{id}/review` route — this is the FIRST live proof that `applyTransferClassOnConfirm()` (this phase's central gap closure) actually works end to end: BOTH transactions flip to `economic_transaction_type = 'transfer'`, neither is `income` or `expense`, and the write-back is independently auditable (`fdh_transaction_corrections` rows exist for both sides).

## Missing counterpart (spec section 109)

`FDH6-MISSING-01/02`: a lone transfer-looking transaction with no matching counterpart anywhere produces a persistent OPEN link (`transaction_id_to IS NULL`, `status = 'pending'`) — never a fabricated match, and the transaction itself stays `unknown`/`pending`, never forced to income or expense.

## User correction (spec section 110)

`FDH6-CORRECT-01..03`: a real correction via `/bank-transactions/{id}/correction` persists, marks `user_override = true`, and the global classification rule the transaction originally matched (`asset_purchase_broker_funding_generic`) is independently re-read and proven completely unchanged — no automatic global-rule mutation from one user's correction (spec sections 13-14).

## Split allocation (spec section 112)

`FDH6-SPLIT-01/02`: a $300 transaction split into $220 + $80 via the user's own RLS-scoped session (never service-role) against the existing `fdh_transaction_allocations` schema — sum verified exactly equal to the parent amount using integer minor-unit arithmetic, no floating-point tolerance.

## Tenant attack (spec sections 86, 111)

`FDH6-SEC-01..07` — real Tenant B, real forged attempts, all blocked: read A's transaction (RLS), classify call touches only B's own data, forged transfer-link review, forged correction, read A's personal rules, read A's split allocations, and a forged direct INSERT into `fdh_transaction_links` impersonating A (RLS `with check`).

## Cleanup (spec section 113)

Both synthetic users deleted via the admin API; independently re-verified (not merely trusting a success message): zero residual transactions, zero residual accounts, both user lookups return 404.

## Results

See `FDH6_COMPLETION_REPORT.md` section 13 for the actual, reproduced pass/fail counts and any disclosed gaps from the real run against DEV project `vqycarelcoijzwlpkpcz`.
