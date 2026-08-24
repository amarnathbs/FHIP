# FDH-6 — Transfer Intelligence

## Ownership

The matching ENGINE (`lib/financial-data-hub/classification/transferMatching.ts`) is 100% R8's — pure, tested, unmodified by FDH-6. FDH-6's contribution is the missing WRITE-BACK: `applyTransferClassOnConfirm()` in `classificationReviewService.ts`, which closes the gap FDH-2's own taxonomy migration (`0053`) explicitly flagged as a forward reference to this phase.

## Evidence and matching (unchanged, R8)

`matchInternalTransfers()` requires, for every proposed pair:
- different `financial_account_id` (never matches within one account)
- opposite `credit_debit` direction
- identical `amount_original` + `currency_original` (exact-money bucket key — spec section 23)
- a date within `TRANSFER_THRESHOLDS.DATE_WINDOW_DAYS` (3 days — spec section 24's "narrowly justified window")

No institution equality requirement (spec section 27 — cross-bank works); no amount tolerance (spec section 23); never a one-to-many casual match — each transaction is claimed by at most one pair, closest-date/same-reference-first (spec section 25).

## Confidence

`TRANSFER_THRESHOLDS.HIGH_CONFIDENCE_DAY_THRESHOLD` (1 day) or a matching `source_reference` → HIGH (1.0); wider (but still in-window) → MEDIUM (0.6). An unpaired structural candidate (`openCandidateLink`) is recorded at 0.3 — deliberately low, a hint, never a match.

## Missing counterpart (spec section 26)

`fdh_transaction_links.transaction_id_to` is nullable by design (FDH-1, migration `0047`). `openCandidateLink()` writes exactly this shape when a `flag_candidate` rule fired but no pairing was found — `status = 'pending'`, no counterpart. `explainTransactionReviewReasons()` (FDH-6, gap G1) surfaces this as `MISSING_COUNTERPART_ACCOUNT`, distinct from the weaker `POSSIBLE_TRANSFER` (a pending link with BOTH sides present, awaiting confirmation only).

## Confirmation now completes the loop (FDH-6's addition)

Before this phase: confirming a transfer link (`reviewTransactionLink`, decision `confirm`) only moved the LINK row `pending -> confirmed`. The two transaction rows themselves kept whatever the classify tier had already assigned (almost always `unknown`, since transfer-looking narratives only ever produce `flag_candidate` matches). A confidently-matched, user-confirmed internal transfer sat in the review queue as UNKNOWN forever unless a human separately corrected both transaction rows.

`applyTransferClassOnConfirm()` now, on confirmation of an `internal_transfer` or `credit_card_settlement` link with both sides present:
1. Looks up the existing FDH-2 category (`transfer_own_account`/`internal_transfer` or `credit_card_payment`/`credit_card_bill_payment`) by key — no new taxonomy row.
2. For each side, if the transaction has NOT already been human-corrected (`user_override`), applies the SAME `correctTransaction()` path a manual correction would use (spec section 47) — `economic_transaction_type = 'transfer'`, `category_id`, `subcategory_id` — each individually audited in `fdh_transaction_corrections`.
3. Never overwrites an existing distinct human decision.

**Deliberately excluded**: `loan_payment` (spec section 50 — cannot safely split principal/interest without loan-schedule data) and `investment_funding` (spec section 99 — must not reach into Investment Intelligence's domain). Confirming those links still moves the link to `confirmed`; the transactions are left exactly as before, still reviewable via the existing correction API.

## No double-counting (spec sections 22, 128)

Once both sides carry `economic_transaction_type = 'transfer'`, any future reporting aggregation that sums `income`/`expense` by economic class naturally excludes both rows — an own-account transfer of $500 no longer contributes an "Expense 500" and an "Income 500" to two separate totals, because neither row is classified as either. FDH-6 does not touch any reporting/aggregation code itself (out of scope, per the spec's own Input Data boundary, section 98) — this is the classification-layer precondition that makes correct reporting possible later.

## Tenant boundary

`matchInternalTransfers()`'s caller (`transactionClassificationService.ts`) only ever supplies one user's own transactions (`.eq('user_id', userId)` at every read); `applyTransferClassOnConfirm()` only ever reads/writes through `transactionsRepository`/`transactionLinksRepository`, both RLS-scoped to the calling user. Cross-tenant pairing is structurally unreachable — proven live in `FDH6_SECURITY_CERTIFICATION.md`.

## Cross-currency (spec section 30)

Never automatically matched — the bucket key includes `currencyOriginal`, so AUD and INR amounts never collide even at an identical numeric value (certification case `[T-07]`).
