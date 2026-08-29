# FDH-11 — Financial Integrity Certification (spec sections 26-38, 72-75, 96-107)

## Mandatory negative controls (spec sections 98-107) — all reproduced in `tests/unit/fdh11AuInvestmentIntelligence.test.ts`

| # | Control | Result |
|---|---|---|
| 98 | Buy as Expense: `classifyAuStatementLine('BUY')` never returns a treatment resembling `'expense'` — the type union has no such member | PASS (structural + literal assertion) |
| 99 | Sale as Income: `classifyAuStatementLine('SELL')` never returns `'ordinary_income'` | PASS |
| 100 | Broker Transfer misclassified as expense: `TRANSFER_IN` classifies as `cash_transfer` | PASS |
| 101 | Withdrawal misclassified as income: `CASH_WITHDRAWAL` classifies as `cash_transfer` | PASS |
| 102 | Dividend Double Count: naive `400+400=800` proven true (control), `reconcileDividendIncome('400','400')` returns `400` with `evidenceCount: 2` | PASS |
| 103 | Holding Double Apply: existing 100 + BUY +20 reconciles to exactly 120 (not 140, not 240) | PASS |
| 104 | Security Matching: two ISIN-distinct candidates, no identifier supplied → `unresolved`, never a name-based guess (no name-match tier exists in the matcher at all) | PASS |
| 105 | Net Worth: evidence types carry no `netWorthContribution`/`includeInNetWorth` field — structural tripwire | PASS |
| 106 | Duplicate Statement: `reconcileAuHoldings()` given the identical input twice returns byte-identical output (pure-function idempotency) | PASS |
| 107 | Overlap: feeding the SAME transaction evidence twice (un-deduplicated) is caught as `VARIANCE`, proving why dedup must happen upstream of reconciliation (in the bridge's fingerprint layer), never inside it | PASS |

37/37 total tests pass in this file (the ten above plus quantity-precision, reconciliation-state, account/security/bank-matching, and CSV-extraction coverage).

## The headline risk rules (26-31) — structurally guaranteed, not merely tested

See `FDH11_AU_TRANSACTION_INTELLIGENCE.md` for the full account. In summary: `ii_transactions` (canonical investment ledger) and `fdh_transactions` (household cash ledger) are, and remain, two structurally separate tables with no code path connecting a BUY/SELL to the latter — this is a property of the existing architecture (Product Owner Decision 2), not a new safeguard FDH-11 invented, and FDH-11's own negative controls exist to prove FDH-11 does not break it.

## Brokerage (spec section 32)

Classified as `trade_cost` — evidence only. FDH-11 makes no canonical brokerage-treatment decision (cost-basis addition vs. separate expense) because canonical Investment Intelligence has none implemented either (confirmed by inspection: no brokerage/fee handling exists in `taxLotEngine.ts`/`capitalGainsEngine.ts`). Recorded as evidence (`fdh_investment_statement_activities.brokerage_raw` on BUY/SELL rows via the CSV adapter's `Brokerage` column), never independently computed into a cost basis.

## Tax evidence, franking credits (spec sections 33-34)

`franking_credit_raw`/`withholding_tax_raw` are captured verbatim as text (never parsed into a number, never fed to any computation) — the same "evidence, never a computation" discipline FDH-10 established for India GST. No AU franking-credit engine exists in canonical II (confirmed absent — see `FDH11_REUSE_AND_GAP_AUDIT.md`); this is disclosed as a genuine Investment Intelligence gap, not fabricated.

## Capital gains / cost-basis boundary (spec sections 35-36)

FDH-11 computes no FIFO, average cost, specific-parcel matching, or CGT discount anywhere. The FIFO engine (`taxLotEngine.ts`) exists in canonical II but is never invoked by FDH-11's bridge — invoking lot *matching* without a corresponding AU tax *treatment* engine would produce a number with no legally correct meaning, so it was deliberately left unconnected rather than partially wired.

## Corporate actions (spec sections 37-38)

`CORPORATE_ACTION_EVIDENCE` never resolves to a canonical type in `applyAuStatementActivity.ts` — attempting to apply one always returns `CANONICAL_TYPE_UNSUPPORTED` and marks the row `skipped`. No code anywhere infers "quantity doubled → stock split" or any other corporate-action inference from statement data.

## Net worth (spec sections 73-75, 105)

Investment values reach net worth exclusively through the pre-existing `investments` table, read by `lib/services/dashboardData.ts` — confirmed unchanged by this pass (`git diff` shows zero modifications to `dashboardData.ts` or `lib/engines/dashboard.ts`). FDH-11's evidence tables are never read by net-worth calculation. Once an AU BUY is applied via the bridge, it becomes an `ii_transactions` row exactly like an India CAS-derived one; the pre-existing R3 publish bridge (`investmentPublicationService.ts`, unmodified) is the only path from there into `investments`/net worth — meaning a canonical AU position and its statement evidence can never double-count, because the evidence table is never itself a net-worth input.

## Live-DEV re-proof (spec sections 109-113) — completed in a follow-up closure round

Migration `0106` was applied to DEV by the Product Owner. Sections 109-113 were then re-run for real against the hosted Supabase project via `scripts/fdh11_live_dev_certification.mjs`: a real BUY applied leaves `fdh_transactions` at 0 rows for the user; a real SALE applies as canonical `sale` with `fdh_transactions` still at 0; a real bank debit + `CASH_DEPOSIT` activity match as a TRANSFER; a real bank credit + `CASH_WITHDRAWAL` activity match as a TRANSFER; a real bank dividend credit + broker `DIVIDEND` activity produce exactly one `ii_transactions` row of $400 (never $800); and the `investments` table (the net-worth source) has 0 rows for the test user throughout, proving the statement evidence never independently contributed to net worth. All PASS. Full request/response evidence in `FDH11_LIVE_DEV_CERTIFICATION.md`.
