/**
 * FDH-10 — representative AU credit-card CSV adapter (spec section 29).
 *
 * One representative, structurally-plausible AU credit-card transaction
 * export pattern (Transaction Date / Description / Amount / Transaction
 * Type columns — the same shape R7's own AU bank adapters use for their
 * simplest single-signed-amount format, here with an added activity-type
 * column since a card statement's PURCHASE/PAYMENT/INTEREST/FEE/
 * CASH_ADVANCE/REFUND distinction is not inferable from sign alone). NOT a
 * certification of any one named issuer's current real export format — see
 * this directory's `types.ts` header for the full disclosure.
 *
 * Balance/limit/period metadata (opening/closing balance, credit limit,
 * minimum payment, statement dates, due date) is USER-DECLARED at upload
 * time, matching the exact precedent R7's bank-CSV upload already
 * established for `statement_period_start`/`statement_period_end` — most
 * real card CSV exports are a transaction listing only, with the summary
 * figures on a separate PDF/portal page, not a CSV column.
 */

import type { LiabilityCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';
import type { LiabilityActivityType } from '../types';

export const AU_CREDIT_CARD_GENERIC_V1: LiabilityCsvAdapter = {
  id: 'au_credit_card_generic_v1',
  country: 'AU',
  statementType: 'credit_card',
  facilityType: 'credit_card',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'AU credit card — generic transaction CSV export',
  signature: {
    requiredHeaders: ['Transaction Date', 'Description', 'Amount', 'Transaction Type'],
    optionalHeaders: ['Merchant'],
    expectedColumnCount: 4,
  },
  columnMap: {
    date: 'Transaction Date',
    description: 'Description',
    amount: 'Amount',
    activityType: 'Transaction Type',
    merchant: 'Merchant',
    activityTypeAliases: {
      'cash advance': 'CASH_ADVANCE' as LiabilityActivityType,
      'interest charged': 'INTEREST' as LiabilityActivityType,
      'annual fee': 'FEE' as LiabilityActivityType,
      'late fee': 'FEE' as LiabilityActivityType,
    },
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
