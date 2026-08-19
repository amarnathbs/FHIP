import { createAdminClient } from '@/lib/supabase/admin';
import { randomUUID } from 'crypto';

export const II_STORAGE_BUCKET = 'investment-source-documents';

// File validation shell (spec section 15). Extension AND declared MIME type
// must both pass — neither is trusted alone. Matches the bucket-level
// allowed_mime_types/file_size_limit configuration set when the bucket was
// created (see docs/investment-intelligence/R1_SOURCE_STORAGE_REPORT.md),
// so a reject here and a reject at the Storage layer agree.
export const ALLOWED_MIME_TYPES = ['application/pdf', 'text/csv'] as const;
export const ALLOWED_EXTENSIONS = ['pdf', 'csv'] as const;
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface FileValidationResult {
  ok: boolean;
  error?: string;
}

// Pure — unit tested directly (no I/O).
export function validateUploadedFile(input: { filename: string; mimeType: string; sizeBytes: number }): FileValidationResult {
  const ext = input.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return { ok: false, error: `Unsupported file extension ".${ext}". Only PDF and CSV are accepted in R1.` };
  }
  if (!ALLOWED_MIME_TYPES.includes(input.mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    return { ok: false, error: `Unsupported file type "${input.mimeType}". Only application/pdf and text/csv are accepted in R1.` };
  }
  // Extension/MIME must agree — closes the "rename a .exe to .pdf" gap.
  if ((ext === 'pdf') !== (input.mimeType === 'application/pdf')) {
    return { ok: false, error: 'File extension and declared file type do not match.' };
  }
  if ((ext === 'csv') !== (input.mimeType === 'text/csv')) {
    return { ok: false, error: 'File extension and declared file type do not match.' };
  }
  if (input.sizeBytes <= 0) {
    return { ok: false, error: 'Empty file.' };
  }
  if (input.sizeBytes > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.` };
  }
  return { ok: true };
}

// Canonical, server-generated object key — NEVER a user-provided filename
// (spec section 14: "Do not trust user-provided filenames as storage
// paths"). Path is scoped by user_id first so an accidental cross-user path
// guess is non-functional even before RLS/signed-URL protection applies
// (R1_IMPLEMENTATION_SPEC.md section 4), matching report-exports' identical
// "{user_id}/..." convention.
export function generateObjectKey(userId: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin';
  return `${userId}/${randomUUID()}.${ext}`;
}

export async function uploadSourceDocumentObject(
  objectKey: string,
  fileBytes: Uint8Array,
  contentType: string
): Promise<{ error: string | null }> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, fileBytes, {
    contentType,
    upsert: false, // never silently overwrite an existing object — a re-upload is a new key
  });
  return { error: error?.message ?? null };
}

// Signed-URL-only read, short expiry — matches report-exports' 60-second
// precedent exactly (R0_CURRENT_STATE_DISCOVERY.md section 9).
export async function createSourceDocumentSignedUrl(
  objectKey: string,
  expirySeconds = 60
): Promise<{ url: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(II_STORAGE_BUCKET).createSignedUrl(objectKey, expirySeconds);
  return { url: data?.signedUrl ?? null, error: error?.message ?? null };
}

export async function deleteSourceDocumentObject(objectKey: string): Promise<{ error: string | null }> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(II_STORAGE_BUCKET).remove([objectKey]);
  return { error: error?.message ?? null };
}
