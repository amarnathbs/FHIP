# FDH-6 — Security Certification

## New write-surface introduced by FDH-6: none

FDH-6 introduces **zero new database tables, zero new columns, zero new RLS policies, zero new triggers, zero new API routes**. The only runtime write behaviour FDH-6 adds (`applyTransferClassOnConfirm()`) is a new CALLER of the EXISTING, already-security-certified `correctTransaction()` path (R7) — every write it performs is subject to the exact same RLS policies and migration-`0068` authoritative-field triggers R8's own security certification already exercised. There is no new attack surface to independently certify from scratch; the correct action is to REPRODUCE the existing R7/R8 security certifications against the FDH-6 tree and add targeted tests for the one new code path.

## Reproduced (not re-invented): R8 security certification

`node scripts/r8_security_certification.mjs` re-run against this branch — see the regression numbers in `FDH6_COMPLETION_REPORT.md` section 16. Unchanged pass/fail behaviour proves FDH-6's edits did not weaken any existing R8 guarantee.

## FDH-6-specific tenant-isolation reasoning

`applyTransferClassOnConfirm(userId, link)`:
- `link` was already fetched via `transactionLinksRepository.getForUser(userId, linkId)` — RLS-scoped; a forged `linkId` belonging to another tenant returns no row, `ClassificationReviewError('not_found')` is thrown before this function is ever reached.
- Inside the function, `transactionsRepository.getForUser(userId, transactionId)` is RLS-scoped again — even a `transaction_id_from`/`transaction_id_to` value somehow forged into a link row (structurally impossible: `fdh_transaction_links` write access is engine-only, see migration `0068` section 4) would still fail this lookup for a foreign tenant's transaction.
- `correctTransaction()` itself is RLS-scoped end to end (spec section 47, R7).

No service-role client is used anywhere in this call chain — `applyTransferClassOnConfirm` and `explainTransactionReviewReasons` both stay on the ordinary session client throughout, matching `classificationReviewService.ts`'s own file-level discipline ("Every write here goes through the ordinary RLS-scoped repositories — NEVER the service-role client").

## Live-DEV tenant attack (spec sections 86, 111)

Exercised directly in `scripts/fdh6_live_dev_certification.mjs` — see `FDH6_LIVE_DEV_CERTIFICATION.md` for the real, reproduced results: Tenant B attempting to read Tenant A's classification, review reasons, pair Tenant A's transfer, or read Tenant A's personal rules, all blocked.

## Service-role / browser bundle (spec section 89)

FDH-6 adds no new service-role-touching file. `tests/unit/fdh1Isolation.test.ts`'s existing sanctioned-service-role-file list is unchanged by this phase. Compiled-bundle scan (`.next/static`) re-run as part of the full regression — see the completion report.

## Admin visibility (spec sections 91-92)

FDH-6 adds no admin route. `explainTransactionReviewReasons()` is user-facing only, RLS-scoped, and returns only the calling user's own reason codes — never another user's transaction content.
