# FDH-11 — Australia Statement Evidence Model (spec sections 23-25)

Repository naming: `fdh_investment_statements` / `fdh_investment_statement_positions` / `fdh_investment_statement_activities` (migration `0106`), mirroring `fdh_liability_statements`/`fdh_liability_statement_activities`'s established shape exactly.

## `fdh_investment_statements` (statement-level facts)

| Spec field | Column | Notes |
|---|---|---|
| user_id, document_id | `user_id`, `statement_upload_id` | `statement_upload_id` FKs `fdh_statement_uploads` (FDH-3) |
| investment_jurisdiction | `investment_jurisdiction char(2) default 'AU' check (= 'AU')` | Hard-pinned — this table is AU-only by construction |
| institution, masked_account_identifier | `institution_name`, `masked_account_identifier` | Masked identifier rejected server-side and by a DB check if it looks like a full number (`chk_..._masked_identifier`) |
| statement_type | `statement_type` | 9-value enum, spec section 15 |
| statement_date/start/end | `statement_date`, `statement_start_date`, `statement_end_date` | |
| base_currency | `base_currency` | FK `currencies` |
| opening/closing_portfolio_value, cash_balance | same names | Evidence only — never independently summed into net worth (spec 73-74) |
| parser, parser_version | `parser`, `parser_version` | |
| extraction_status | `extraction_status` | `pending / extracted / extraction_failed / ocr_required / password_required` |
| reconciliation_status | `reconciliation_status` | `reconciled / variance / insufficient_data` |
| review_status | `review_status` | FDH-7's 4-value vocabulary, reused unchanged |
| approval_status | `approval_status` | `pending / approved` — the No-Silent-Apply gate |
| source_provenance | `source_provenance` | |

`canonical_account_id` is a **plain `uuid`, no DB-level foreign key** to `ii_accounts` — see `FDH11_ARCHITECTURE.md`'s explanation of why the Hub never references an `ii_` table, even via a schema-level FK.

## `fdh_investment_statement_positions` (spec section 24 — holding-line evidence)

`security_name_raw`, `ticker_raw`, `exchange`, `isin`, `quantity numeric(20,6)` (matches `ii_holding_snapshots.units`' own scale so a value round-trips exactly once applied), `unit_price`, `market_value`, `currency_code`, `valuation_date`. `security_match_status` / `matched_instrument_id` (plain uuid) record the outcome of `securityMatching.ts`. `apply_status` / `canonical_holding_snapshot_id` / `applied_at` / `applied_by` record the outcome of `applyAuStatementPosition.ts`. Never treated as authoritative — see `FDH11_AU_HOLDINGS_RECONCILIATION.md`.

## `fdh_investment_statement_activities` (spec section 25 — transaction-line evidence)

`activity_type` (the 14-value `AU_STATEMENT_TRANSACTION_TYPES` closed vocabulary: `BUY, SELL, DIVIDEND, DISTRIBUTION, INTEREST, BROKERAGE, FEE, TRANSFER_IN, TRANSFER_OUT, CASH_DEPOSIT, CASH_WITHDRAWAL, DRP, CORPORATE_ACTION_EVIDENCE, OTHER, UNKNOWN`), `trade_date` + `settlement_date` preserved **separately** (spec section 53 — never conflated), `quantity`/`unit_price` (nullable — many activity types are cash-only), `amount` (positive magnitude, direction/meaning derived, mirroring `fdh_transactions.amount_original`'s own convention), `franking_credit_raw`/`withholding_tax_raw` (evidence-only text, never parsed into a tax computation — spec section 33). `linked_transaction_id` is the single bridge to `fdh_transactions` (FDH-1's cash ledger) for bank matching. `bank_match_candidates jsonb` records every candidate that cleared the scoring threshold, for the review UX (spec section 68's compare view), even when none was auto-selected.

## Statement vs trade confirmation (spec section 58)

Not implemented this pass — no trade-confirmation adapter exists, so the "one canonical transaction, multiple evidence sources" scenario is untested for that specific document pair. The underlying mechanism (fingerprint-based dedup at Apply time) would handle it identically to the overlapping-statement case if a trade-confirmation adapter existed; this is disclosed as a residual, not fabricated as tested.
