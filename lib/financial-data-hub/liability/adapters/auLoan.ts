/**
 * FDH-10 — representative AU loan (home/personal/vehicle) CSV adapter (spec
 * section 31).
 *
 * One representative AU term-loan transaction-history export pattern
 * (Payment Date / Description / Amount / Type / Principal / Interest / Fee).
 * STATEMENT-EVIDENCED DECOMPOSITION ONLY (spec section 33): the
 * Principal/Interest/Fee columns are read verbatim from the file — this
 * adapter never derives a split from a rate/balance formula. A row with a
 * PAYMENT type but no principal/interest/fee columns populated correctly
 * yields `insufficient_evidence` downstream (`repaymentDecomposition.ts`),
 * never a guessed split.
 */

import type { LiabilityCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';
import type { LiabilityActivityType } from '../types';

export const AU_LOAN_GENERIC_V1: LiabilityCsvAdapter = {
  id: 'au_loan_generic_v1',
  country: 'AU',
  statementType: 'loan',
  facilityType: 'home_loan',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'AU home/personal/vehicle loan — generic transaction-history CSV export',
  signature: {
    requiredHeaders: ['Payment Date', 'Description', 'Amount', 'Type', 'Principal', 'Interest', 'Fee'],
    expectedColumnCount: 7,
  },
  columnMap: {
    date: 'Payment Date',
    description: 'Description',
    amount: 'Amount',
    activityType: 'Type',
    principalComponent: 'Principal',
    interestComponent: 'Interest',
    feeComponent: 'Fee',
    activityTypeAliases: {
      'repayment': 'PAYMENT' as LiabilityActivityType,
      'redraw': 'CASH_ADVANCE' as LiabilityActivityType,
      'drawdown': 'LOAN_ADVANCE' as LiabilityActivityType,
    },
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
