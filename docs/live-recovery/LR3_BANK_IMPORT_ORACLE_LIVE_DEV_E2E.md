# LR-3 closure: real end-to-end bank-import oracle (2026-09-10)

## What this closes

LR-3's own phase report (`LR3_PHASE_REPORT.md` §9/§10) disclosed the one thing it never exercised: *"the full upload → FDH-parse → review → approve → dashboard-counts journey with a real bank statement file."* Everything up to that point was either pre-existing certified FDH infrastructure or typed-correct-but-unexercised new code. The PO's review named this the one real remaining gap for LR-3 and specified the exact oracle to prove it.

## Method

`scripts/lr3_bank_import_oracle_live_dev_e2e.mjs` — one disposable authenticated user, driven entirely through the real Next.js API routes over real HTTP with a real Supabase session cookie (mirroring `scripts/fdh4_anz_adapter_live_closure_check.ts`'s established pattern), verified against the real `GET /api/dashboard/summary` route (not a re-derivation of `dashboardData.ts`'s own logic). 26/26 checks pass.

### Part A — the PO's own exact oracle, in isolation

- Seeded: a manual `$500` expense (baseline, not superseded) + a manual `$200` expense marked `superseded_by_bank_import: true` (the same real-world groceries cost now tracked via bank import instead).
- Uploaded a real ANZ-format CSV (`Coles Supermarket, $200 debit`, dated in the current calendar month — `dashboardData.ts` only counts the current month) through `upload → detect → process → categorise → approve`.
- **Result: `totalMonthlyExpenses = $700`, confirmed NOT `$900` (would mean the manual row wasn't excluded — double-counted) and NOT `$500` (would mean the bank import was silently ignored).** `bankMonthlyExpenses = $200`, exactly the imported row.
- **Reload**: fetched `/api/dashboard/summary` a second time — identical `$700`, proving the result is stable, not a one-time fluke of the first computation.

### Part B — refund / debt_principal / transfer, layered on top of Part A's state

- A second CSV added a refund (`Purchase Refund Ref9981`, +$50 credit), a loan-principal repayment (`Home Loan Principal Repayment`, -$300 debit), and a credit-card payment (`Credit Card Payment Ref4412`, -$150 debit).
- Auto-classification correctly assigned `refund` and `debt_principal` from the seeded narrative rules. The credit-card row needed a manual correction to `transfer` (confirmed: transfer has no auto-classify rule by design, matching earlier discovery — it's reached either via a confirmed transaction-link or manual correction).
- **A genuine, useful friction point found and resolved, not a defect**: both the refund and the transfer-corrected row had a `fdh_transaction_links` row auto-proposed against them (`reversal_original` and `credit_card_settlement` respectively) — the classification engine's own narrative-match step proposes a *pending* counter-transaction link for exactly this shape of description, independently of what `economic_transaction_type` ends up being set to. A pending link blocks approval by design (`fdh7_transaction_has_blocking_issue`'s own documented rule — approval-blocking, in migration `0076`), correctly preventing a refund/transfer from being approved until a human confirms or rejects the proposed match. Since neither synthetic row had a real counter-transaction to match, the correct action (exactly what a real user would do) is to **reject** the proposed link via `POST /transaction-links/{linkId}/review`. This is real, correct, working approval-review machinery — not a bug — and now documented as a required step in the real journey, which LR-3's own report never got far enough to discover.
- **Result: `totalMonthlyExpenses = $650`** (`$700` − `$50` refund netted, debt_principal and transfer both excluded entirely — confirmed NOT `$1150`, which would mean debt_principal/transfer were wrongly counted as ordinary expenses). `bankMonthlyExpenses = $150` (`$200` groceries − `$50` refund), matching `dashboardData.ts`'s own documented refund-netting formula exactly.

### Part C — duplicate/overlapping transaction

- Re-uploaded the byte-identical Part A CSV as a third, separate statement (same account). The process step correctly reported `duplicates_skipped: 1` — the cross-statement fingerprint collision (deliberately excluding `statement_upload_id`, per `lib/financial-data-hub/bank-csv/fingerprint.ts`) worked as designed.
- **Result: `totalMonthlyExpenses` unchanged at `$650`** — the duplicate groceries row was never double-counted, confirmed by re-fetching the dashboard after the re-upload.

## A minor, disclosed test-hygiene gap (not a product defect)

The script's original cleanup called `auth.admin.deleteUser()` directly rather than going through LR-9's own deletion orchestration — since `deleteUser()`'s DB cascade does not touch Storage (this is exactly LR-9's own finding, see `LR9_STORAGE_PURGE_FOLDER_DISCRIMINATOR_FIX.md`), the first two runs of this script left their uploaded CSV test files orphaned in the `fdh-source-documents` bucket. Fixed in the script itself (now purges the user's Storage prefix before deleting the identity) for every future run. The already-orphaned files from the first two runs could not be identified and removed after the fact — the bucket already has 124 pre-existing top-level user folders from this session's many months of prior test activity, with no timestamp on the folder-placeholder listing entries to distinguish "just created" from "created long ago," and the deleted user's own ID was not retained once the run completed. This is synthetic CSV test content only (no real user data), in the DEV project only (never production), and is the same class of disclosed, non-blocking residue already recorded for LR-2/LR-3's earlier passes — not a new gap this closure introduces, and the fixed script prevents it from recurring.

## Verification

Script run 3 times against real DEV: run 1 found the pending-link friction point (correctly identified, not worked around incorrectly); run 2, with link-rejection added, achieved 26/26 PASS; run 3 (after the Storage-cleanup fix) reproduced 26/26 PASS again with confirmed clean self-cleanup (`purged 3 Storage object(s)`).

## What this means for LR-3's verdict

The one disclosed gap in LR-3's original CONDITIONAL PASS — a real, exercised upload→parse→review→approve→dashboard journey — is now closed with genuine, live, positive evidence across the full oracle the PO specified (baseline/import/exclusion arithmetic, refund netting, debt_principal/transfer exclusion, duplicate-detection non-double-counting, and reload stability). LR-3 is ready to be marked closed in the eventual LR-12R matrix.
