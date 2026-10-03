import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import {
  CROSS_SOURCE_REVIEW_TYPES,
  classifyTransactionOrigin,
  planCrossSourceDecision,
  planUndo,
  type CrossSourceDecision,
  type CrossSourcePair,
  type PairTransaction,
  type PlannedChange,
} from '@/lib/services/investment-intelligence/crossSourceReviewPolicy';
import { isUserSuppliedInvestmentDateReference } from '@/lib/investment-intelligence/investmentDate';
import { z } from 'zod';

// Probable duplicates between a statement entry and a manual entry
// (Document2 D-5, PO decision 2026-10-03). Supersedes the 2026-09-30
// "same transaction / different transaction" conflict-choice.
//
// THE RULE. Analysis never waits on a possible duplicate: both entries are
// counted as the user entered them, the case is a NON-BLOCKING highlight
// (severity 'medium'), and the USER decides:
//
//   keep_both                       nothing changes
//   accept_statement_remove_manual  the manual entry is taken out of the figures
//   reject_statement                the statement entry is taken out of the figures
//   undo                            puts back whatever that decision took out
//
// "Taken out" is a SOFT, AUDITED, REVERSIBLE status change to 'reversed' (the
// exclusion every analytics reader already applies; the row, its source links
// and its evidence are kept). There is no hard delete anywhere in this route.
// The two removal choices need `confirm: true`: the server refuses them
// without it, so a stray request can never change a user's figures.
//
// Everything is scoped to the caller: the case, both transactions and both
// source documents are read with `user_id = <caller>`; a case that is not the
// caller's is a 404, never a 403, so existence is not leaked. The route runs
// with the service-role client because ii_transactions has no authenticated
// write path (migration 0087); that user_id filter is the tenancy boundary.
//
// IDEMPOTENT. Repeating the decision already recorded is a no-op success; a
// different decision on an already-decided case is a 409 (use undo first).
//
// LEGACY. 'confirmed_duplicate' / 'confirmed_distinct' (closure #4) are still
// accepted so an old client keeps working.
const RESOLVE_DECISIONS = ['keep_both', 'accept_statement_remove_manual', 'reject_statement', 'confirmed_duplicate', 'confirmed_distinct', 'undo'] as const satisfies readonly (CrossSourceDecision | 'undo')[];

const resolveSchema = z.object({
  decision: z.enum(RESOLVE_DECISIONS),
  counterpartTransactionId: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});

const REMOVAL_DECISIONS: ReadonlySet<string> = new Set(['accept_statement_remove_manual', 'reject_statement']);

type Admin = ReturnType<typeof createAdminClient>;

interface CaseRow {
  id: string;
  status: string;
  discrepancy_type: string;
  discrepancy_details: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
}

interface TxnRow {
  id: string;
  user_id: string;
  account_id: string;
  instrument_id: string;
  status: string;
  transaction_date: string;
  transaction_type: string;
  units: number | string | null;
  gross_amount: number | string;
  source_document_id: string | null;
  source_reference: string | null;
}

async function loadCase(admin: Admin, caseId: string, userId: string): Promise<CaseRow | null> {
  const { data } = await admin
    .from('ii_reconciliation_cases')
    .select('id, status, discrepancy_type, discrepancy_details, evidence')
    .eq('id', caseId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as CaseRow | null) ?? null;
}

async function loadTxn(admin: Admin, id: string, userId: string): Promise<TxnRow | null> {
  const { data } = await admin
    .from('ii_transactions')
    .select('id, user_id, account_id, instrument_id, status, transaction_date, transaction_type, units, gross_amount, source_document_id, source_reference')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as TxnRow | null) ?? null;
}

async function documentInfo(admin: Admin, documentId: string | null, userId: string): Promise<{ documentType: string | null; filename: string | null }> {
  if (!documentId) return { documentType: null, filename: null };
  const { data } = await admin.from('ii_source_documents').select('document_type, original_filename').eq('id', documentId).eq('user_id', userId).maybeSingle();
  const row = data as { document_type: string | null; original_filename: string | null } | null;
  return { documentType: row?.document_type ?? null, filename: row?.original_filename ?? null };
}

function counterpartIds(evidence: Record<string, unknown> | null): string[] {
  const raw = evidence?.comparedTransactionIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function appliedChangesOf(details: Record<string, unknown>): PlannedChange[] {
  const raw = details.appliedChanges;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is PlannedChange => !!c && typeof (c as PlannedChange).transactionId === 'string' && typeof (c as PlannedChange).from === 'string' && typeof (c as PlannedChange).to === 'string'
  );
}

async function toPairTransaction(admin: Admin, row: TxnRow, userId: string): Promise<{ pair: PairTransaction; filename: string | null }> {
  const doc = await documentInfo(admin, row.source_document_id, userId);
  const origin = isUserSuppliedInvestmentDateReference(row.source_reference) ? 'manual' : classifyTransactionOrigin(doc.documentType, row.source_document_id);
  return { pair: { id: row.id, origin, status: row.status }, filename: doc.filename };
}

/** Which counterpart does this request mean? One recorded = it; several (ambiguous) = the caller must pick one of them. */
function pickCounterpartId(evidence: Record<string, unknown> | null, requested: string | undefined): { id: string | null; error: string | null } {
  const ids = counterpartIds(evidence);
  if (ids.length === 0) return { id: null, error: null };
  if (ids.length === 1) return { id: ids[0], error: null };
  if (requested && ids.includes(requested)) return { id: requested, error: null };
  return { id: null, error: 'More than one existing entry could be the same transaction. Say which one this is about.' };
}

// ---------------------------------------------------------------------------
// GET — what the Review screen shows next to the three choices.
// ---------------------------------------------------------------------------
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const admin = createAdminClient();
  const existing = await loadCase(admin, caseId, user.id);
  if (!existing) return bad('Reconciliation case not found.', 404);
  if (!(CROSS_SOURCE_REVIEW_TYPES as readonly string[]).includes(existing.discrepancy_type)) return bad('This case is not a probable duplicate.', 422);

  const details = existing.discrepancy_details ?? {};
  const newTransactionId = typeof details.newTransactionId === 'string' ? details.newTransactionId : null;
  const describe = async (id: string | null) => {
    if (!id) return null;
    const row = await loadTxn(admin, id, user.id);
    if (!row) return null;
    const { pair, filename } = await toPairTransaction(admin, row, user.id);
    return {
      transactionId: row.id,
      origin: pair.origin,
      date: row.transaction_date,
      type: row.transaction_type,
      units: row.units === null ? null : Number(row.units),
      amount: Number(row.gross_amount),
      status: row.status,
      sourceName: pair.origin === 'manual' ? 'Your manual entry' : filename ?? 'A statement',
      isUserSuppliedInvestmentDate: isUserSuppliedInvestmentDateReference(row.source_reference),
    };
  };
  const subject = await describe(newTransactionId);
  const candidates = (await Promise.all(counterpartIds(existing.evidence).map((id) => describe(id)))).filter((c): c is NonNullable<typeof c> => c !== null);
  const kind = (subject?.isUserSuppliedInvestmentDate || candidates.some((c) => c.isUserSuppliedInvestmentDate)) ? 'user_supplied_investment_date' : 'standard';
  const statementVsManual = subject && candidates.length > 0 ? candidates.some((c) => c.origin !== subject.origin) : false;

  return ok({
    caseId,
    status: existing.status,
    kind,
    subject,
    candidates,
    // Options 2 and 3 only make sense when one side is a statement and the other a manual entry.
    offered: {
      keep_both: true,
      accept_statement_remove_manual: statementVsManual,
      reject_statement: statementVsManual && kind !== 'user_supplied_investment_date',
    },
    decision: typeof details.userDecision === 'string' ? details.userDecision : null,
    canUndo: existing.status === 'resolved' && typeof details.userDecision === 'string',
  });
}

// ---------------------------------------------------------------------------
// POST — decide, or undo.
// ---------------------------------------------------------------------------
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = resolveSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { decision, confirm } = parsed.data;

  const admin = createAdminClient();
  const existing = await loadCase(admin, caseId, user.id);
  if (!existing) return bad('Reconciliation case not found.', 404);
  if (!(CROSS_SOURCE_REVIEW_TYPES as readonly string[]).includes(existing.discrepancy_type)) {
    return bad('This case cannot be resolved this way.', 422);
  }

  const details = existing.discrepancy_details ?? {};
  const newTransactionId = typeof details.newTransactionId === 'string' ? details.newTransactionId : null;
  if (!newTransactionId) return bad('This case has no resolvable transaction on record.', 422);

  if (decision === 'undo') return undoDecision({ admin, userId: user.id, caseId, existing, details });

  if (REMOVAL_DECISIONS.has(decision) && confirm !== true) {
    return bad('Please confirm this choice first. It takes an entry out of your figures (it is kept on record and can be brought back).', 422, 'confirmation_required');
  }

  if (existing.status === 'resolved') {
    if (details.userDecision === decision) return ok({ caseId, decision, alreadyResolved: true });
    return bad('This has already been decided. Undo that decision first if you want to choose differently.', 409, 'already_resolved');
  }
  if (existing.status !== 'open') return bad(`Cannot resolve a case with status '${existing.status}'.`, 422);

  // Never trust that the recorded ids still belong to this user and are still
  // in the state this decision expects.
  const subjectRow = await loadTxn(admin, newTransactionId, user.id);
  if (!subjectRow) return bad('The transaction this issue refers to could not be found.', 404);
  const picked = pickCounterpartId(existing.evidence, parsed.data.counterpartTransactionId);
  if (picked.error) return bad(picked.error, 422, 'choose_counterpart');
  const counterpartRow = picked.id ? await loadTxn(admin, picked.id, user.id) : null;
  if (picked.id && !counterpartRow) return bad('The entry this may duplicate could not be found.', 404);

  const subject = await toPairTransaction(admin, subjectRow, user.id);
  const counterpart = counterpartRow ? await toPairTransaction(admin, counterpartRow, user.id) : null;
  const pair: CrossSourcePair = {
    subject: subject.pair,
    counterpart: counterpart ? counterpart.pair : null,
    kind: isUserSuppliedInvestmentDateReference(subjectRow.source_reference) || (counterpartRow && isUserSuppliedInvestmentDateReference(counterpartRow.source_reference)) ? 'user_supplied_investment_date' : 'standard',
  };

  const plan = planCrossSourceDecision(decision as CrossSourceDecision, pair);
  if (!plan.ok) return bad(plan.message, 422, plan.code);

  const applyError = await applyChanges(admin, user.id, plan.changes, 'forward');
  if (applyError) return bad(applyError, 409, 'state_changed');
  await syncInvestmentDateInputs(admin, user.id, plan.changes, 'forward');

  const nowIso = new Date().toISOString();
  const { error: resolveErr } = await admin
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: plan.resolutionMethod,
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
      discrepancy_details: { ...details, userDecision: decision, appliedChanges: plan.changes, counterpartTransactionId: picked.id },
    })
    .eq('id', caseId)
    .eq('user_id', user.id)
    .eq('status', 'open');
  if (resolveErr) {
    // The status changes were applied but the case could not be closed: put the figures back rather than leave a silent half-state.
    await applyChanges(admin, user.id, plan.changes, 'reverse');
    await syncInvestmentDateInputs(admin, user.id, plan.changes, 'reverse');
    return bad(resolveErr.message);
  }

  await emitAuditEvent({
    userId: user.id,
    eventType: 'reconciliation_case_resolved',
    subjectType: 'ii_reconciliation_cases',
    subjectId: caseId,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: caseId, discrepancyType: existing.discrepancy_type, decision, transactionId: newTransactionId, counterpartTransactionId: picked.id },
  });
  if (plan.changes.length > 0) {
    await emitAuditEvent({
      userId: user.id,
      eventType: 'user_correction',
      subjectType: 'ii_transactions',
      subjectId: plan.changes[0].transactionId,
      actorType: 'user',
      actorId: user.id,
      metadata: { kind: 'probable_duplicate_decision', reconciliationCaseId: caseId, decision, changes: plan.changes },
    });
  }
  await recertifyAffected(user.id, [subjectRow, ...(counterpartRow ? [counterpartRow] : [])], plan.changes);

  return ok({ caseId, decision, transactionId: newTransactionId, changes: plan.changes });
}

async function undoDecision(args: { admin: Admin; userId: string; caseId: string; existing: CaseRow; details: Record<string, unknown> }) {
  const { admin, userId, caseId, existing, details } = args;
  if (existing.status !== 'resolved' || typeof details.userDecision !== 'string') {
    return bad('There is no decision on this to undo.', 409, 'nothing_to_undo');
  }
  const applied = appliedChangesOf(details);
  const statuses = new Map<string, string>();
  for (const c of applied) {
    const row = await loadTxn(admin, c.transactionId, userId);
    if (row) statuses.set(c.transactionId, row.status);
  }
  const undo = planUndo(applied, statuses);

  const applyError = await applyChanges(admin, userId, undo, 'forward');
  if (applyError) return bad(applyError, 409, 'state_changed');
  await syncInvestmentDateInputs(admin, userId, undo, 'forward');

  const { userDecision, appliedChanges, counterpartTransactionId, ...rest } = details;
  void appliedChanges;
  const history = Array.isArray(rest.decisionHistory) ? (rest.decisionHistory as unknown[]) : [];
  const { error } = await admin
    .from('ii_reconciliation_cases')
    .update({
      status: 'open',
      resolved_at: null,
      resolution_method: null,
      resolved_by: null,
      resolved_by_actor_type: null,
      discrepancy_details: { ...rest, decisionHistory: [...history, { decision: userDecision, undoneAt: new Date().toISOString(), counterpartTransactionId: counterpartTransactionId ?? null }] },
    })
    .eq('id', caseId)
    .eq('user_id', userId)
    .eq('status', 'resolved');
  if (error) {
    await applyChanges(admin, userId, undo, 'reverse');
    await syncInvestmentDateInputs(admin, userId, undo, 'reverse');
    return bad(error.message);
  }

  await emitAuditEvent({
    userId,
    eventType: 'user_correction',
    subjectType: 'ii_reconciliation_cases',
    subjectId: caseId,
    actorType: 'user',
    actorId: userId,
    metadata: { kind: 'probable_duplicate_decision_undone', reconciliationCaseId: caseId, undoneDecision: userDecision, changes: undo },
  });
  const rows: TxnRow[] = [];
  for (const c of undo) {
    const row = await loadTxn(admin, c.transactionId, userId);
    if (row) rows.push(row);
  }
  await recertifyAffected(userId, rows, undo);
  return ok({ caseId, undone: true, changes: undo });
}

/** Apply status changes, each guarded by the status it expects (a concurrent change makes it refuse, never overwrite). */
async function applyChanges(admin: Admin, userId: string, changes: PlannedChange[], direction: 'forward' | 'reverse'): Promise<string | null> {
  const done: PlannedChange[] = [];
  for (const c of changes) {
    const from = direction === 'forward' ? c.from : c.to;
    const to = direction === 'forward' ? c.to : c.from;
    const row = await loadTxn(admin, c.transactionId, userId);
    if (!row) {
      await rollback(admin, userId, done, direction);
      return 'An entry this refers to could not be found.';
    }
    if (row.status !== from) {
      if (row.status === to) continue; // already there (a retry)
      await rollback(admin, userId, done, direction);
      return 'One of these entries has changed since this screen loaded. Reload and try again.';
    }
    const { error } = await admin.from('ii_transactions').update({ status: to }).eq('id', c.transactionId).eq('user_id', userId).eq('status', from);
    if (error) {
      await rollback(admin, userId, done, direction);
      return error.message;
    }
    done.push(c);
  }
  return null;
}

async function rollback(admin: Admin, userId: string, done: PlannedChange[], direction: 'forward' | 'reverse') {
  for (const c of done) {
    const from = direction === 'forward' ? c.to : c.from;
    const to = direction === 'forward' ? c.from : c.to;
    await admin.from('ii_transactions').update({ status: to }).eq('id', c.transactionId).eq('user_id', userId).eq('status', from);
  }
}

/**
 * A user-supplied investment date (D-3) is a manual entry whose input row must
 * follow its derived purchase: removed -> 'superseded', brought back -> 'applied'.
 */
async function syncInvestmentDateInputs(admin: Admin, userId: string, changes: PlannedChange[], direction: 'forward' | 'reverse') {
  for (const c of changes) {
    const result = direction === 'forward' ? c.to : c.from;
    const previous = direction === 'forward' ? c.from : c.to;
    const now = new Date().toISOString();
    if (result === 'reversed') {
      await admin.from('ii_investment_date_inputs').update({ status: 'superseded', supersede_reason: 'statement_history_accepted', updated_at: now }).eq('derived_transaction_id', c.transactionId).eq('user_id', userId);
    } else if (previous === 'reversed') {
      await admin.from('ii_investment_date_inputs').update({ status: 'applied', supersede_reason: null, updated_at: now }).eq('derived_transaction_id', c.transactionId).eq('user_id', userId);
    }
  }
}

/** Best effort: re-evaluate the affected positions with the existing "Re-evaluate" function. A failure never undoes the user's decision. */
async function recertifyAffected(userId: string, rows: TxnRow[], changes: PlannedChange[]) {
  if (changes.length === 0) return;
  const seen = new Set<string>();
  try {
    const { recertifyPosition } = await import('@/lib/services/investment-intelligence/documentProcessing');
    for (const r of rows) {
      const key = `${r.account_id}:${r.instrument_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await recertifyPosition(userId, r.account_id, r.instrument_id);
    }
  } catch (err) {
    console.error('[investment-intelligence] re-evaluation after a probable-duplicate decision failed', err instanceof Error ? err.message : err);
  }
}
