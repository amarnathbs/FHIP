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
