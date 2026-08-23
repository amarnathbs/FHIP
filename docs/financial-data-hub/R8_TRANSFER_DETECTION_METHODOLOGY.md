# R8 — Transfer / Settlement / Refund Detection Methodology

## 1. Never on amount alone (spec section 30)

`matchInternalTransfers()` (`lib/financial-data-hub/classification/transferMatching.ts`)
requires ALL of:

1. Different `financial_account_id` (never pairs a transaction with itself
   or a same-account duplicate).
2. Opposite `credit_debit` direction.
3. Identical `amount_original` AND `currency_original` (no FX-adjusted
   cross-currency matching — disclosed residual, see section 6).
4. A date within a bounded window (default 3 days).

Confidence is HIGH when the source references match exactly (`source_
reference`) or the date gap is ≤1 day; MEDIUM otherwise. **Every proposed
link is written `status = 'pending'`, regardless of confidence bucket** —
the algorithm never auto-confirms. A household must explicitly confirm or
reject via `POST /api/financial-data-hub/transaction-links/{id}/review`.

## 2. Assignment is greedy, closest-evidence-first

Transactions are bucketed by `(amount, currency)`. Within a bucket, every
valid candidate pair is scored (same-reference first, then ascending date
distance) and assigned greedily — each transaction is claimed by at most
one pair, and the best-evidence pair always claims its transactions before
a weaker one can. This stops the "5 near-identical $500 transfers in one
week" case from producing an arbitrary/wrong pairing.

## 3. Link type derivation

The pairing algorithm is account-type-aware, not merely direction-aware:

- Either side a `credit_card` account → `credit_card_settlement`
- Either side `home_loan`/`personal_loan`/`vehicle_loan` → `loan_payment`
- Otherwise → `internal_transfer`

## 4. Open (unpaired) candidates — never fabricated

A transaction a rule or structural hint flags as a transfer/settlement/
investment-funding candidate, but for which no in-batch counterpart exists,
gets an OPEN link (`transaction_id_to = null`) via `openCandidateLink()` —
exactly the pattern `fdh_transaction_links` was built for since FDH-1
("PERSISTENT MISSING COUNTERPART... nothing about this schema requires both
sides to exist within one import session"). Investment-funding candidates
in particular NEVER gain a fabricated fdh_transactions counterpart or an
`ii_*` row — the receiving side is Investment Intelligence's domain (spec
section 18/34).

## 5. Refund/reversal linking

`matchRefundsToOriginals()` links a transaction the economic-type engine
already classified `refund` (via a narrative-pattern rule) back to its
likely original: same account, opposite direction, same currency, amount
≤ the original (a refund can never exceed what was charged), dated on or
after the original, within a 90-day lookback. `amount_delta === 0` →
`refund_original` (HIGH confidence if ≤7 days); a smaller amount →
`reversal_original` (a partial reversal). A refund with no plausible
original in range is left unlinked.

## 6. Disclosed residuals

- No cross-currency FX-adjusted transfer matching (same currency required).
- No matching across a date window wider than 3 days without corroborating
  evidence (a genuine transfer delayed by clearing >3 days is left as an
  unmatched pair, not silently widened — a deliberate false-positive vs.
  false-negative trade-off in favour of never mis-pairing).
- No UI for the review queue yet (API-only, see `R8_ACCEPTANCE_REPORT.md`
  section on open residuals).
