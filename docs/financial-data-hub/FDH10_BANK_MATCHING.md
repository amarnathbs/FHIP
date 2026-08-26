# FDH-10 — Bank Payment Matching

## Never amount alone (spec section 39, mandatory negative control)

`lib/financial-data-hub/liability/bankMatching.ts`'s `matchBankPayment()` scores every candidate on four independent signals: amount (exact), date proximity (within a tolerance, default 5 days), institution/narrative match, and recurring-pattern match. A candidate matching on amount+date alone — with **no** institution/narrative/recurring signal at all — is excluded before scoring even begins (`scoreCandidate()` returns `null`). A candidate carrying a **positive** signal that it belongs to a different facility (`positivelyWrongFacility: true`) is excluded outright, regardless of score.

Certified in `tests/unit/fdh10BankMatching.test.ts`: a same-amount, wrong-lender candidate produces `no_match`, never `matched`.

## Multiple candidates -> REVIEW_REQUIRED (spec section 41)

When more than one candidate clears the match threshold (60/100), the outcome is `multiple_candidates` with `matchedTransactionId: null` — the function never auto-picks the highest score. This is a deliberate design choice: a near-tie is exactly the case a human should resolve, and this project's established negative-control discipline treats "picked the best guess anyway" as equivalent in kind to picking randomly.

## One repayment event (spec section 43)

`matchBankPayment()`'s result type carries no instruction to create anything — only a reference to an EXISTING `fdh_transactions` id. There is no code path in this module that can produce a second cash-outflow write; the structural absence of a "create new transaction" field on `BankMatchResult` is the guarantee, verified by an explicit test asserting the result object has no such key.

## Facility matching (spec sections 50-52)

`facilityMatching.ts`'s `matchLiabilityFacility()` — separate from bank-payment matching — resolves which existing `Liability` a statement belongs to. Two tiers: masked-identifier match (strongest, requires debt-type + currency agreement too) then institution+type+currency. **Never balance alone** — a statement's closing balance is never used as a matching signal anywhere in this function. Two same-issuer cards with no masked identifier on file both fall into `ambiguous`, never merged (spec section 72).

## Certification

18 tests across `fdh10BankMatching.test.ts` (bank-payment matching) covering: positive match, wrong-facility-same-amount (the mandatory negative control), amount+date-alone rejection, multiple-candidates review-required, date-tolerance exclusion, recurring-pattern-as-substitute-signal, and the structural one-event guarantee; plus facility-matching cases (masked-identifier resolution, same-bank ambiguity, no-signal no-match, cross-type/currency rejection).

## Residual

No service in this pass queries real `fdh_transactions` candidates and calls these functions against them — they are pure, fully-tested decision functions, ready to be wired into a matching service that was not built this pass.
