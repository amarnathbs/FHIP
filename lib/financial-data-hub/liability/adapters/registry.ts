import type { LiabilityCsvAdapter } from './types';
import { AU_CREDIT_CARD_GENERIC_V1 } from './auCreditCard';
import { IN_CREDIT_CARD_GENERIC_V1 } from './inCreditCard';
import { AU_LOAN_GENERIC_V1 } from './auLoan';
import { IN_LOAN_EMI_GENERIC_V1 } from './inLoanEmi';

/** FDH-10's adapter registry (spec sections 28-32). Mirrors
 * `BANK_CSV_ADAPTER_REGISTRY`'s role exactly: the one place every certified
 * (or experimental) statement-format pattern is listed for detection. */
export const LIABILITY_CSV_ADAPTER_REGISTRY: readonly LiabilityCsvAdapter[] = [
  AU_CREDIT_CARD_GENERIC_V1,
  IN_CREDIT_CARD_GENERIC_V1,
  AU_LOAN_GENERIC_V1,
  IN_LOAN_EMI_GENERIC_V1,
];

export { AU_CREDIT_CARD_GENERIC_V1, IN_CREDIT_CARD_GENERIC_V1, AU_LOAN_GENERIC_V1, IN_LOAN_EMI_GENERIC_V1 };
