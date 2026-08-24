# FDH-7 — Security Model

## Server-derived ownership (spec 79)

Every FDH-7 write goes through the ordinary RLS-scoped session client (`createClient()` from `@/lib/supabase/server`) — never the service-role client, never a browser-supplied `user_id`. `approveTransaction`/`approveStatement`/`splitTransaction`/`reopenStatement` all take `userId` from `requireUser()` (server-side session), matching every prior FDH phase's own established discipline.

## RLS (spec 81)

`fdh_approved_financial_summaries` (the one new table): RLS enabled, `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)` — the identical house pattern used by every other FDH user-owned table. Verified live against real populated two-tenant data with a genuine negative control (`scripts/fdh7_certification.mjs` section 5): Tenant B cannot read Tenant A's row; disabling RLS makes the leak appear (proving the positive test was not vacuous); re-enabling restores isolation.

## DB-level transition/blocking guards (spec 109-110, 123)

Three new trigger functions (migration 0076) — see `FDH7_REVIEW_STATE_MACHINE.md` for the full transition tables:
- `fdh7_guard_transaction_approval()` — blocks a forged approval regardless of what the client claims.
- `fdh7_guard_statement_approval()` — same, at statement level.
- `fdh7_guard_document_processing_status()` — closes the pre-existing gap where `processing_status` had NO database-level enforcement at all (Critical Finding 2, `FDH7_REUSE_AND_GAP_AUDIT.md`).

All three are proven non-vacuous by dropping and recreating them mid-script and observing the blocked case flip to allowed and back.

## Forged action tests (spec 78, 122, live-DB-tested)

| Attack | Result |
|---|---|
| Tenant B updates Tenant A's transaction (`approval_status`) | 0 rows affected (RLS) |
| Tenant B sets `approved_by` on Tenant A's statement | 0 rows affected (RLS) |
| Tenant B reads Tenant A's approved summary | 0 rows (RLS) |
| Tenant B inserts a split allocation it owns, naming Tenant A's `transaction_id` | **Succeeds** — see FDH1-F1 below |
| Direct statement approval with reconciliation `status='failed'` | Rejected by DB trigger |
| Direct `processing_status` jump skipping the pipeline | Rejected by DB trigger |

## FDH1-F1 (pre-existing, disclosed, reconfirmed — not a new FDH-7 regression)

`fdh_transaction_allocations.transaction_id` is a plain foreign key with no owner-match constraint (the same class of gap disclosed since FDH-1). RLS's `with check (auth.uid() = user_id)` only constrains the ROW's OWN `user_id`, not the tenant identity of whatever `transaction_id` it names — Tenant B can insert an allocation row it legitimately owns that points at Tenant A's transaction id. **Why this is not exploitable in practice**: (1) `splitTransaction()` (the only application code that writes this table) ALWAYS calls `transactionsRepository.getForUser(userId, transactionId)` first and 404s if the transaction is not the caller's own — RLS is not the only line of defence here, application-level ownership re-verification is; (2) even a successfully-inserted orphan allocation is invisible in a JOIN back to the real transaction owner's own RLS-scoped reads (B can never actually SEE that the allocation "means" anything about A's transaction); (3) it can never enter A's Approved Financial Summary, because `approveStatement()` only ever fetches allocations scoped by `.eq('user_id', userId)` for the household approving — B's orphan row is invisible to A's own summary computation. Reconfirmed live in `scripts/fdh7_certification.mjs` section 5b.

## No new admin surface (spec 76)

Zero new files under any admin route touch `fdh_transactions`/`fdh_statement_uploads` financial content — grep-verified.

## Compiled client bundle (spec 82, 136)

`SUPABASE_SERVICE_ROLE_KEY` — 0 matches expected in `.next/static` after production build (see `FDH7_COMPLETION_REPORT.md` section 14 for the actual scan result). No FDH-7 file imports `createAdminClient()` — every new service uses `createClient()` (session-scoped) exclusively, confirmed by grep.
