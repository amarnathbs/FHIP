// Probable duplicates between a statement entry and a manual entry
// (Document2 defect D-5, PO decision 2026-10-03). PURE: no I/O.
//
// THE RULE (replaces the R11 "conflict parks the new row" rule):
//
//   Never block mutual-fund analysis because two entries MAY overlap.
//   Both are used, as the user entered them. A probable duplicate is
//   HIGHLIGHTED (a non-blocking review item) and the USER decides:
//     1. keep both as they are
//     2. accept the statement and remove my manual entry
//     3. reject the statement entry
//   Nothing in the user's data changes until they confirm, and a removal is a
//   soft, audited, reversible status change ('reversed', the same exclusion
//   every analytics reader already applies), never a delete.
//
// What the OLD behaviour did, which this replaces:
//   - inserted the new row with status 'review_required' (excluded from every
//     R4/R5/R6 aggregation, so analysis silently lost it until a human acted);
//   - opened the case at severity 'high', which documentProcessing's
//     certification query counts as BLOCKING, so the account's positions could
//     not certify while the case was open.
// Detection (crossSourceIdentity.ts) is unchanged and still opens the case.

export const CROSS_SOURCE_REVIEW_TYPES = ['cross_source_conflict', 'cross_source_review_required'] as const;
export type CrossSourceReviewType = (typeof CROSS_SOURCE_REVIEW_TYPES)[number];

/** 'medium' is below the certification-blocking set ('blocking' | 'high'). Never raise it to 'high'. */
export const CROSS_SOURCE_REVIEW_SEVERITY = 'medium' as const;

/** The status a candidate row is inserted with even when it may be a duplicate: counted, not parked. */
export const CROSS_SOURCE_INSERT_STATUS = 'parsed' as const;

export function isCrossSourceReviewType(t: string | null | undefined): t is CrossSourceReviewType {
  return typeof t === 'string' && (CROSS_SOURCE_REVIEW_TYPES as readonly string[]).includes(t);
}

/**
 * Open reconciliation cases that may block certification. A probable
 * duplicate is detected and shown but is never one of them.
 */
export function filterCertificationBlockingCases<T extends { discrepancy_type: string | null }>(cases: readonly T[]): T[] {
  return cases.filter((c) => !isCrossSourceReviewType(c.discrepancy_type));
}

// ---------------------------------------------------------------------------
// Which side is the statement and which is the manual entry
// ---------------------------------------------------------------------------
export type TransactionOrigin = 'manual' | 'statement';

/** A row with no source document, or one from a 'manual_entry_record' document, was typed by the user (or derived from what they typed). */
export function classifyTransactionOrigin(documentType: string | null | undefined, sourceDocumentId: string | null | undefined): TransactionOrigin {
  if (!sourceDocumentId) return 'manual';
  return documentType === 'manual_entry_record' ? 'manual' : 'statement';
}

// ---------------------------------------------------------------------------
// The user's decision, planned as explicit status changes
// ---------------------------------------------------------------------------
export type CrossSourceDecision =
  | 'keep_both'
  | 'accept_statement_remove_manual'
  | 'reject_statement'
  // Legacy names (Document2 closure #4, 2026-09-30), still accepted so an old client keeps working.
  | 'confirmed_duplicate'
  | 'confirmed_distinct';

export const CROSS_SOURCE_DECISIONS: readonly CrossSourceDecision[] = ['keep_both', 'accept_statement_remove_manual', 'reject_statement', 'confirmed_duplicate', 'confirmed_distinct'];

export interface PairTransaction {
  id: string;
  origin: TransactionOrigin;
  status: string;
}

export interface CrossSourcePair {
  /** The row the case was opened for (the newer entry). */
  subject: PairTransaction;
  /** The existing row it may duplicate. Null on a legacy case that never recorded one: only the decisions that need no counterpart can be planned then. */
  counterpart: PairTransaction | null;
  /** 'user_supplied_investment_date' = the manual side is a derived purchase from an investment date the user typed (D-3). */
  kind?: 'standard' | 'user_supplied_investment_date';
}

export interface PlannedChange {
  transactionId: string;
  from: string;
  to: string;
}

export type DecisionPlan =
  | { ok: true; changes: PlannedChange[]; resolutionMethod: string }
  | { ok: false; code: 'not_statement_vs_manual' | 'option_not_offered'; message: string };

const COUNTED_STATUSES = new Set(['parsed', 'reconciled', 'corrected', 'review_required']);

function restore(t: PairTransaction): PlannedChange[] {
  // A legacy row parked as 'review_required' is brought back into analysis by any decision that keeps it.
  return t.status === 'review_required' ? [{ transactionId: t.id, from: 'review_required', to: 'parsed' }] : [];
}

function softRemove(t: PairTransaction): PlannedChange[] {
  return COUNTED_STATUSES.has(t.status) ? [{ transactionId: t.id, from: t.status, to: 'reversed' }] : [];
}

function splitBySide(pair: CrossSourcePair): { manual: PairTransaction; statement: PairTransaction } | null {
  if (!pair.counterpart) return null;
  const both = [pair.subject, pair.counterpart];
  const manual = both.filter((t) => t.origin === 'manual');
  const statement = both.filter((t) => t.origin === 'statement');
  if (manual.length === 1 && statement.length === 1) return { manual: manual[0], statement: statement[0] };
  return null;
}

/**
 * Turns the user's decision into the exact status changes it implies. Pure,
 * so the three options are provable without a database: what each one changes,
 * and that 'keep both' changes nothing the user did not already have.
 */
export function planCrossSourceDecision(decision: CrossSourceDecision, pair: CrossSourcePair): DecisionPlan {
  switch (decision) {
    case 'keep_both':
      return { ok: true, changes: [...restore(pair.subject), ...(pair.counterpart ? restore(pair.counterpart) : [])], resolutionMethod: 'user_kept_both' };
    case 'confirmed_distinct':
      return { ok: true, changes: [...restore(pair.subject), ...(pair.counterpart ? restore(pair.counterpart) : [])], resolutionMethod: 'user_classified_transaction' };
    case 'confirmed_duplicate':
      // Legacy "same transaction": the newer entry is the surplus one. A legacy row already parked stays parked.
      return { ok: true, changes: pair.subject.status === 'review_required' ? [] : softRemove(pair.subject), resolutionMethod: 'user_resolved_duplicate' };
    case 'accept_statement_remove_manual': {
      const sides = splitBySide(pair);
      if (!sides) return { ok: false, code: 'not_statement_vs_manual', message: 'This choice only applies when one entry came from a statement and the other is your own manual entry.' };
      return { ok: true, changes: [...softRemove(sides.manual), ...restore(sides.statement)], resolutionMethod: 'user_accepted_statement_removed_manual' };
    }
    case 'reject_statement': {
      const sides = splitBySide(pair);
      if (!sides) return { ok: false, code: 'not_statement_vs_manual', message: 'This choice only applies when one entry came from a statement and the other is your own manual entry.' };
      if (pair.kind === 'user_supplied_investment_date') {
        return { ok: false, code: 'option_not_offered', message: 'This statement covers the whole history, so it cannot be rejected as a single entry. Keep both, or accept the statement and remove the investment date you added.' };
      }
      return { ok: true, changes: [...softRemove(sides.statement), ...restore(sides.manual)], resolutionMethod: 'user_rejected_statement' };
    }
  }
}

/** The undo of an applied decision: each recorded change reversed, but only where the row is still in the state the decision left it. */
export function planUndo(applied: readonly PlannedChange[], currentStatusById: ReadonlyMap<string, string>): PlannedChange[] {
  return applied
    .filter((c) => currentStatusById.get(c.transactionId) === c.to)
    .map((c) => ({ transactionId: c.transactionId, from: c.to, to: c.from }));
}

/** Plain-language option copy, one source for the UI and the tests. */
export const CROSS_SOURCE_OPTION_COPY: Record<'keep_both' | 'accept_statement_remove_manual' | 'reject_statement', { label: string; effect: string }> = {
  keep_both: {
    label: 'Keep both as they are',
    effect: 'Nothing changes. Both entries stay in your figures, so if they are the same purchase it is counted twice.',
  },
  accept_statement_remove_manual: {
    label: 'Accept the statement and remove my manual entry',
    effect: 'Your manual entry is taken out of your figures. It is kept on record and you can bring it back.',
  },
  reject_statement: {
    label: 'Reject the statement entry',
    effect: 'The statement entry is taken out of your figures and your manual entry stays. It is kept on record and you can bring it back.',
  },
};
