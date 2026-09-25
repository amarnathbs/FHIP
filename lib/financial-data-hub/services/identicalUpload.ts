/**
 * Byte-identical re-uploads (2026-09-25) -- one rule for every FDH upload type.
 *
 * The first real production AI journey (a payslip) showed what a re-upload of
 * an already-read document did: it paid for a second AI read, was then
 * recognised as a duplicate, and dead-ended on the copy, because the copy has
 * no evidence of its own. The payslip fix (`findEarlierIdenticalPayslip`)
 * looked for an earlier upload of the same bytes BEFORE any download, parse or
 * AI call and carried on with that one. This module is that rule, shared by
 * every statement type, so the types cannot drift apart again.
 *
 * WHY NOT `fdh_statement_uploads.duplicate_of_document_id`. The upload
 * lifecycle sets it to the NEWEST earlier upload with the same hash, of ANY
 * document type. Once a statement had been uploaded twice, the third upload
 * pointed at the second -- itself a copy with no evidence -- so the old
 * "duplicate" check found nothing and the statement was parsed (and, on the AI
 * path, paid for) all over again. Here the match is restricted to the same
 * document type and the OLDEST upload that actually holds a result wins, so
 * every copy points at the original.
 *
 * WHAT COUNTS AS A RESULT, in order:
 *   1. evidence: a row in the type's evidence table (or, for bank statements,
 *      a settled upload) -- the copy carries on with the original's evidence;
 *   2. a pending AI draft (`fdh_ai_fallback_drafts`, 0197) -- the copy carries
 *      on with the draft the server already issued for the original, so the
 *      user reviews and confirms it there; nothing is read again.
 *
 * Service-role reads, always scoped to `userId`: processing can run where no
 * user session exists (the scan-sweep cron), and the drafts table has no user
 * write path. Never matches across users.
 */

import { createAdminClient } from '@/lib/supabase/admin';

type AdminClient = ReturnType<typeof createAdminClient>;

export type IdenticalUploadMatch =
  | { kind: 'evidence'; documentId: string; evidenceId: string }
  | { kind: 'pending_draft'; documentId: string; draftId: string; payload: unknown };

export interface IdenticalUploadSpec {
  /** Evidence table keyed by `statement_upload_id` (id -> evidence id). */
  evidenceTable?: string;
  /** Custom evidence lookup, for types whose result lives on the upload row itself. */
  evidenceFor?: (admin: AdminClient, userId: string, documentIds: string[]) => Promise<Map<string, string>>;
  /** Also carry on with an original's pending AI draft (default true). */
  includePendingDrafts?: boolean;
}

/** How many earlier copies are considered. More than this many uploads of the
 * same bytes is not a real journey; the oldest ones are the ones that matter. */
const MAX_COPIES = 20;

export async function findEarlierIdenticalUpload(
  userId: string,
  documentId: string,
  spec: IdenticalUploadSpec,
): Promise<IdenticalUploadMatch | null> {
  const admin = createAdminClient();
  const { data: doc } = await admin
    .from('fdh_statement_uploads')
    .select('file_hash, document_type')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle();
  const { file_hash: fileHash, document_type: documentType } = (doc ?? {}) as { file_hash?: string | null; document_type?: string | null };
  if (!fileHash || !documentType) return null;

  const { data: copies } = await admin
    .from('fdh_statement_uploads')
    .select('id')
    .eq('user_id', userId)
    // The SAME document type only: the same bytes uploaded as a loan and then
    // as a credit card are two different readings, not a copy.
    .eq('document_type', documentType)
    .eq('file_hash', fileHash)
    .neq('id', documentId)
    .order('created_at', { ascending: true })
    .limit(MAX_COPIES);
  const ids = ((copies ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length === 0) return null;

  const evidence = spec.evidenceFor
    ? await spec.evidenceFor(admin, userId, ids)
    : spec.evidenceTable
      ? await evidenceFromTable(admin, spec.evidenceTable, userId, ids)
      : new Map<string, string>();
  const withEvidence = ids.find((id) => evidence.has(id));
  if (withEvidence) return { kind: 'evidence', documentId: withEvidence, evidenceId: evidence.get(withEvidence)! };

  if (spec.includePendingDrafts === false) return null;
  const { data: drafts, error } = await admin
    .from('fdh_ai_fallback_drafts')
    .select('id, statement_upload_id, payload')
    .eq('user_id', userId)
    .in('statement_upload_id', ids)
    .eq('status', 'pending_review');
  // A missing 0197 table (or any read error) means "no draft to carry on
  // with" -- the caller then processes normally, exactly as before 0197.
  if (error) return null;
  const byDoc = new Map(((drafts ?? []) as Array<{ id: string; statement_upload_id: string; payload: unknown }>).map((d) => [d.statement_upload_id, d]));
  const withDraft = ids.find((id) => byDoc.has(id));
  if (!withDraft) return null;
  const d = byDoc.get(withDraft)!;
  return { kind: 'pending_draft', documentId: withDraft, draftId: d.id, payload: d.payload };
}

async function evidenceFromTable(admin: AdminClient, table: string, userId: string, documentIds: string[]): Promise<Map<string, string>> {
  const { data } = await admin
    .from(table)
    .select('id, statement_upload_id')
    .eq('user_id', userId)
    .in('statement_upload_id', documentIds);
  return new Map(((data ?? []) as Array<{ id: string; statement_upload_id: string }>).map((r) => [r.statement_upload_id, r.id]));
}

/** Bank statements keep their result on the upload row: a settled upload
 * (certified, or certified-with-review) whose transactions were written. A
 * rejected original is NOT a result -- re-uploading it is how a user retries. */
export async function settledBankUploads(admin: AdminClient, userId: string, documentIds: string[]): Promise<Map<string, string>> {
  const { data } = await admin
    .from('fdh_statement_uploads')
    .select('id, certification_status, processing_completed_at')
    .eq('user_id', userId)
    .in('id', documentIds);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ id: string; certification_status: string | null; processing_completed_at: string | null }>) {
    if (r.processing_completed_at && (r.certification_status === 'certified' || r.certification_status === 'review_required')) out.set(r.id, r.id);
  }
  return out;
}

/** The per-type specs, in one place so every entry point of a type uses the same one. */
export const IDENTICAL_UPLOAD_SPECS = {
  payslip: { evidenceTable: 'fdh_payroll_events' },
  liability: { evidenceTable: 'fdh_liability_statements' },
  retirement: { evidenceTable: 'fdh_retirement_statements' },
  investment: { evidenceTable: 'fdh_investment_statements' },
  bank: { evidenceFor: settledBankUploads },
} as const satisfies Record<string, IdenticalUploadSpec>;
