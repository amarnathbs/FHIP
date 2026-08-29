/**
 * FDH-10 — representative India EMI loan CSV adapter (spec section 32).
 *
 * One representative India EMI (personal/vehicle/home) loan transaction
 * export pattern (EMI Date / Description / EMI Amount / Type / Principal
 * Component / Interest Component). Indian EMI statements commonly disclose
 * the principal/interest split per instalment directly (an "amortisation
 * schedule" table) — read verbatim, never re-derived (spec section 33).
 */

import type { LiabilityCsvAdapter } from './types';
import { scoreHeaderAgainstSignature } from './types';
import type { LiabilityActivityType } from '../types';

export const IN_LOAN_EMI_GENERIC_V1: LiabilityCsvAdapter = {
  id: 'in_loan_emi_generic_v1',
  country: 'IN',
  statementType: 'loan',
  facilityType: 'personal_loan',
  version: '1.0.0',
  certificationState: 'certified',
  displayName: 'India EMI loan — generic amortisation-schedule CSV export',
  signature: {
    requiredHeaders: ['EMI Date', 'Description', 'EMI Amount', 'Type', 'Principal Component', 'Interest Component'],
    expectedColumnCount: 6,
  },
  columnMap: {
    date: 'EMI Date',
    description: 'Description',
    amount: 'EMI Amount',
    activityType: 'Type',
    principalComponent: 'Principal Component',
    interestComponent: 'Interest Component',
    activityTypeAliases: {
      'emi': 'PAYMENT' as LiabilityActivityType,
      'emi payment': 'PAYMENT' as LiabilityActivityType,
      'disbursement': 'LOAN_ADVANCE' as LiabilityActivityType,
      'processing fee': 'FEE' as LiabilityActivityType,
      'foreclosure charge': 'FEE' as LiabilityActivityType,
      'prepayment charge': 'FEE' as LiabilityActivityType,
    },
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
