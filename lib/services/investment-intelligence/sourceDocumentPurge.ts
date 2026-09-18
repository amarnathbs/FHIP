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
