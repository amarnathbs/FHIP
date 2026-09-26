/**
 * Field dispositions -- every FDH-10 statement ACTIVITY TYPE and the canonical
 * ledger event it must become on Apply (G1, the mandatory gate). Owner: WP-11,
 * which flips these to compliant as the ledger Apply lands.
 *
 * Card purchases $200 + $20 and a $220 repayment -> household expense $220.
 * Loan payment $2,000 = principal $1,550 + interest $430 + fee $20 -> cost of
 * debt $450, debt service $2,000 (lib/read-models, D-08 / D-09).
 */
import { B, gap, rows, type Row } from './build';
import type { RegistryFile } from './types';

const G1 = gap('G1', 'P0', 'WP-11');
const G5 = gap('G5', 'P1', 'WP-11');

const TYPES: Row[] = [
  ['PURCHASE', B, 'fdh_transactions(card facility debit, type=expense, R8-categorised)', null, G1, 'household consumption'],
  ['REFUND', B, 'fdh_transactions(card facility credit, type=refund; optional refund_original link)', null, G1, 'nets spending only with a confirmed link (D-01)'],
  ['PAYMENT', B, 'fdh_transactions(facility credit, type=transfer) + fdh_transaction_links(credit_card_settlement | loan_payment, confirmed)', null, G1, 'settlement: expense 0; a loan payment carries principal/interest/fee allocations'],
  ['CASH_ADVANCE', B, 'fdh_transactions(facility debit, type=cash_withdrawal)', null, G1, 'not consumption: Cash — spending unknown'],
  ['INTEREST', B, 'fdh_transactions(facility debit, type=debt_interest)', null, G1, 'cost of debt, counted once via debt service (D-09)'],
  ['FEE', B, 'fdh_transactions(facility debit, type=fee)', null, G1, 'cost of debt, counted once via debt service (D-09)'],
  ['PRINCIPAL', B, 'fdh_transactions(loan credit, type=debt_principal)', null, G1, 'liability reduction, not an expense'],
  ['LOAN_ADVANCE', B, 'fdh_transactions(loan debit, type=transfer)', null, G1, 'a drawdown is never income'],
  ['ADJUSTMENT', B, 'fdh_transactions(after the user resolves it; Apply is blocked until then)', null, G5, 'must be resolved by the user, else rejected with a reason'],
  ['OTHER', B, 'fdh_transactions(after the user resolves it; Apply is blocked until then)', null, G5, 'must be resolved by the user, else rejected with a reason'],
];

export const liabilityActivityLedgerRegistry: RegistryFile = {
  id: 'liabilityActivityLedger',
  ownerWp: 'WP-11',
  OPEN_GAP_CEILING: 10,
  entries: rows('liability_ledger', 'enum_value', 'enum:LIABILITY_ACTIVITY_TYPES', TYPES),
};
