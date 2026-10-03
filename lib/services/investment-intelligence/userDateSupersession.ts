// A statement with real history arrives for a position whose purchase date the
// user had typed in (Document2 D-3 follow-up, PO decision 2026-10-03).
//
// The user-supplied investment date writes ONE derived 'purchase' for all the
// units held (investmentDateService.ts). If a full statement later brings the
// real transactions for the same position, both are now in the ledger and the
// units would be counted twice. Nothing is removed automatically (the PO rule:
// nothing in the user's data changes until they confirm). Instead this opens
// the SAME non-blocking probable-duplicate review the statement-vs-manual
// detection uses, so the user chooses: keep both, or accept the statement and
// remove the investment date they typed (a soft, reversible removal).
//
// Idempotent: one open case per derived purchase, never a second.

import type { SupabaseClient } from '@supabase/supabase-js';
import { openReconciliationCase } from './reconciliationCases';
import { ACQUIRING_TRANSACTION_TYPES } from '@/lib/investment-intelligence/investmentDate';
import { CROSS_SOURCE_REVIEW_SEVERITY } from './crossSourceReviewPolicy';

type Db = Pick<SupabaseClient, 'from'>;

export interface StatementTransactionForSupersession {
  id: string;
  accountId: string;
  instrumentId: string;
  type: string;
  date: string;
}

/** The earliest acquiring statement transaction for each position in a document. Pure. */
export function earliestAcquiringByPosition(rows: readonly StatementTransactionForSupersession[]): Map<string, StatementTransactionForSupersession> {
  const out = new Map<string, StatementTransactionForSupersession>();
  for (const r of rows) {
    if (!ACQUIRING_TRANSACTION_TYPES.has(r.type)) continue;
    const key = `${r.accountId}:${r.instrumentId}`;
    const cur = out.get(key);
    if (!cur || r.date < cur.date || (r.date === cur.date && r.id < cur.id)) out.set(key, r);
  }
  return out;
}

export async function openUserDateSupersessionCases(args: {
  db: Db;
  userId: string;
  sourceDocumentId: string;
  statementTransactions: readonly StatementTransactionForSupersession[];
}): Promise<{ opened: number }> {
  const { db, userId, sourceDocumentId } = args;
  let opened = 0;
  for (const stmt of earliestAcquiringByPosition(args.statementTransactions).values()) {
    const { data: input } = await db
      .from('ii_investment_date_inputs')
      .select('id, derived_transaction_id')
      .eq('user_id', userId)
      .eq('account_id', stmt.accountId)
      .eq('instrument_id', stmt.instrumentId)
      .eq('status', 'applied')
      .maybeSingle();
    const derivedId = (input as { derived_transaction_id?: string | null } | null)?.derived_transaction_id ?? null;
    if (!derivedId) continue;

    const { data: derived } = await db.from('ii_transactions').select('id, status, transaction_date').eq('id', derivedId).eq('user_id', userId).maybeSingle();
    const derivedRow = derived as { id: string; status: string; transaction_date: string } | null;
    if (!derivedRow || derivedRow.status === 'reversed') continue; // already out of the figures: nothing to ask

    const { data: existingCase } = await db
      .from('ii_reconciliation_cases')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'open')
      .contains('discrepancy_details', { derivedTransactionId: derivedId })
      .maybeSingle();
    if (existingCase) continue;

    const caseId = await openReconciliationCase(userId, {
      subjectType: 'transaction',
      subjectId: stmt.accountId,
      discrepancyType: 'cross_source_review_required',
      severity: CROSS_SOURCE_REVIEW_SEVERITY,
      sourceDocumentId,
      details: {
        kind: 'user_supplied_investment_date',
        rationale: 'A statement now carries the transactions for a holding whose investment date you typed in. Both are in your figures, so the units may be counted twice.',
        transactionDate: stmt.date,
        newTransactionId: stmt.id,
        derivedTransactionId: derivedId,
      },
      evidence: { comparedTransactionIds: [derivedId], newSourceDocumentId: sourceDocumentId, newTransactionId: stmt.id },
    });
    if (caseId) opened++;
  }
  return { opened };
}
