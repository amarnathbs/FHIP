# LR-9 correction: storage-purge failure now aborts account deletion (2026-09-10)

## What was found

Reviewing the LR2→12 compilation, the PO flagged a genuine inconsistency between two claims already in this repo:

- `docs/live-recovery/LR9_PHASE_REPORT.md` §5.7 and `lib/services/accountDeletionStorage.ts`'s own header comment both described storage-first purge ordering as a safety net: *"a partial failure there leaves the account and its financial rows intact and the failure visible/retryable, rather than an orphaned Storage object surviving an already-gone, unrecoverable account."*
- The actual `executeAccountDeletion()` code, and the test that pinned its behavior down (`accountDeletionOrchestration.test.ts`'s original NEG-05: *"a storage-purge failure does not block auth.admin.deleteUser (the account still gets deleted; the failure is reported, not hidden)"*), did the opposite: a storage-purge error was recorded but never inspected before calling `deleteUser()`. The identity was deleted regardless, and the request was finalized `'completed'`.

The phase report's own §5.6/§10 language ("disclosed tradeoff") shows this was a deliberate original design choice, not an oversight — the reasoning was that an orphaned Storage object is a smaller, independently-discoverable problem (the same class FDH-3's orphan-report tooling already handles) than leaving a user's financial rows undeleted over one failed bucket call.

## PO decision (2026-09-10)

That original tradeoff is **rejected, not merely re-worded**. The PO's stated invariant:

> If user-owned Storage cannot be fully purged and verified, do NOT permanently delete the auth identity yet. Mark deletion failed/retryable instead.

Reasoning: an orphaned file with no owner left to attribute it to is *invisible and undiscoverable* once the account itself is gone — worse than the original framing assumed. An intact, undeleted account is visible (the request row stays queryable) and safely retryable. This makes LR-9 storage-purge safety strictly more conservative than before.

## What changed

- **`lib/services/accountDeletionOrchestration.ts`** — `executeAccountDeletion()` now checks every `StoragePurgeResult` for an `error` BEFORE calling `auth.admin.deleteUser()`. If any bucket failed to purge, the function returns immediately with `success: false`, a new `abortedForStorageFailure: true` flag, and an `authDeleteError` message naming the failed bucket(s) — `deleteUser()` is never called. The function's header comment is rewritten to state the corrected invariant explicitly and point back to this document, so a future change can't silently re-loosen it without an equally explicit PO decision.
- **`app/api/admin/account-deletions/[id]/execute/route.ts`** — **no change needed.** It already keys the request row's `status`/`failure_reason` off `result.success`/`result.authDeleteError`, so a storage-purge-aborted attempt is automatically recorded as `status: 'failed'` with a clear, actionable reason — exactly the "failed/retryable" outcome the PO asked for, using the existing state machine.
- **`tests/unit/accountDeletionOrchestration.test.ts`** — NEG-05 rewritten to assert the corrected behavior (`deleteUser` NOT called, `success: false`, `abortedForStorageFailure: true`); added NEG-05b (one failing bucket among several still aborts); the "auth.admin.deleteUser itself fails" test now explicitly asserts `abortedForStorageFailure: false` and all-clean storage results, to keep the two failure modes distinguishable. Also fixed a real, pre-existing test-isolation gap this change exposed: the file had no `beforeEach(() => vi.clearAllMocks())`, so `deleteUserMock`'s call history leaked across tests — the original NEG-05's `.toHaveBeenCalled()` assertion happened to pass regardless of test order, which is exactly the kind of false-positive-shaped gap that let the original design go unexamined for this long. All 7 tests pass; `tsc --noEmit` and `eslint` both clean on every touched file.

## What is intentionally NOT built as part of this fix

No new "retry" admin route or UI was added. `account_deletion_requests` has no self-service retry action today (only `pending`→claim-and-execute exists) — a `'failed'` row is already visible via the admin queue's existing `failed` status filter (`app/api/admin/account-deletions/route.ts`) for manual investigation, matching the PO's own "visible/retryable" framing without inventing new scope. A dedicated reset-to-pending admin action would be a natural, separately-scoped follow-up if a real failed-and-needs-retry case arises in practice — not built preemptively here.

## Cross-reference

This closes one of the two items the PO's LR-12R review named for LR-9 (the storage/deletion consistency check). The other — a real, live-DEV synthetic end-to-end account-deletion execution (request → admin queue → execute → verified zero residue) — remains open and is scheduled after LR-10 (Payments) in the locked LR-12R closure sequence.
