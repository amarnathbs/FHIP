/**
 * AIE-1.1 — encrypted, tenant-scoped quarantine object storage.
 *
 * Follows the exact three-part discipline discovery found common to every
 * existing document bucket in this codebase (`fdh-source-documents`,
 * `investment-source-documents`, `report-exports`): a private bucket, a
 * SELECT-only RLS policy for the authenticated role keyed on
 * `(storage.foldername(name))[1] = auth.uid()::text`, and exactly one
 * service-role-only module performing every write. THIS is that module for
 * AIE-1.1 — no other file in `lib/aie/**` may import
 * `@/lib/supabase/admin` for storage operations.
 *
 * Bucket creation itself is a Storage Admin API call, not SQL (same
 * precedent as FDH-3/II/report-exports) — see
 * `scripts/aie1_1_create_storage_bucket.mjs`, which is written but NOT run
 * in this pass (no production/DEV authority granted).
 */

import { createAdminClient } from '@/lib/supabase/admin';

export const AIE_QUARANTINE_BUCKET = 'aie-document-quarantine';

export function buildQuarantineStorageKey(userId: string, intakeId: string): string {
  return `${userId}/${intakeId}/${intakeId}.bin`;
}

export async function uploadToQuarantine(params: { storageKey: string; bytes: Uint8Array; contentType: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(AIE_QUARANTINE_BUCKET).upload(params.storageKey, params.bytes, {
    contentType: params.contentType,
    upsert: false,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function downloadFromQuarantine(storageKey: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(AIE_QUARANTINE_BUCKET).download(storageKey);
  if (error || !data) return { ok: false, message: error?.message ?? 'could not download document' };
  const arrayBuffer = await data.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(arrayBuffer) };
}

export async function deleteFromQuarantine(storageKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(AIE_QUARANTINE_BUCKET).remove([storageKey]);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/**
 * AIE-1 closure mission (section 9) — independent existence check, mirroring
 * `lib/financial-data-hub/services/storage.ts#verifyDocumentObjectExists`'s
 * own technique exactly (list the parent "directory" and search for the
 * exact object name — Supabase Storage's `.list()` is the only reliable way
 * to distinguish "genuinely absent" from a transient error, since `.remove()`
 * itself can report success without the object having actually existed).
 * `runPurgeAttempt` (`lib/aie/services/purge.ts`) never marks a row `purged`
 * on the strength of a successful `deleteFromQuarantine` call alone — it
 * calls this function next and only proceeds once it returns `true`.
 */
export async function verifyQuarantineObjectAbsent(storageKey: string): Promise<boolean> {
  const admin = createAdminClient();
  const lastSlash = storageKey.lastIndexOf('/');
  const dir = storageKey.slice(0, lastSlash);
  const name = storageKey.slice(lastSlash + 1);
  const { data, error } = await admin.storage.from(AIE_QUARANTINE_BUCKET).list(dir, { search: name, limit: 1 });
  if (error) return false; // cannot confirm absence -> treat as still present (fail closed)
  const stillPresent = (data ?? []).some((f) => f.name === name);
  return !stillPresent;
}
