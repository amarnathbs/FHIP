/**
 * Field dispositions -- every FDH economic_transaction_type value and the ONE
 * read-model bucket it lands in (registry rule R9, EXP-G2). The gate test
 * checks each `bucket=` below against lib/read-models/core/spendingRules.ts
 * ECONOMIC_TYPE_BUCKET, so the documentation and the code cannot disagree.
 * Owner: WP-02.
 */
import { B, rows, type Row } from './build';
import type { RegistryFile } from './types';

const AT = 'Expenses > actual (imported) / Income > actual';

const TYPES: Row[] = [
  ['income', B, 'fdh_transactions(bucket=income)', AT, null, 'actual income (deduped against payslips, D-07)'],
  ['expense', B, 'fdh_transactions(bucket=spending)', AT, null, 'household consumption'],
  ['transfer', B, 'fdh_transactions(bucket=transfer)', AT, null, 'own-account movement / card or loan settlement: never income or expense'],
  ['investment', B, 'fdh_transactions(bucket=investment)', AT, null, 'money invested: spending 0'],
  ['debt_principal', B, 'fdh_transactions(bucket=debt_principal)', AT, null, 'liability reduction: not an expense; counted in debt service'],
  ['debt_interest', B, 'fdh_transactions(bucket=spending)', AT, null, 'spending on a bank account; cost_of_debt on a card/loan facility (D-09)'],
  ['refund', B, 'fdh_transactions(bucket=refund)', AT, null, 'nets spending ONLY with a confirmed refund_original link (D-01)'],
  ['asset_purchase', B, 'fdh_transactions(bucket=asset_purchase)', AT, null, 'wealth movement: spending 0'],
  ['asset_sale', B, 'fdh_transactions(bucket=asset_sale)', AT, null, 'wealth movement: ordinary income 0'],
  ['tax', B, 'fdh_transactions(bucket=spending)', AT, null, 'tax paid'],
  ['fee', B, 'fdh_transactions(bucket=spending)', AT, null, 'spending on a bank account; cost_of_debt on a card/loan facility (D-09)'],
  ['cash_withdrawal', B, 'fdh_transactions(bucket=cash_withdrawal)', AT, null, 'Cash — spending unknown (D-03)'],
  ['unknown', B, 'fdh_transactions(bucket=unknown)', AT, null, 'never counted and never categorised until the user decides'],
];

export const economicTransactionTypeRegistry: RegistryFile = {
  id: 'economicTransactionType',
  ownerWp: 'WP-02',
  OPEN_GAP_CEILING: 0,
  entries: rows('economic_type', 'enum_value', 'enum:FDH_ECONOMIC_TRANSACTION_TYPES', TYPES),
};
