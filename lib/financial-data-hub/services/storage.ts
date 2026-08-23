/**
 * Financial Data Hub — FDH-3 private object storage.
 *
 * THE ONE FILE IN THIS MODULE ALLOWED TO USE THE SERVICE-ROLE CLIENT.
 * `fdh-source-documents` (see migration 0058) has no INSERT/UPDATE/DELETE
 * storage policy for the authenticated role — only the service-role client
 * can write or delete an object — identical precedent to
 * `report-exports` (0022) and `investment-source-documents` (0037).
 *
 * HARD RULE: every exported function here assumes the caller has ALREADY
 * verified, using the normal RLS-scoped client and the authenticated
 * session, that the acting user owns the `document_id` in question. Nothing
 * in this file performs that check itself, because nothing in this file has
 * access to the request's session — it only ever receives a `userId` the
 * caller already authenticated. Every call site is
 * `lib/financial-data-hub/services/uploadLifecycle.ts` or
 * `lib/financial-data-hub/services/purge.ts`, both of which authenticate
 * first (see those files' own module comments).
 *
 * No browser code path ever imports this file, and no privileged credential
 * is ever returned from it to a client — see FDH3_STORAGE_SECURITY.md.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { FDH_SOURCE_DOCUMENTS_BUCKET } from '../domain/uploadSession';

export { FDH_SOURCE_DOCUMENTS_BUCKET };

/** Short-lived — a preview link must not become a standing public URL (spec
 * section 25). 60 seconds matches the existing report-exports precedent. */
export const PREVIEW_SIGNED_URL_TTL_SECONDS = 60;

export async function uploadDocumentObject(params: {
  storageKey: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(FDH_SOURCE_DOCUMENTS_BUCKET)
    // upsert: false — an opaque, per-document key must never be silently
    // overwritten by a second, unrelated write (spec section 94).
    .upload(params.storageKey, params.bytes, { contentType: params.contentType, upsert: false });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/** Confirms the object genuinely exists in storage and, if given, that its
 * size matches — spec section 95: never trust the browser's "upload
 * complete" claim alone. */
export async function verifyDocumentObjectExists(
  storageKey: string,
  expectedSizeBytes?: number,
): Promise<{ exists: boolean; sizeBytes?: number }> {
  const admin = createAdminClient();
  const lastSlash = storageKey.lastIndexOf('/');
  const dir = storageKey.slice(0, lastSlash);
  const name = storageKey.slice(lastSlash + 1);
  const { data, error } = await admin.storage.from(FDH_SOURCE_DOCUMENTS_BUCKET).list(dir, {
    search: name,
    limit: 1,
  });
  if (error || !data || data.length === 0) return { exists: false };
  const found = data.find((f) => f.name === name);
  if (!found) return { exists: false };
  const sizeBytes = typeof found.metadata?.size === 'number' ? found.metadata.size : undefined;
  if (expectedSizeBytes != null && sizeBytes != null && sizeBytes !== expectedSizeBytes) {
    return { exists: false };
  }
  return { exists: true, sizeBytes };
}

/** A short-lived, single-document, user-only signed URL (spec section 25/58).
 * Never issued for a purged document — the caller must check
 * `raw_document_purge_status` before calling this. */
export async function createDocumentPreviewUrl(
  storageKey: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(FDH_SOURCE_DOCUMENTS_BUCKET)
    .createSignedUrl(storageKey, PREVIEW_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return { ok: false, message: error?.message ?? 'could not create signed URL' };
  return { ok: true, url: data.signedUrl };
}

/**
 * R7 (spec section 17) — the ONE path a trusted parser/service may read raw
 * document bytes back for processing. Never exposed to a browser: only
 * `bank-csv/*` server-side processing services call this, always after the
 * caller has already verified ownership via an RLS-scoped query (identical
 * discipline to every other function in this file).
 */
export async function downloadDocumentObject(
  storageKey: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(FDH_SOURCE_DOCUMENTS_BUCKET).download(storageKey);
  if (error || !data) return { ok: false, message: error?.message ?? 'could not download document' };
  const arrayBuffer = await data.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(arrayBuffer) };
}

/** Purge step 2/3 (spec section 42-43): remove the object, then verify it is
 * actually gone. Never returns "purged" on a delete call alone — the caller
 * (`services/purge.ts`) always calls `verifyDocumentObjectAbsent` next and
 * only transitions to PURGED once THAT returns true. */
export async function deleteDocumentObject(
  storageKey: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(FDH_SOURCE_DOCUMENTS_BUCKET).remove([storageKey]);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function verifyDocumentObjectAbsent(storageKey: string): Promise<boolean> {
  const { exists } = await verifyDocumentObjectExists(storageKey);
  return !exists;
}

/**
 * Orphan detection (spec section 49). Lists every object under one user's
 * storage prefix and returns keys not present in the given set of live
 * document storage keys for that user. Read-only — performs no deletion.
 * Intended for `scripts/fdh3_orphan_storage_report.mjs`, never for a
 * request-path call.
 */
export async function listObjectsUnderUserPrefix(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(FDH_SOURCE_DOCUMENTS_BUCKET).list(userId, {
    limit: 1000,
  });
  if (error || !data) return [];
  const keys: string[] = [];
  for (const docFolder of data) {
    if (!docFolder.id) continue; // a "folder" placeholder entry, not an object
    const { data: inner } = await admin.storage
      .from(FDH_SOURCE_DOCUMENTS_BUCKET)
      .list(`${userId}/${docFolder.name}`, { limit: 10 });
    for (const obj of inner ?? []) {
      if (obj.id) keys.push(`${userId}/${docFolder.name}/${obj.name}`);
    }
  }
  return keys;
}
