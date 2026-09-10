// LR-9 WP-09/NEG-06/NEG-07 — purges every Storage object under a user's
// prefix across all three buckets that can hold user-owned files, BEFORE
// auth.admin.deleteUser() runs.
//
// WHY STORAGE MUST BE PURGED FIRST, NOT AFTER (NEG-06 "auth deleted before
// cleanup loses ownership path"): every bucket in this codebase keys its
// objects by a `${userId}/...` prefix (lib/financial-data-hub/domain/
// uploadSession.ts's buildOpaqueStorageKey(), lib/services/investment-
// intelligence/storage.ts's generateObjectKey(), and app/api/reports/[id]/
// exports/route.ts's storagePath — all confirmed userId-prefixed by
// LR-9 discovery). That means purging never needs a live database join to
// find "this user's objects" — the userId string alone is enough — so
// there is no ordering requirement FORCING storage purge before auth
// deletion on correctness grounds alone. It is still done first here as
// the safer default: if purge fails partway, the account (and its
// financial rows) still exist and the failure is visible/retryable,
// rather than an orphaned Storage object surviving an already-deleted,
// unrecoverable account with no owner left to attribute it to.
import { createAdminClient } from '@/lib/supabase/admin';

// FDH_SOURCE_DOCUMENTS_BUCKET's literal value, kept as an independent copy
// rather than importing it from lib/financial-data-hub/services/storage.ts —
// the Financial Data Hub's own isolation test (tests/unit/fdh1Isolation.test.ts)
// enforces that nothing outside the Hub imports it (except the one approved
// FDH-3 upload surface), the same discipline lib/import-bridge/adapters/
// incomeAdapter.ts already follows for the identical reason (see that
// file's own header: "deliberately does NOT import the Hub's own matching
// module and keeps its own isolation-safe copy"). This module needs only
// the bucket NAME, a plain string, not any Hub behaviour.
const FDH_SOURCE_DOCUMENTS_BUCKET = 'fdh-source-documents';
const INVESTMENT_INTELLIGENCE_BUCKET = 'investment-source-documents';
const REPORT_EXPORTS_BUCKET = 'report-exports';

export interface StoragePurgeResult {
  bucket: string;
  objectsFound: number;
  objectsDeleted: number;
  error: string | null;
}

/** investment-source-documents: flat `${userId}/${uuid}.ext` — one list() call is enough. */
async function purgeFlatUserPrefix(bucket: string, userId: string): Promise<StoragePurgeResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(bucket).list(userId, { limit: 1000 });
  if (error) return { bucket, objectsFound: 0, objectsDeleted: 0, error: error.message };
  const keys = (data ?? []).filter((o) => o.id).map((o) => `${userId}/${o.name}`);
  if (keys.length === 0) return { bucket, objectsFound: 0, objectsDeleted: 0, error: null };
  const { error: removeError } = await admin.storage.from(bucket).remove(keys);
  if (removeError) return { bucket, objectsFound: keys.length, objectsDeleted: 0, error: removeError.message };
  return { bucket, objectsFound: keys.length, objectsDeleted: keys.length, error: null };
}

/**
 * report-exports: `${userId}/${reportId}/${exportId}.pdf` — same two-level
 * shape as FDH's own bucket.
 *
 * CORRECTED DISCRIMINATOR (2026-09-10, real live-DEV finding — see
 * docs/live-recovery/LR9_STORAGE_PURGE_FOLDER_DISCRIMINATOR_FIX.md for the
 * full record). Empirically confirmed against a real Supabase Storage
 * bucket: a `.list()` entry representing a FOLDER placeholder (e.g. a
 * `documentId` directory with real files inside it) comes back with
 * `id: null`; an entry representing an actual, real, deletable OBJECT comes
 * back with a real UUID `id`. The previous version of this function had
 * this backwards — `if (!folder.id) continue` skipped every real folder
 * without ever recursing into it, so `purgeNestedUserPrefix()` NEVER found
 * or deleted a single object in `report-exports` or `fdh-source-documents`
 * in practice: it always returned `objectsFound: 0` regardless of what
 * actually existed. Every account deletion before this fix silently left
 * every FDH source document and every report-export PDF orphaned in
 * Storage. The unit test that was supposed to catch this
 * (tests/unit/accountDeletionStorage.test.ts) had the identical backwards
 * assumption baked into its own mock, so it passed while testing the wrong
 * behaviour — this is why a live-DEV run against the real API, not another
 * mocked test, is what actually caught it.
 */
async function purgeNestedUserPrefix(bucket: string, userId: string): Promise<StoragePurgeResult> {
  const admin = createAdminClient();
  const { data: entries, error } = await admin.storage.from(bucket).list(userId, { limit: 1000 });
  if (error) return { bucket, objectsFound: 0, objectsDeleted: 0, error: error.message };
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    if (entry.id) {
      // Defensive only: every known writer to these two buckets
      // (buildOpaqueStorageKey() / report_exports' own storagePath) always
      // nests two levels deep, so a real object should never appear flat at
      // this top level in practice. If one somehow did, delete it directly
      // rather than silently skipping it.
      keys.push(`${userId}/${entry.name}`);
      continue;
    }
    // entry.id === null: this IS the real folder placeholder -- recurse
    // into it to find the actual files inside.
    const { data: inner } = await admin.storage.from(bucket).list(`${userId}/${entry.name}`, { limit: 1000 });
    for (const obj of inner ?? []) {
      if (obj.id) keys.push(`${userId}/${entry.name}/${obj.name}`);
    }
  }
  if (keys.length === 0) return { bucket, objectsFound: 0, objectsDeleted: 0, error: null };
  const { error: removeError } = await admin.storage.from(bucket).remove(keys);
  if (removeError) return { bucket, objectsFound: keys.length, objectsDeleted: 0, error: removeError.message };
  return { bucket, objectsFound: keys.length, objectsDeleted: keys.length, error: null };
}

/**
 * Purges every object under this user's prefix in all three known
 * user-file-holding buckets. Best-effort per bucket — one bucket's failure
 * does not stop an attempt on the others, so a caller gets the fullest
 * possible picture of what succeeded/failed rather than an all-or-nothing
 * abort; the caller (accountDeletionOrchestration.ts) decides whether any
 * failure here should block the rest of the deletion.
 */
export async function purgeAllUserStorage(userId: string): Promise<StoragePurgeResult[]> {
  return Promise.all([
    // fdh-source-documents has the identical `${userId}/${documentId}/${documentId}.bin`
    // two-level shape as report-exports — same purge routine, independent
    // bucket-name copy per the header comment above.
    purgeNestedUserPrefix(FDH_SOURCE_DOCUMENTS_BUCKET, userId),
    purgeFlatUserPrefix(INVESTMENT_INTELLIGENCE_BUCKET, userId),
    purgeNestedUserPrefix(REPORT_EXPORTS_BUCKET, userId),
  ]);
}
