# FDH-8 — Review Integration Certification

**STATUS: CLOSED — 2026-08-25.** Closes the disclosed CONDITIONAL PASS gap: "no dedicated FDH-7 review/correction page exists anywhere in this codebase; every 'Review transactions'/'Review/Edit' link falls back to `/financial-data-hub` rather than a nonexistent dedicated route."

## Investigation first (per closure spec instruction — inspect before building)

Before writing any code, the actual FDH-7 implementation was inspected. Finding: FDH-7's backend was fully built (review-queue listing, per-transaction approve/correct/split/duplicate-resolution, per-link transfer/refund confirm-or-reject, per-recurring-series review, per-statement approve — all under `app/api/financial-data-hub/**`), but **FDH-7 had never shipped ANY frontend page at all** — not a thin one, not a full one. `app/(app)/financial-data-hub/page.tsx` is purely static marketing-style copy about the upload pipeline; no component anywhere in the codebase called any of the approve/correct/duplicate-resolution/link-review endpoints (grep-verified before writing a line of new UI). This was a materially bigger gap than the closure spec anticipated ("first inspect the actual FDH-7 implementation, do not assume a new review engine is required") — there was no existing review UI of any size to route into.

## What was built

`app/(app)/financial-data-hub/review/` — a thin UI wrapper around FDH-7's EXISTING, UNCHANGED service layer. Per the closure spec's own explicit permission: *"If a thin route/wrapper is required, create one around EXISTING FDH-7 services."*

**FDH-8 still implements ZERO approve/correct-classification/confirm-transfer/reject-transfer/confirm-duplicate/keep-both/split/approve-statement logic itself.** Every action button in the new review workspace calls one of FDH-7's pre-existing routes, unmodified:
- `POST /api/financial-data-hub/bank-transactions/{id}/approve`
- `POST /api/financial-data-hub/bank-transactions/{id}/correction`
- `POST /api/financial-data-hub/bank-transactions/{id}/duplicate-resolution`
- `POST /api/financial-data-hub/bank-transactions/{id}/split`
- `POST /api/financial-data-hub/transaction-links/{id}/review`
- `POST /api/financial-data-hub/documents/{id}/approve`

**Two new READ-ONLY routes** were added — `GET /api/financial-data-hub/transaction-links?transaction_id=` and `GET /api/financial-data-hub/duplicate-candidates?transaction_id=`, both required so the workspace can discover which link/candidate row applies to a focused transaction before calling the existing action endpoint. Neither adds a new mutation, a new table, or new approval semantics — both query the SAME `fdh_transaction_links`/`fdh_duplicate_candidates` tables the existing action routes already read and write, scoped by RLS (`auth.uid() = user_id`) plus the same explicit `.eq('user_id', ...)` defence-in-depth every other FDH route uses. Both REQUIRE `transaction_id` — deliberately not general "list all my X" endpoints.

## Authorization (browser params are never ownership proof)

Every id accepted from a URL/query param — `?transaction=`, `?statement=`, `?reason=`, `duplicate_candidate_id`, `link_id`, `recurringId` — is re-validated server-side by the existing (or, for the two new lookups, newly-added-but-identically-scoped) API routes via `requireUser()` + RLS + explicit `user_id` filtering. The workspace itself trusts nothing from the browser; a forged id simply returns 404/empty from the real endpoint, exactly as it always has.

## Certification (all live, via `scripts/fdh8_live_dev_certification.ts`)

| Requirement | Result |
|---|---|
| Overview → Review (general "Needs your review" section, and per-category `reason=` deep links: transfers/duplicates/uncategorised/recurring/needs_attention) | Links updated in `activity/page.tsx`; general queue PASS |
| Pending transaction → Review | Deep-link `?transaction=<id>` fetches the real transaction + its links/duplicates via the new lookups; approve/correct/confirm/duplicate actions all call the real endpoints — PASS (proven live via Cases 1, 2, 4, 5, 6) |
| Transaction Explorer → Review transaction | `transactions/page.tsx`'s "Review / Edit this transaction" link now deep-links `?transaction=<id>` instead of the generic fallback |
| Transfer item → appropriate review context | A focused transaction that has a pending `fdh_transaction_links` row (transfer/settlement/refund/reversal) shows Confirm/Reject buttons calling the real link-review endpoint — proven live in Case 3 (transfer) and Case 5 (refund) |
| No generic fallback when a more specific FDH-7 destination now exists | `REVIEW_QUEUE_HREF` in both `activity/page.tsx` and `activity/transactions/page.tsx` changed from `/financial-data-hub` to `/financial-data-hub/review` |

## Deliberate scope boundary (disclosed, not silently accepted)

The general review queue (`GET /review-queue`) only lists transactions with `review_status IN ('pending', 'in_review')` — by FDH-7's own original design ("a focused review queue, never full expense analytics"). There is still no dedicated LIST endpoint for pending transfer links or pending duplicate candidates independent of a specific transaction — the workspace reaches them only via a focused transaction's own `?transaction=<id>` deep link (which does correctly surface any link/duplicate context for THAT transaction). Building a general list-all-pending-links/duplicates browsing UI was judged to cross from "thin wrapper" into "a second review engine" and was deliberately not built — flagged here as an open residual, not hidden.

## Real defects found while building and certifying this integration

1. **`resolveDuplicateCandidate()` zero-counted resolved duplicates** (both sides marked excluded) — found via this workspace's own live Case 4 test, fixed, regression-tested. See `FDH8_LIVE_DEV_CERTIFICATION.md` Case 4.
2. **Split transactions can never be approved through the split action alone** — the DB-level blocking gate never accounts for reconciled allocations. Found via this workspace's own Case 6 test. NOT fixed (a DB function change requires a migration, an explicit STOP condition under this closure's standing constraints) — disclosed for Product Owner attention. See `FDH8_LIVE_DEV_CERTIFICATION.md` Case 6.
3. **Silent DB-write-error swallowing** in `resolveDuplicateCandidate()` and `correctTransaction()` — both ignored the `{error}` half of their Supabase update calls, meaning a rejected write (e.g. a DB trigger's own guard firing) could previously report HTTP 200 success while leaving the row unchanged. Fixed alongside finding #1.
