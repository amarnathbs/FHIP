/**
 * Field dispositions -- every FDH-10 statement ACTIVITY TYPE and the canonical
 * ledger event it becomes on Apply (G1, the mandatory gate). Owner: WP-11.
 *
 * CLOSED by WP-11 (migration 0209, fdh10_apply_liability_proposal): one
 * approved fdh_transactions row per activity on the card/loan facility
 * account, in the same transaction as the liability update; a loan payment
 * with disclosed components carries allocations; a matched repayment gets a
 * confirmed settlement link and its bank leg becomes a transfer. Proven on real
 * Postgres by tests/unit/fdh10ApplyLedgerPglite.test.ts:
 * card purchases $200 + $20 and a $220 repayment -> household expense $220;
 * loan payment $2,000 = principal $1,550 + interest $430 + fee $20 -> cost of
 * debt $450, debt service $2,000 (lib/read-models, D-08 / D-09).
 */
import { B, E, rows, type Row } from './build';
import type { RegistryFile } from './types';

const HISTORY = 'Liabilities tab → Statement history';
const UNCLASSIFIED = 'not counted: fdh_liability_statement_activities.ledger_disposition = excluded_unclassified (Apply is BLOCKING_REVIEW until the user acknowledges it)';

const TYPES: Row[] = [
  ['PURCHASE', B, 'fdh_transactions(card facility debit, type=expense, R8-categorised)', HISTORY, null, 'household consumption'],
  ['REFUND', B, 'fdh_transactions(card facility credit, type=refund; optional refund_original link)', HISTORY, null, 'nets spending only with a confirmed link (D-01)'],
  ['PAYMENT', B, 'fdh_transactions(facility credit, type=transfer) + fdh_transaction_links(credit_card_settlement | loan_payment, confirmed)', HISTORY, null, 'settlement: expense 0; a loan payment carries principal/interest/fee allocations'],
  ['CASH_ADVANCE', B, 'fdh_transactions(facility debit, type=cash_withdrawal)', HISTORY, null, 'not consumption: Cash — spending unknown'],
  ['INTEREST', B, 'fdh_transactions(facility debit, type=debt_interest)', HISTORY, null, 'cost of debt, counted once via debt service (D-09)'],
  ['FEE', B, 'fdh_transactions(facility debit, type=fee)', HISTORY, null, 'cost of debt, counted once via debt service (D-09)'],
  ['PRINCIPAL', B, 'fdh_transactions(loan credit, type=debt_principal)', HISTORY, null, 'liability reduction, not an expense'],
  ['LOAN_ADVANCE', B, 'fdh_transactions(loan debit, type=transfer)', HISTORY, null, 'a drawdown is never income'],
  ['ADJUSTMENT', E, UNCLASSIFIED, `${HISTORY} ("Not counted — we cannot tell what it is")`, null, 'never guessed; the statement balance still carries it'],
  ['OTHER', E, UNCLASSIFIED, `${HISTORY} ("Not counted — we cannot tell what it is")`, null, 'never guessed'],
];

export const liabilityActivityLedgerRegistry: RegistryFile = {
  id: 'liabilityActivityLedger',
  ownerWp: 'WP-11',
  OPEN_GAP_CEILING: 0,
  entries: rows('liability_ledger', 'enum_value', 'enum:LIABILITY_ACTIVITY_TYPES', TYPES),
};
