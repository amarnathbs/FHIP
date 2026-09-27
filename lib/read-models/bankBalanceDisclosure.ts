/**
 * D-04 disclosure: the part of the bank-balance evidence bucket that is
 * genuinely NOT in Net Worth -- the accounts whose statement balance has not
 * been applied as a cash asset (WP-15). Every "not in Net Worth" disclosure
 * (Dashboard notice, report appendix, report Net Worth notes) uses this one
 * rule. Client-safe: pure, type-only imports (the report preview renders the
 * appendix in the browser).
 *
 * Certification fix (2026-09-27, reproduced live on DEV): after the bank
 * balance was Applied as a cash asset, the Dashboard still said
 * "Bank balance per statement — not in Net Worth: $11,155" while Net Worth
 * already contained it through that asset -- inviting the reader to add it a
 * second time.
 */
import type { BankBalanceEvidence } from './assets';

export interface BankBalanceDisclosure {
  label: string;
  count: number;
  total: number;
}

export function bankBalancesNotInNetWorth(evidence: { label: string; accounts: readonly BankBalanceEvidence[] }): BankBalanceDisclosure | null {
  const open = evidence.accounts.filter((a) => a.inNetWorthAs === null);
  if (open.length === 0) return null;
  const total = open.reduce((s, a) => s + (a.closingBalance.amountReporting ?? 0), 0);
  return { label: evidence.label, count: open.length, total: Math.round(total * 100) / 100 };
}
