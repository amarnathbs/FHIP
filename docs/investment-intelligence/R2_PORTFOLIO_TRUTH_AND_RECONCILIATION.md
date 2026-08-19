# R2 — Portfolio Truth & Reconciliation Engine

Status: FINAL

## 1. The core question (spec section 24)

For every position (an `(account_id, instrument_id)` pair — the stable cross-time identity R0 already froze), do reconstructed transactions and the statement's own closing holdings agree sufficiently to be trusted?

```
opening_units + inflows - outflows +/- adjustments  =?  closing_units   (within tolerance)
```

`reconciliation.ts`'s `reconcilePosition()` is a pure function implementing exactly this. Direction (inflow/outflow/cash-only/passthrough) is decided from the canonical transaction TYPE via a documented table (`DIRECTION_TABLE`), never from trusting whatever sign the source happened to print — `purchase/sip/switch_in/stp_in/transfer_in/reinvestment` are inflows, `redemption/switch_out/stp_out/swp/transfer_out` are outflows, `dividend/fee/tax` are cash-only (zero unit impact), and `transfer/merger/segregation/adjustment/reversal/unclassified` are "passthrough" — the raw signed value is used as-is (a reversal must be pre-signed by the parser exactly as a real RTA prints a cancelling negative-units line).

## 2. Reconciliation granularity (spec section 24)

Exactly `ACCOUNT/FOLIO + INSTRUMENT`, as required — never aggregated across folios (two folios holding the same scheme reconcile independently) and never blended across instruments.

## 3. Tolerance (spec section 25)

`reconciliationConfig.ts` — `DEFAULT_RECONCILIATION_CONFIG`:

- `unit_tolerance = 0.0001` — matches AMFI's 4-decimal-unit statement precision; a variance at or below this is rounding noise, not a genuine mismatch.
- `currency_tolerance = 1.00` (major unit, INR/AUD) — absorbs paisa/cent rounding across a chain of transactions without masking a real, material mismatch on a multi-lakh/multi-thousand portfolio value.
- `statement_freshness_warning_days = 120`.

Versioned and configurable at the database level (`ii_reconciliation_config`, migration `0041`, `config_version = 'r2-default-1.0.0'`, exactly one `is_active` row enforced by a partial unique index) — the constant in code and the seed row in the migration are required to hold identical values, checked directly by `tests/unit/iiR2DataQualityAndConfig.test.ts` reading the migration file's literal SQL. **Never a wide tolerance used to conceal a parser defect** — the default was chosen from the actual statement precision the parsers target, not picked to make tests pass.

## 4. History completeness (spec section 46)

`IiHistoryCompleteness = 'complete_from_inception' | 'complete_from_known_opening_balance' | 'partial_history' | 'holdings_only'` — four genuinely distinct, non-conflated concepts, determined by `reconciliation.ts`'s `determineHistoryCompleteness()` from what evidence is **actually available**, never defaulted to "complete" just because a value happens to be present:

- `complete_from_inception` — only when the statement/import explicitly covers from a zero opening balance.
- `complete_from_known_opening_balance` — an explicit opening-balance anchor exists (e.g. a prior certified snapshot).
- `partial_history` — transactions exist but no known opening point.
- `holdings_only` — a closing snapshot exists with zero transaction history.

This status is recorded per-position on `ii_portfolio_truth_status.history_completeness` — R4's future XIRR/CAGR engine will read this and is expected to refuse a "since inception" calculation on anything less than `complete_from_inception` (out of scope to build in R2, but the data it will need is captured correctly now).

## 5. Reconciliation cases (spec section 26)

`ii_reconciliation_cases` (R1 table) extended (migration `0041`) with a named, check-constrained `discrepancy_type` enum (was free `text`): `owner_unmatched, account_unmatched, instrument_unmatched, ambiguous_instrument, transaction_unclassified, unit_mismatch, value_mismatch, duplicate_suspected, missing_opening_history, unsupported_document, document_corrupt, document_password_required, parse_incomplete, statement_period_gap, other` — exactly spec section 26's list. Plus new columns: `severity` (`info|low|medium|high|blocking`), `source_document_id`, `evidence`, `resolution_method`, `resolved_by`, `resolved_by_actor_type`.

## 6. Portfolio Truth status (spec section 27)

`ii_portfolio_truth_status` (migration `0041`) — one **mutable, "current state"** row per position (unlike the immutable ledger tables), always pointing at the immutable evidence that justifies it (`latest_holding_snapshot_id`, `latest_source_document_id`). States: `pending, parsed, reconciliation_required, certified_with_warnings, certified, failed, superseded, archived` — reusing the existing R0/R1 vocabulary style, not inventing new words.

**`CERTIFIED` never means "parser ran without crashing."** `certification.ts`'s `evaluateCertification()` — a pure, exhaustively-tested function — is the ONE place that decision is made:

**Blockers** (force `RECONCILIATION_REQUIRED`, never silently downgraded to a warning): document corrupt, source undetected, parser fatal error, unresolved owner, unresolved/ambiguous instrument, cross-household conflict, invalid canonical record, an open blocking-severity reconciliation case, a material unclassified transaction, and a unit-variance mismatch outside tolerance.

**Permitted warnings** (`CERTIFIED_WITH_WARNINGS`, never blocking): incomplete transaction history while closing holdings still reconcile against the available window, a holdings-only position, reconciliation that could not be evaluated (no opening balance), a stale statement date, a non-material unclassified line.

A fully clean position (no blockers, no warnings) reaches plain `CERTIFIED`.

## 7. Source conflicts (spec section 45)

If two documents disagree about the same position's closing units, R2 never silently picks one. The SAME `reconcilePosition()` logic runs regardless of whether the conflicting evidence came from one document or two — reconciliation always compares the full transaction ledger against the **latest** certified snapshot, never averages or blends two snapshots, and a genuine disagreement surfaces as `unit_variance_exceeds_tolerance` (a blocker) rather than being resolved by preference.

## 8. Certification workflow (spec section 30)

`POST /api/investment-intelligence/portfolio-truth/certify` — re-runs the evaluation for one position on demand (e.g. immediately after a user resolves a reconciliation case), without requiring a fresh document upload. `POST /api/investment-intelligence/reconciliation-cases/[id]/resolve` accepts a `resolutionMethod` (`user_mapped_instrument | user_mapped_owner | user_classified_transaction | user_resolved_duplicate | user_accepted_anomaly | admin_override | auto_resolved_on_reparse`), records `resolved_by`/`resolved_by_actor_type`, and emits both a `reconciliation_case_resolved` and a `user_correction` audit event — the SOURCE EVIDENCE -> PARSER OUTPUT -> USER/ADMIN CORRECTION -> CERTIFIED CANONICAL RESULT layering spec section 30 requires, with the original source document and parsed rows never overwritten (they are immutable per R0/R1).
