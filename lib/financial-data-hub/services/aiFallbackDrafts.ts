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

/** `document_type` is free text in 0197 (no CHECK), so widening this union
 * needs no migration. 2026-09-25 (other-PDF AI proof): the four statement
 * adapters now persist their drafts too -- before, their AI result existed
 * only in the HTTP response, the confirm step accepted any client body for a
 * document that had never produced a draft, and a replayed or concurrent
 * confirm was guarded only by a check-then-act. */
export type DraftDocumentType =
  | 'payslip'
  | 'bank_statement'
  | 'liability_statement'
  | 'retirement_statement'
  | 'investment_statement';

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

export type LoadPendingDraftResult =
  | { found: true; draftId: string; payload: unknown }
  | { found: false; reason: 'none_pending' | 'table_missing' | 'read_failed' };

/** The document's single pending draft, if any. Used by the statement
 * services that keep the document `queued` while a draft waits: a repeated
 * `/process` call returns the draft the server already issued instead of
 * paying for a second provider call. */
export async function loadPendingAiFallbackDraft(userId: string, documentId: string): Promise<LoadPendingDraftResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .select('id, payload')
    .eq('statement_upload_id', documentId)
    .eq('user_id', userId)
    .eq('status', 'pending_review')
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return { found: false, reason: 'table_missing' };
    return { found: false, reason: 'read_failed' };
  }
  const rows = (data ?? []) as Array<{ id: string; payload: unknown }>;
  if (rows.length === 0) return { found: false, reason: 'none_pending' };
  return { found: true, draftId: rows[0].id, payload: rows[0].payload };
}

/**
 * The canonical tables a confirmed statement draft writes, keyed by upload.
 * Checked before a failed confirmation hands its draft back.
 */
const CANONICAL_TABLES_BY_UPLOAD = [
  'fdh_transactions',
  'fdh_payroll_events',
  'fdh_liability_statements',
  'fdh_retirement_statements',
  'fdh_investment_statements',
] as const;

/**
 * Undo a claim ONLY if the failed confirmation wrote nothing canonical.
 *
 * Production, 2026-09-26: a bank statement's confirmation wrote its 9
 * transactions, then failed on a later status update; the draft was handed
 * back as `pending_review`, so confirming again would have imported the
 * statement a second time. If any canonical row exists for the upload, the
 * draft stays `confirmed` (the write happened; the document is left for
 * review) and `released` is false. An unreadable check also keeps the claim --
 * never re-open a draft we cannot prove is unwritten.
 */
export async function releaseClaimedAiFallbackDraftIfNothingWritten(
  userId: string,
  draftId: string,
  documentId: string,
): Promise<{ released: boolean; reason?: 'rows_written' | 'check_failed' }> {
  const admin = createAdminClient();
  for (const table of CANONICAL_TABLES_BY_UPLOAD) {
    const { data, error } = await admin
      .from(table)
      .select('id')
      .eq('statement_upload_id', documentId)
      .eq('user_id', userId)
      .limit(1);
    if (error) {
      if (isMissingTable(error)) continue;
      console.error(`AI draft ${draftId}: could not check ${table} before releasing (${error.message}) -- keeping it confirmed`);
      return { released: false, reason: 'check_failed' };
    }
    if (((data ?? []) as unknown[]).length > 0) {
      console.error(`AI draft ${draftId}: confirmation failed AFTER writing ${table} rows for upload ${documentId} -- keeping it confirmed so it cannot be imported twice`);
      return { released: false, reason: 'rows_written' };
    }
  }
  await releaseClaimedAiFallbackDraft(userId, draftId);
  return { released: true };
}

/** Undo a claim when the downstream write failed, so the user can retry.
 * Callers use releaseClaimedAiFallbackDraftIfNothingWritten, which checks
 * first; this is the unconditional primitive it ends with. */
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

/** 2026-09-25: the user said an AI reading "doesn't look right". Its pending
 * draft is marked `discarded` so it is no longer offered to resume (and can
 * no longer be confirmed). Scoped by document AND user; reports whether a
 * row actually changed (a zero-row update is not a success). */
export async function discardPendingAiFallbackDraft(userId: string, documentId: string): Promise<{ discarded: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .update({ status: 'discarded' })
    .eq('statement_upload_id', documentId)
    .eq('user_id', userId)
    .eq('status', 'pending_review')
    .select('id');
  if (error) return { discarded: false };
  return { discarded: ((data ?? []) as unknown[]).length > 0 };
}
