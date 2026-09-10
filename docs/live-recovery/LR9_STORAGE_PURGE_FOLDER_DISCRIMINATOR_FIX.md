# LR-9 CRITICAL FINDING: storage purge never actually deleted nested-bucket files (2026-09-10)

## Severity

**P0/P1 — real, previously-uncaught privacy defect.** Every account deletion executed against this codebase (prior to this fix) silently left the deleted user's FDH source documents (`fdh-source-documents` bucket) and report-export PDFs (`report-exports` bucket) orphaned in Storage, with no error surfaced anywhere — the deletion was reported as fully successful ("storage purge reported zero errors") while genuinely deleting zero files in either bucket. Only `investment-source-documents` (the one flat-shaped bucket) was ever actually purged correctly.

This is exactly the failure mode the PO's LR-12R review flagged as the reason to require a real, live-DEV, end-to-end deletion proof rather than trusting mocked unit tests — and it is exactly what that live test caught.

## How it was found

Building the real live-DEV end-to-end test the PO required (`scripts/lr9_account_deletion_live_dev_e2e.mjs`): create a disposable User B with real financial data and a real Storage object, submit a real closure request, execute it as a real Admin, then verify — via the real Supabase Storage API, not a mock — that the file was actually gone. It wasn't. The execute response's own `storageResults` reported `{ bucket: 'fdh-source-documents', objectsFound: 0, objectsDeleted: 0, error: null }` even though a real, correctly-shaped file existed under that exact user's prefix, and a follow-up `list()` call confirmed the file was still there after "successful" deletion.

## Root cause

`lib/services/accountDeletionStorage.ts`'s `purgeNestedUserPrefix()` (used for both `fdh-source-documents` and `report-exports`) lists a user's top-level prefix, expecting each entry to be a `documentId`/`reportId` folder it must recurse into to find the real file(s) inside. The discriminator for "is this entry a folder to recurse into, or a real object" was **backwards**:

```ts
// BEFORE (wrong):
for (const folder of folders ?? []) {
  if (!folder.id) continue;   // skips every entry with NO id
  const { data: inner } = await admin.storage.from(bucket).list(`${userId}/${folder.name}`, ...);
  ...
}
```

Empirically confirmed against a real Supabase Storage bucket (`node` script, direct `supabase-js` calls, see the commit's own verification output): a `.list()` entry representing a **folder placeholder** comes back with `id: null`; an entry representing a **real, deletable object** comes back with a real UUID `id`. The code above has this exactly backwards — `if (!folder.id) continue` skips every entry that has no id, which is precisely the real folder placeholder, so the function **never recursed into a single real folder**. It only "recursed" into entries that already had an id (i.e., entries that were already real files, not folders) — calling `list()` on a real file's own name as if it were a directory path, which correctly returns nothing. Net effect: `purgeNestedUserPrefix()` always found and deleted zero objects, for every user, in both buckets, regardless of what actually existed.

## Why the existing unit tests didn't catch this

`tests/unit/accountDeletionStorage.test.ts`'s own mock fixtures had the identical assumption backwards: its comment claimed *"Per-document 'folder' listing entries carry a truthy `id` in this bucket shape"* and built its fake folder entries with a truthy `id` (e.g. `{ id: 'folder-marker-1', name: 'report-1' }`). Against that (wrong) mock, the buggy code's `if (!folder.id) continue` correctly did NOT skip the folder (since the mock gave it a truthy id) — so the test passed while testing the *opposite* of what a real Supabase Storage bucket actually returns. The code and its own test were both wrong in the same direction, so nothing ever caught the mismatch. Only a real API call against a real bucket — which mocked unit tests by definition never do — could have caught it, and did.

## Second occurrence found and fixed proactively

`lib/services/accountDeletionStorage.ts`'s own header comment stated it deliberately keeps an "independent copy" of the discriminator logic used by `lib/financial-data-hub/services/storage.ts`'s `listObjectsUnderUserPrefix()` (FDH-3's own orphan-detection reference, described in that codebase as "already-certified"). Checking that function found the **identical bug**, copied in the same direction — `if (!docFolder.id) continue`. This function currently has **zero callers anywhere in the codebase** (its intended consumer, `scripts/fdh3_orphan_storage_report.mjs`, was never built), so it caused no live harm — but it was fixed anyway, since it is literally the function whose discriminator logic got copied (bug included) into the code that DID cause harm, and leaving it broken would risk a third copy-paste of the same mistake in the future.

## What changed

- **`lib/services/accountDeletionStorage.ts`** — `purgeNestedUserPrefix()`'s discriminator corrected: an entry with `id: null` is the real folder to recurse into; an entry with a real `id` is treated as an unexpected flat file and deleted directly (defensive-only — no known writer produces this shape, but it's safer than silently skipping it). Full before/after reasoning documented inline.
- **`lib/financial-data-hub/services/storage.ts`** — `listObjectsUnderUserPrefix()` given the identical fix, plus its inner `list()` call's suspiciously low `limit: 10` raised to `limit: 1000` to match the outer call and every other listing in this codebase (a minor, low-risk consistency fix alongside the main one, not scope creep — this function currently has no real per-folder file count that would ever approach either limit).
- **`tests/unit/accountDeletionStorage.test.ts`** — every mock fixture rewritten to use the empirically-correct `id: null` = folder, real `id` = object convention. Added a dedicated regression test ("the exact bug this test suite originally missed") that fails against the old code and passes against the fix, plus a defensive-case test for an unexpected flat top-level file.
- **`tests/unit/fdh3ListObjectsUnderUserPrefix.test.ts`** (new) — `listObjectsUnderUserPrefix()` had zero dedicated test coverage before this fix; 5 new tests lock in the corrected behavior.
- **`scripts/lr9_account_deletion_live_dev_e2e.mjs`** (new) — the real, live-DEV, end-to-end test the PO required. Two disposable users (Admin A with a temporary `can_manage_account_deletions` grant, revoked at the end; User B, the deletion subject), real financial rows, a real correctly-shaped Storage object, and every step driven through the actual Next.js API routes over real HTTP with real Supabase session cookies (mirroring `scripts/fdh4_anz_adapter_live_closure_check.ts`'s established pattern). 13/13 checks pass against the fixed code: request creation, non-admin execute-attempt correctly refused (403), Admin A's real execution, the tombstone (`user_id` set null, `status='completed'`, `processed_by` correctly recorded), zero storage-purge errors, the auth identity genuinely gone, both seeded financial rows cascade-deleted, **the seeded Storage object genuinely gone** (the fix's own proof), and User B genuinely unable to sign in again afterward.

## Verification

- 19/19 unit tests pass across the four touched/new test files (`accountDeletionStorage.test.ts`: 5, `fdh3ListObjectsUnderUserPrefix.test.ts`: 5, `accountDeletionOrchestration.test.ts`: 7, `accountDeletionAdminRoutes.test.ts`: 5 — the latter two unaffected by this change, re-run to confirm no regression from the same session's earlier LR-9 invariant fix).
- `tsc --noEmit` and `eslint` clean on every touched file.
- `scripts/lr9_account_deletion_live_dev_e2e.mjs` run twice against real DEV: once against the pre-fix code (proved the bug — `objectsFound: 0` for a real, correctly-shaped file, confirmed still present after "successful" deletion), once against the fix (13/13 PASS, file genuinely deleted).
- Zero residue: the script's own cleanup removed the temporary Admin A grant and identity; User B and the seeded Storage object were removed by the deletion itself and independently re-verified gone.

## Relationship to the other LR-9 fix this session

This is a separate, independently-discovered defect from [[LR9_STORAGE_DELETION_INVARIANT_FIX]] (the "storage-purge failure should abort deletion" fix, same day, earlier in this session). That fix changes what happens when `purgeAllUserStorage()` reports an **error**. This fix changes whether `purgeAllUserStorage()` ever correctly finds anything to delete in the first place, for two of its three buckets. Both were real, and both are now fixed — together they mean: (1) if a bucket genuinely can't be purged, deletion aborts and the account stays intact and retryable; (2) when a bucket *can* be purged, it now actually is.

## What this closes for LR-12R

Both of the two "genuine end-to-end proof of the deletion cascade" and "storage/deletion consistency" items the PO named for LR-9 are now closed with real, positive, live-DEV evidence — not reasoning from code inspection alone. This is also the strongest argument yet, in this whole programme, for the PO's own standing insistence that a mocked unit test is not equivalent to a real live-DEV run: this exact defect was invisible to `npm test` for as long as it existed, and was only found the moment a real API call replaced a mock.
