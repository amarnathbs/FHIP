# R2 — Transaction Normalisation

Status: FINAL

## 1. Canonical taxonomy (spec section 19)

`ii_transactions.transaction_type` (migration `0040`) extends R1's 12-value taxonomy with 8 new values, keeping every R1 value unchanged:

`purchase, sip, redemption, switch_in, switch_out, dividend, reinvestment, transfer, merger, fee, tax, adjustment` (R1, unchanged) **+** `stp_in, stp_out, swp, transfer_in, transfer_out, reversal, segregation, unclassified` (R2, new).

`transactionTypeMapping.ts`'s `classifyTransactionType()` is a deterministic, ORDERED rule table (most-specific-first) mapping a raw statement description to one canonical type + a confidence (1.0 for an exact keyword match, 0 for `unclassified`). Order matters and is deliberate:

```
stp_in -> stp_out -> swp -> reversal -> switch_in -> switch_out
  -> dividend_reinvestment -> reinvestment(generic) -> dividend
  -> sip -> purchase -> redemption
  -> transfer_in -> transfer_out -> transfer(generic)
  -> merger -> segregation -> fee -> tax -> adjustment
  -> (no match) unclassified, confidence 0
```

`reversal` is checked **before** the generic `purchase`/`redemption` rules deliberately — a real RTA narrative like `"Purchase - Reversed"` or `"Redemption Reversal"` contains a purchase/redemption keyword too, and the reversal fact is the more important classification signal. This exact ordering bug (reversal misclassified as purchase) was **found and fixed during golden-fixture testing** — see `R2_TESTING_AND_VERIFICATION.md`. An unknown description is **never** forced into an incorrect type (spec section 19's hard requirement) — it becomes `unclassified`, and the orchestrator opens a `TRANSACTION_UNCLASSIFIED` reconciliation case when the line is material (nonzero amount).

## 2. Canonical transaction record (spec section 20)

Every field spec section 20 names is present on `ii_transactions` (R1 baseline + R2 additions, migration `0040`): source document (`source_document_id`), source transaction reference (`source_reference`, R1), canonical account/instrument (`account_id`/`instrument_id`), transaction date, transaction type, source description (`source_description`, new — the raw statement line, truncated defensively), amount/units/NAV, fees/taxes (new, explicit-only columns, never inferred), source currency (`currency_code`, R1, never pre-converted per `R0_CROSS_BORDER_CONTRACT.md`), parser version (`parser_code`/`parser_version_used`, new), provenance (`source_document_id` + `parse_run_id`, new), confidence (new), status (R1). **R2 never calculates tax consequences** — `fees`/`taxes` are raw fields captured only when explicitly present on the statement, never derived.

## 3. Exact numeric parsing (spec section 13)

`decimal.ts` — see its own extensive header comment. Summary: a new, minimal, dependency-free fixed-point decimal module (BigInt scaled by 10^6), because no Decimal/BigNumber library existed anywhere in this codebase and ordinary JS `number` arithmetic is explicitly forbidden by spec as the authoritative representation. Handles Indian (`1,25,000.50`) and Western (`125,000.50`) comma grouping identically (commas are simply stripped, wherever they occur), currency-symbol prefixes (`₹`, `Rs.`, `Rs`, `INR`, `$`, `A$`, `AUD`), negative values (leading/trailing minus, parenthesised accounting convention), zero, and variable precision (units to 3-6 decimals, NAV to 4-6 decimals). Explicitly rejects `NA`/`N/A`/`Nil`/bare `-` rather than guessing zero. See `tests/unit/iiR2Decimal.test.ts` for the full test pack, including a direct proof that `0.1 + 0.2 !== 0.3` in ordinary JS floats but the scaled-decimal sum is exact.

## 4. Date normalisation (spec section 14)

`dateNormalisation.ts`'s `parseStatementDate()` supports exactly the formats actually observed in the supported golden fixtures: `DD-MMM-YYYY`/`DD-MMM-YY` (CAMS), `DD/MM/YYYY`/`DD-MM-YYYY` (KFintech and generic), and already-ISO `YYYY-MM-DD` passthrough — every one DD-first, **never** confused with `MM/DD/YYYY` (explicitly tested: `31/04/2025` is correctly rejected as an invalid date rather than silently reinterpreted, and `03/02/2025` parses as 3 February, not March 2nd). Real calendar validation (leap years, days-per-month) is performed, not just pattern matching.

## 5. Transaction fingerprinting for deduplication (spec section 21)

`fingerprint.ts`'s `computeTransactionFingerprint()` — a SHA-256 hex digest over a canonical string built from **exact decimal-string representations** (never floats) of: source key, resolved `account_id`, resolved `instrument_id` (canonical IDs, not raw folio/scheme text — see the module's own header comment for why this is deliberate: it makes the same real transaction fingerprint identically even across a scheme-name variation once both resolve to the same canonical instrument), transaction date, canonical transaction type, amount, units, NAV, and source reference (or the literal string `"null"` when absent — a missing reference is still part of the fingerprint input, not skipped, to avoid two genuinely distinct anonymous same-day/same-amount rows silently colliding by omission).

Enforced at the database level: `uidx_ii_transactions_fingerprint` — a partial unique index on `(account_id, transaction_fingerprint)` (migration `0040`). This is the direct, DB-level guard against the critical-failure-condition "duplicate transactions after overlapping imports."

## 6. Multi-source lineage (spec sections 22, 45)

`ii_transaction_source_links` (migration `0040`) — one row per (canonical transaction, corroborating document) pair, `is_originating` marking exactly the one link that created the canonical row. When a later/refreshed/overlapping statement re-reports a transaction whose fingerprint already exists for that account, the orchestrator (`documentProcessing.ts`) inserts a **new link row**, never a duplicate `ii_transactions` row — source lineage is preserved (DEDUP-003), never silently discarded (spec section 45: "if two source documents disagree, do not silently choose one — create reconciliation evidence").
