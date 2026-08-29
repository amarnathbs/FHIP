/**
 * FDH-10 — representative India credit-card CSV adapter (spec section 30).
 *
 * One representative India credit-card transaction export pattern (Txn
 * Date / Narration / Amount (INR) / Txn Type — with an optional GST column,
 * common on Indian card statements). GST is preserved as EVIDENCE ONLY —
 * carried verbatim on the activity as `gstAmountRaw`, never parsed as an
 * amount and never summed into any FHIP tax or expense figure (spec section
 * 30: "GST may be preserved as evidence, no GST tax engine"). NOT a
 * certification of any one named issuer's current real export format — see
 * this directory's `types.ts` header.
 *
 * "Minimum amount due" and "total amount due" are the same USER-DECLARED
 * upload metadata as `minimumPayment`/`closingBalance` (see
 * `auCreditCard.ts`'s header for why balance/limit figures are declared, not
 * parsed from a transaction-only CSV).
 */

import type { LiabilityCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';
import type { LiabilityActivityType } from '../types';

export const IN_CREDIT_CARD_GENERIC_V1: LiabilityCsvAdapter = {
  id: 'in_credit_card_generic_v1',
  country: 'IN',
  statementType: 'credit_card',
  facilityType: 'credit_card',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'India credit card — generic transaction CSV export',
  signature: {
    requiredHeaders: ['Txn Date', 'Narration', 'Amount (INR)', 'Txn Type'],
    optionalHeaders: ['GST'],
    expectedColumnCount: 4,
  },
  columnMap: {
    date: 'Txn Date',
    description: 'Narration',
    amount: 'Amount (INR)',
    activityType: 'Txn Type',
    gstAmount: 'GST',
    activityTypeAliases: {
      'finance charge': 'INTEREST' as LiabilityActivityType,
      'cash withdrawal': 'CASH_ADVANCE' as LiabilityActivityType,
      'atm withdrawal': 'CASH_ADVANCE' as LiabilityActivityType,
      'annual membership fee': 'FEE' as LiabilityActivityType,
      'late payment fee': 'FEE' as LiabilityActivityType,
      // A standalone "GST" line (as opposed to GST embedded, evidence-only,
      // in the optional `GST` column alongside a fee row) is itself a real
      // government-levy cash cost on the statement — treated as FEE, never
      // as a tax the FHIP tax engine computes or reconciles (spec section
      // 30: "GST may be preserved as evidence, no GST tax engine").
      'gst': 'FEE' as LiabilityActivityType,
    },
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
