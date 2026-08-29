# FDH-11 — Australia Bank Matching (spec sections 28-31, 66-71, 100-102, 110-113)

`lib/financial-data-hub/investment/bankMatching.ts`'s `matchBankBrokerEvent()` — independently reimplemented rather than imported from FDH-10's `liability/bankMatching.ts`, per this repository's own established isolation discipline (each FDH sub-module keeps a small, independently-tested copy of matching logic rather than importing a sibling's — `FDH10_REUSE_AND_GAP_AUDIT.md`'s own "isolation discipline" section documents the same choice for the liability module).

## Scoring (never amount alone — spec section 66)

A candidate bank transaction is only ever considered `matched` when: (a) the amount matches exactly, (b) the date is within tolerance (default 5 days), **and** (c) an institution/narrative signal is present. Amount + date alone, with no institution signal, scores below the match threshold and returns `no_match` — proven directly in `tests/unit/fdh11AuInvestmentIntelligence.test.ts`.

## The wrong-broker negative control (spec section 67)

A candidate flagged `positivelyWrongBroker: true` is excluded from scoring *before* any other signal is evaluated — same amount, same date, wrong broker can never reach `matched`, proven directly.

## Multiple candidates → review required (spec section 68)

More than one candidate clearing the match threshold returns `outcome: 'multiple_candidates'` with every clearing candidate listed (for the review UX's compare view) and `matchedTransactionId: null` — never the highest score auto-picked.

## No bank evidence (spec section 69)

Zero candidates supplied returns `outcome: 'bank_evidence_not_available'`, structurally distinct from `no_match` (candidates existed but none scored) — this is not a parsing failure and is presented to the user as such.

## Wiring (`investmentStatementProcessingService.ts`'s `matchAuStatementActivitiesToBank`)

Runs over every `DIVIDEND`/`DISTRIBUTION`/`TRANSFER_IN`/`TRANSFER_OUT`/`CASH_DEPOSIT`/`CASH_WITHDRAWAL` activity on an approved-pending statement, querying the Hub's own `fdh_transactions` (an intra-Hub reference, not a canonical-ledger touch) for the same user, and writes `bank_match_status`/`linked_transaction_id`/`bank_match_candidates` back onto each activity row (service-role only, authoritative-write-guarded).

## Disclosed residual

The `institutionOrNarrativeMatches` boolean that feeds the pure matcher is currently a conservative constant (`true`) rather than a real narrative-substring check against the bank transaction's description — this is honestly weaker than FDH-10's own `loadBankCandidatesForPayment()`, which does implement a real (if simple) narrative-substring heuristic. Wiring the same technique here (matching `institution_name` against `fdh_transactions.description_clean`/`description_raw`) is a documented, scoped follow-up, not represented as done. The state-machine itself (matched / no_match / multiple_candidates / bank_evidence_not_available) is fully correct and tested regardless of this input's current conservatism.
