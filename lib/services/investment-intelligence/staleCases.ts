// Investment Intelligence -- governed housekeeping for reconciliation cases (Document2 (4) WP-B, 20-10-2026).
//
// Three server-side operations, all per user, all audited, none of which ever deletes a row:
//
//  1. `loadOpenCasesWithLifecycle`  the open cases joined with the LIVE state of the statement each was raised against
//                                   (is the raw file still stored? is data still retained?) and the lifecycle decision
//                                   of caseLifecycle.ts. Review and the Data tab render their actions from this.
//  2. `closeStaleCases`             the governed "Close stale case": only for a case whose resolution needs information
//                                   that no longer exists (a deleted raw file) or that belongs to a discarded statement.
//                                   Status becomes `resolved` with method `user_closed_stale_case`; the case row, its
//                                   evidence and the document row stay as history. Affected positions are re-evaluated
//                                   from the retained structured data.
//  3. `tidyOwnerAndDuplicateCases`  F8. Closes, as the SYSTEM, (a) open `owner_unmatched` cases whose account already has
//                                   an explicit owner a person chose (never inferred, never Self) and (b) exact duplicate
//                                   open cases of one account / document / type that earlier reprocessing opened, keeping
//                                   the oldest. Method `auto_resolved_existing_owner` / `auto_closed_duplicate_case`.
//
// The admin client is used deliberately: `discrepancy_details` and status transitions on ii_reconciliation_cases are
// system-authoritative (migration 0087). Ownership of every row is enforced by the `user_id` filter on every query.

import type { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { classifyCase, type CaseLifecycle, type LifecycleDocumentState } from './caseLifecycle';
import { loadExplicitOwnerAccountIds } from './accountOwnership';

type Admin = Pick<ReturnType<typeof createAdminClient>, 'from'>;

export interface OpenCaseRow {
  id: string;
  subject_type: string;
  subject_id: string;
  discrepancy_type: string;
  severity: string;
  source_document_id: string | null;
  discrepancy_details: Record<string, unknown> | null;
  opened_at: string;
}

export interface OpenCaseWithLifecycle {
  case: OpenCaseRow;
  document: LifecycleDocumentState | null;
  lifecycle: CaseLifecycle;
}

const OPEN_STATUSES = ['open', 'user_reviewing'];
const CASE_COLUMNS = 'id, subject_type, subject_id, discrepancy_type, severity, source_document_id, discrepancy_details, opened_at';

export async function loadDocumentStates(admin: Admin, userId: string, documentIds: readonly string[]): Promise<Map<string, LifecycleDocumentState>> {
  const out = new Map<string, LifecycleDocumentState>();
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return out;
  const [{ data: docs }, { data: snapshots }, { data: txns }] = await Promise.all([
    admin.from('ii_source_documents').select('id, status, storage_path, storage_purged_at').eq('user_id', userId).in('id', ids),
    admin.from('ii_holding_snapshots').select('source_document_id').eq('user_id', userId).in('source_document_id', ids),
    admin.from('ii_transactions').select('source_document_id').eq('user_id', userId).in('source_document_id', ids),
  ]);
  const withData = new Set<string>();
  for (const r of (snapshots ?? []) as { source_document_id: string | null }[]) if (r.source_document_id) withData.add(r.source_document_id);
  for (const r of (txns ?? []) as { source_document_id: string | null }[]) if (r.source_document_id) withData.add(r.source_document_id);
  for (const d of (docs ?? []) as { id: string; status: string | null; storage_path: string | null; storage_purged_at: string | null }[]) {
    out.set(d.id, { status: d.status, storagePath: d.storage_path, storagePurgedAt: d.storage_purged_at, hasRetainedData: withData.has(d.id) });
  }
  return out;
}

export async function loadOpenCasesWithLifecycle(admin: Admin, userId: string, opts: { caseIds?: readonly string[] } = {}): Promise<OpenCaseWithLifecycle[]> {
  let query = admin.from('ii_reconciliation_cases').select(CASE_COLUMNS).eq('user_id', userId).in('status', OPEN_STATUSES);
  if (opts.caseIds) query = query.in('id', [...opts.caseIds]);
  const { data: cases } = await query;
  const rows = (cases ?? []) as OpenCaseRow[];
  const docs = await loadDocumentStates(admin, userId, rows.map((c) => c.source_document_id).filter((x): x is string => !!x));
  return rows.map((c) => {
    const document = c.source_document_id ? (docs.get(c.source_document_id) ?? null) : null;
    // A case that points at a document row that no longer exists has nothing left to act on.
    const missingDocument = !!c.source_document_id && !document;
    const lifecycle = classifyCase(c.discrepancy_type, document ?? (missingDocument ? { status: 'archived', storagePath: null, storagePurgedAt: null } : null));
    return { case: c, document, lifecycle };
  });
}

export interface CloseStaleResult {
  closed: string[];
  refused: { caseId: string; reason: string }[];
  archivedDocumentIds: string[];
  recertified: number;
}

export interface CloseStaleOptions {
  /** Close exactly these cases. Omit to close every open case that is currently stale-closable. */
  caseIds?: readonly string[];
  note?: string | null;
  /** Re-evaluates one position from retained structured data (recertifyPosition). Injected so this module stays light. */
  recertify?: (accountId: string, instrumentId: string) => Promise<unknown>;
  nowIso?: string;
}

export async function closeStaleCases(admin: Admin, userId: string, opts: CloseStaleOptions = {}): Promise<CloseStaleResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const loaded = await loadOpenCasesWithLifecycle(admin, userId, opts.caseIds ? { caseIds: opts.caseIds } : {});
  const result: CloseStaleResult = { closed: [], refused: [], archivedDocumentIds: [], recertified: 0 };

  // A requested id that is not open (or not this user's) is reported, never silently skipped.
  if (opts.caseIds) {
    const found = new Set(loaded.map((l) => l.case.id));
    for (const id of opts.caseIds) if (!found.has(id)) result.refused.push({ caseId: id, reason: 'This item is not open (it may already be closed) or does not exist.' });
  }

  const touchedDocuments = new Map<string, OpenCaseWithLifecycle['document']>();
  for (const item of loaded) {
    const { case: c, lifecycle, document } = item;
    if (!lifecycle.staleClosable) {
      if (opts.caseIds) result.refused.push({ caseId: c.id, reason: 'This item can still be resolved directly, so it cannot be closed as stale.' });
      continue;
    }
    const mergedDetails = {
      ...(c.discrepancy_details ?? {}),
      closedStale: { at: nowIso, need: lifecycle.need, fileStored: lifecycle.fileStored, documentArchived: lifecycle.documentArchived, note: opts.note ?? null },
    };
    const { error } = await admin
      .from('ii_reconciliation_cases')
      .update({ status: 'resolved', resolved_at: nowIso, resolution_method: 'user_closed_stale_case', resolved_by: userId, resolved_by_actor_type: 'user', discrepancy_details: mergedDetails })
      .eq('id', c.id)
      .eq('user_id', userId)
      .in('status', OPEN_STATUSES); // race guard: only if still open
    if (error) {
      result.refused.push({ caseId: c.id, reason: 'This item could not be closed. Nothing was changed.' });
      continue;
    }
    result.closed.push(c.id);
    if (c.source_document_id) touchedDocuments.set(c.source_document_id, document);
    await emitAuditEvent({
      userId,
      eventType: 'reconciliation_case_resolved',
      subjectType: 'ii_reconciliation_cases',
      subjectId: c.id,
      actorType: 'user',
      actorId: userId,
      metadata: { discrepancyType: c.discrepancy_type, resolutionMethod: 'user_closed_stale_case', need: lifecycle.need, fileStored: lifecycle.fileStored, sourceDocumentId: c.source_document_id },
    });
  }

  for (const [documentId, document] of touchedDocuments) {
    if (!document) continue;
    // A statement that produced no data and whose file is gone has nothing left to offer: archive the row (kept as history).
    // A statement that DID produce data stays as it is: its holdings are real and are re-evaluated below.
    const { data: stillOpen } = await admin.from('ii_reconciliation_cases').select('id').eq('user_id', userId).eq('source_document_id', documentId).in('status', OPEN_STATUSES);
    const openLeft = (stillOpen ?? []).length;
    if (!document.hasRetainedData && openLeft === 0 && document.status !== 'archived' && document.status !== 'superseded' && document.status !== 'parsed') {
      const { error } = await admin.from('ii_source_documents').update({ status: 'archived' }).eq('id', documentId).eq('user_id', userId);
      if (!error) {
        result.archivedDocumentIds.push(documentId);
        await emitAuditEvent({ userId, eventType: 'archive', subjectType: 'ii_source_documents', subjectId: documentId, actorType: 'user', actorId: userId, metadata: { previousStatus: document.status, reason: 'stale_cases_closed', fileStored: false } });
      }
    }
    if (opts.recertify && document.hasRetainedData) {
      const { data: positions } = await admin.from('ii_holding_snapshots').select('account_id, instrument_id').eq('user_id', userId).eq('source_document_id', documentId);
      const seen = new Set<string>();
      for (const p of (positions ?? []) as { account_id: string; instrument_id: string }[]) {
        const key = `${p.account_id}:${p.instrument_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await opts.recertify(p.account_id, p.instrument_id);
          result.recertified += 1;
        } catch {
          // A failed re-evaluation never undoes a close; the position keeps its previous (honest) status.
        }
      }
    }
  }
  return result;
}

export interface TidyResult {
  closedExistingOwner: string[];
  closedDuplicates: string[];
}

const OWNER_QUESTION_TYPES = ['owner_unmatched'];
const DUPLICATE_COLLAPSE_TYPES = ['owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required', 'document_password_required', 'unsupported_document', 'document_corrupt', 'parse_incomplete'];

export async function tidyOwnerAndDuplicateCases(admin: Admin, userId: string, nowIso = new Date().toISOString()): Promise<TidyResult> {
  const result: TidyResult = { closedExistingOwner: [], closedDuplicates: [] };
  const { data } = await admin
    .from('ii_reconciliation_cases')
    .select(CASE_COLUMNS)
    .eq('user_id', userId)
    .in('status', OPEN_STATUSES)
    .in('discrepancy_type', DUPLICATE_COLLAPSE_TYPES)
    .order('opened_at', { ascending: true });
  const rows = (data ?? []) as OpenCaseRow[];
  if (rows.length === 0) return result;

  // (a) A question that was already answered: the account has an owner a person chose.
  const ownerRows = rows.filter((r) => OWNER_QUESTION_TYPES.includes(r.discrepancy_type) && r.subject_type === 'account');
  const explicit = await loadExplicitOwnerAccountIds(admin, userId, [...new Set(ownerRows.map((r) => r.subject_id))]);
  const closedIds = new Set<string>();
  for (const r of ownerRows) {
    if (!explicit.has(r.subject_id)) continue; // no explicit owner: stays open, the person must choose. Never guessed.
    const { error } = await admin
      .from('ii_reconciliation_cases')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        resolution_method: 'auto_resolved_existing_owner',
        resolved_by_actor_type: 'system',
        discrepancy_details: { ...(r.discrepancy_details ?? {}), resolvedByExistingOwner: true, note: 'The owner of this account had already been chosen by the person; this reprocessing-generated question was closed, not answered on their behalf.' },
      })
      .eq('id', r.id)
      .eq('user_id', userId)
      .in('status', OPEN_STATUSES);
    if (!error) {
      closedIds.add(r.id);
      result.closedExistingOwner.push(r.id);
      await emitAuditEvent({ userId, eventType: 'reconciliation_case_resolved', subjectType: 'ii_reconciliation_cases', subjectId: r.id, actorType: 'system', metadata: { discrepancyType: r.discrepancy_type, resolutionMethod: 'auto_resolved_existing_owner', accountId: r.subject_id } });
    }
  }

  // (b) Exact duplicates raised by repeated reprocessing: same subject, type and document. Keep the oldest.
  const keep = new Map<string, string>();
  for (const r of rows) {
    if (closedIds.has(r.id)) continue;
    const key = `${r.subject_type}|${r.subject_id}|${r.discrepancy_type}|${r.source_document_id ?? ''}`;
    const first = keep.get(key);
    if (!first) {
      keep.set(key, r.id);
      continue;
    }
    const { error } = await admin
      .from('ii_reconciliation_cases')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        resolution_method: 'auto_closed_duplicate_case',
        resolved_by_actor_type: 'system',
        discrepancy_details: { ...(r.discrepancy_details ?? {}), duplicateOfCaseId: first },
      })
      .eq('id', r.id)
      .eq('user_id', userId)
      .in('status', OPEN_STATUSES);
    if (!error) {
      result.closedDuplicates.push(r.id);
      await emitAuditEvent({ userId, eventType: 'reconciliation_case_resolved', subjectType: 'ii_reconciliation_cases', subjectId: r.id, actorType: 'system', metadata: { discrepancyType: r.discrepancy_type, resolutionMethod: 'auto_closed_duplicate_case', duplicateOfCaseId: first } });
    }
  }
  return result;
}
