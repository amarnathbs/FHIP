// Investment Intelligence — raw source-document storage purge (2026-09-19).
//
// Extracted out of documentProcessing.ts, following the same precedent as
// reconciliationCases.ts and missingTransactionDetection.ts, so this can be
// unit-tested directly against a mocked storage layer without pulling in
// documentProcessing.ts's own pdf-parse/pdfjs-dist import chain.
//
// WHY THIS EXISTS. deleteSourceDocumentObject() has existed since R1 but had
// zero callers anywhere in the application — confirmed by a repo-wide
// search. Every raw statement PDF ever uploaded through this pipeline was
// retained in storage indefinitely, past processing and past the point its
// data was written to the canonical registers. This function is the fix:
// called once, right after a document finishes parsing successfully.
//
// Delete -> independently verify absent -> mark purged. Never trusts the
// delete call's own "no error" response alone, matching the AIE pipeline's
// own established purge pattern (lib/aie/storage.ts#verifyQuarantineObjectAbsent).
// Swallows its own errors: a purge failure must never fail the parse
// request that already succeeded — it is recorded on the row for an
// operator/retry job to pick up, never silently dropped and never
// surfaced to the caller.

import type { createAdminClient } from '@/lib/supabase/admin';
import { deleteSourceDocumentObject, verifySourceDocumentObjectAbsent } from './storage';

/**
 * AIE-1 final production completion (2026-09-25) -- the Investment
 * Intelligence raw-retention BACKSTOP.
 *
 * `purgeSourceDocumentStorage` below runs only after a SUCCESSFUL
 * deterministic parse. Everything else -- a document never processed, one the
 * parser found `unsupported`, `parse_failed`, `password_required`, handed to AI
 * review, or a purge that itself failed -- kept its original PDF
 * indefinitely. Confirmed read-only in production on 2026-09-25: four real
 * CAS statement PDFs uploaded between 6 and 16 September were still in the
 * `investment-source-documents` bucket.
 *
 * Rule: any row with a storage path, not yet purged, uploaded more than
 * `maxAgeHours` ago, and not mid-parse, has its object deleted and verified
 * absent (the same delete -> verify -> mark discipline). Structured data
 * already written (holdings, transactions, AI review rows) is untouched; only
 * the original file goes. Called from the AIE purge sweep.
 */
export async function enforceIiSourceDocumentRetentionBackstop(
  admin: ReturnType<typeof createAdminClient>,
  maxAgeHours = 24,
  limit = 100,
): Promise<{ scanned: number; purged: number; failed: number }> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
  const { data, error } = await admin
    .from('ii_source_documents')
    .select('id, storage_path, status')
    .not('storage_path', 'is', null)
    .is('storage_purged_at', null)
    .neq('status', 'parsing')
    .lt('uploaded_at', cutoff)
    .order('uploaded_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`ii retention backstop query failed: ${error.message}`);
    return { scanned: 0, purged: 0, failed: 0 };
  }
  let purged = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ id: string; storage_path: string }>) {
    await purgeSourceDocumentStorage(admin, row.id, row.storage_path);
    const { data: after } = await admin.from('ii_source_documents').select('storage_purged_at').eq('id', row.id).maybeSingle();
    if ((after as { storage_purged_at: string | null } | null)?.storage_purged_at) purged += 1;
    else failed += 1;
  }
  return { scanned: (data ?? []).length, purged, failed };
}

export async function purgeSourceDocumentStorage(
  admin: ReturnType<typeof createAdminClient>,
  sourceDocumentId: string,
  storagePath: string
): Promise<void> {
  try {
    const { error: deleteError } = await deleteSourceDocumentObject(storagePath);
    if (deleteError) {
      await admin.from('ii_source_documents').update({ storage_purge_error: deleteError }).eq('id', sourceDocumentId);
      return;
    }
    const confirmedAbsent = await verifySourceDocumentObjectAbsent(storagePath);
    if (!confirmedAbsent) {
      await admin
        .from('ii_source_documents')
        .update({ storage_purge_error: 'Delete call reported success but the object is still listable in storage.' })
        .eq('id', sourceDocumentId);
      return;
    }
    await admin
      .from('ii_source_documents')
      .update({ storage_purged_at: new Date().toISOString(), storage_purge_error: null })
      .eq('id', sourceDocumentId);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error during storage purge.';
    await admin.from('ii_source_documents').update({ storage_purge_error: message }).eq('id', sourceDocumentId);
  }
}
