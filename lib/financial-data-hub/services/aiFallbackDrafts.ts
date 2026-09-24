/**
 * AIE-1 final production completion (2026-09-25) -- durable AI-fallback
 * drafts (migration 0197, `fdh_ai_fallback_drafts`).
 *
 * The validated AI result is persisted BEFORE the user sees it, so review and
 * acceptance never depend on the original PDF still existing, and a
 * confirmation is accepted only against a draft the server actually issued.
 * Claiming a draft is one conditional UPDATE (pending_review -> confirmed):
 * a replayed or concurrent confirmation finds nothing to claim and writes
 * nothing.
 *
 * Service-role only (the table has no write policy for users). Every write is
 * scoped by BOTH the document id and the owning user id and verified by the
 * rows it returns (the zero-row-write lesson of the 2026-09-22 incident).
 *
 * DEPLOY ORDER. If migration 0197 has not been applied, every function reports
 * `table_missing` and callers fall back to the pre-0197 behaviour (draft in
 * the response only) rather than failing the user's upload.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type DraftDocumentType = 'payslip';

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    (/fdh_ai_fallback_drafts/.test(message) && /does not exist|could not find/i.test(message))
  );
}

export type SaveDraftResult =
  | { persisted: true; draftId: string }
  | { persisted: false; reason: 'table_missing' | 'write_failed'; detail?: string };

export async function saveAiFallbackDraft(params: {
  userId: string;
  documentId: string;
  documentType: DraftDocumentType;
  schemaName: string;
  schemaVersion: string;
  payload: unknown;
  providerIdempotencyKey?: string | null;
}): Promise<SaveDraftResult> {
  const admin = createAdminClient();
  // Any earlier pending draft for this document is superseded, never left
  // competing with the new one (the partial unique index would refuse it).
  const sup = await admin
    .from('fdh_ai_fallback_drafts')
    .update({ status: 'superseded' })
    .eq('statement_upload_id', params.documentId)
    .eq('user_id', params.userId)
    .eq('status', 'pending_review')
    .select('id');
  if (sup.error) {
    if (isMissingTable(sup.error)) return { persisted: false, reason: 'table_missing' };
    return { persisted: false, reason: 'write_failed', detail: sup.error.message };
  }
  const { data, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .insert({
      user_id: params.userId,
      statement_upload_id: params.documentId,
      document_type: params.documentType,
      schema_name: params.schemaName,
      schema_version: params.schemaVersion,
      payload: params.payload,
      provider_idempotency_key: params.providerIdempotencyKey ?? null,
    })
    .select('id')
    .single();
  if (error || !data) {
    if (isMissingTable(error)) return { persisted: false, reason: 'table_missing' };
    return { persisted: false, reason: 'write_failed', detail: error?.message };
  }
  return { persisted: true, draftId: (data as { id: string }).id };
}

export type ClaimDraftResult =
  | { claimed: true; draftId: string; payload: unknown }
  | { claimed: false; reason: 'none_pending' | 'table_missing' | 'write_failed'; detail?: string };

/** Moves the document's single pending draft to `confirmed`, atomically. */
export async function claimPendingAiFallbackDraft(params: {
  userId: string;
  documentId: string;
  confirmedPayload: unknown;
}): Promise<ClaimDraftResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_payload: params.confirmedPayload })
    .eq('statement_upload_id', params.documentId)
    .eq('user_id', params.userId)
    .eq('status', 'pending_review')
    .select('id, payload');
  if (error) {
    if (isMissingTable(error)) return { claimed: false, reason: 'table_missing' };
    return { claimed: false, reason: 'write_failed', detail: error.message };
  }
  const rows = (data ?? []) as Array<{ id: string; payload: unknown }>;
  if (rows.length === 0) return { claimed: false, reason: 'none_pending' };
  return { claimed: true, draftId: rows[0].id, payload: rows[0].payload };
}

/** Undo a claim when the downstream write failed, so the user can retry. */
export async function releaseClaimedAiFallbackDraft(userId: string, draftId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('fdh_ai_fallback_drafts')
    .update({ status: 'pending_review', confirmed_at: null, confirmed_payload: null })
    .eq('id', draftId)
    .eq('user_id', userId)
    .eq('status', 'confirmed');
  if (error) console.error(`could not release AI fallback draft ${draftId}: ${error.message}`);
}

/** Document ids (from the given set) that hold a pending draft. Used by the
 * raw-file backstop so it never rejects a document whose durable result is
 * still awaiting the user. Missing table -> empty set. */
export async function documentsWithPendingAiFallbackDrafts(documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .select('statement_upload_id')
    .in('statement_upload_id', documentIds)
    .eq('status', 'pending_review');
  if (error) return new Set();
  return new Set(((data ?? []) as Array<{ statement_upload_id: string }>).map((r) => r.statement_upload_id));
}
