/**
 * WP-11: the words a user reads for what each card/loan statement line
 * becomes, shared by the import panel (before Apply) and Statement history
 * (after Apply). Pure, client-safe; mirrors the ledger mapping the Apply RPC
 * writes (migration 0209 / LIABILITY_LEDGER_MAPPING) -- a test holds the two
 * together (tests/unit/fdh10LiabilityLedgerUi.test.tsx).
 */

export const ACTIVITY_LEDGER_OUTCOME: Record<string, { label: string; counts: string }> = {
  PURCHASE: { label: 'Card purchase', counts: 'Counted as spending' },
  REFUND: { label: 'Refund', counts: 'Reduces spending only when linked to the purchase it refunds' },
  PAYMENT: { label: 'Repayment', counts: 'A transfer from your bank account — never spending' },
  CASH_ADVANCE: { label: 'Cash advance / redraw', counts: 'Cash — spending unknown (not counted as spending)' },
  INTEREST: { label: 'Interest', counts: 'Cost of debt — counted once, in your debt repayments' },
  FEE: { label: 'Fee', counts: 'Cost of debt — counted once, in your debt repayments' },
  PRINCIPAL: { label: 'Principal repaid', counts: 'Reduces what you owe — not spending' },
  LOAN_ADVANCE: { label: 'Drawdown', counts: 'Money borrowed — never income' },
  ADJUSTMENT: { label: 'Adjustment', counts: 'Not counted — we cannot tell what it is' },
  OTHER: { label: 'Other', counts: 'Not counted — we cannot tell what it is' },
};

/** What a decomposed loan repayment's parts mean. */
export const ALLOCATION_LABELS: Record<string, string> = {
  debt_principal: 'Principal (reduces what you owe)',
  debt_interest: 'Interest (cost of debt)',
  fee: 'Fee (cost of debt)',
};

export const LEDGER_DISPOSITION_LABELS: Record<string, string> = {
  ledger_row: 'Recorded',
  duplicate_of_existing: 'Already recorded from an earlier statement — not counted twice',
  excluded_unclassified: 'Not counted (you confirmed we could not tell what it is)',
  rejected: 'Not counted — you rejected this statement',
};

export const BLOCKER_LABELS: Record<string, string> = {
  unclassified_line: 'An adjustment or unrecognised line — confirm it will not be counted',
  multiple_bank_candidates: 'Several bank payments could be this repayment — choose one',
  component_mismatch: 'The principal, interest and fee on this repayment do not add up to the amount paid',
  foreign_transaction: 'This repayment is matched to a bank transaction that is not yours',
  bank_match_invalid: 'The matched bank payment does not match this repayment in amount, currency or direction',
};

export const OWNER_CHOICES: Array<{ value: 'self' | 'spouse' | 'joint' | 'smsf'; label: string }> = [
  { value: 'self', label: 'Me' },
  { value: 'spouse', label: 'My spouse / partner' },
  { value: 'joint', label: 'Joint' },
  { value: 'smsf', label: 'My SMSF' },
];

const WARNING_COPY: Record<string, string> = {
  zero_amount: 'A $0.00 line was left out (it moves no money).',
  unrecognised_activity_type: 'A line with a type we do not recognise was left out.',
  unparseable_date: 'A line with an unreadable date was left out.',
  unparseable_amount: 'A line with an unreadable amount was left out.',
  adjustment_direction_unknown: 'The statement has adjustment lines whose direction we could not tell, so its balance could not be checked.',
  adjustment_sign_inferred_from_balance: 'The direction of the adjustment lines was taken from the statement balance.',
  ai_opening_balance_not_printed_dropped: 'The opening balance was not printed on the statement, so it was not used.',
  ai_closing_balance_not_printed_dropped: 'The closing balance was not printed on the statement, so it was not used.',
};

/** One sentence for a persisted extraction warning ({code, row?, detail?}). Never empty. */
export function describeExtractionWarning(w: { code: string; row?: number; detail?: string }): string {
  const base = WARNING_COPY[w.code]
    ?? (w.code.startsWith('other_activity_not_in_totals') ? 'Some lines of type "Other" are not included in the statement totals.' : null)
    ?? (w.code.startsWith('ai_') ? 'The AI-read draft raised a note on this statement.' : 'The statement raised a note while it was being read.');
  const where = w.row !== undefined ? ` (row ${w.row}${w.detail ? `: "${w.detail}"` : ''})` : '';
  return `${base}${where}`;
}
