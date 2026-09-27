/**
 * D-04 disclosure: the part of the bank-balance evidence bucket that is
 * genuinely NOT in Net Worth -- the accounts whose statement balance has not
 * been applied as a cash asset (WP-15). Every "not in Net Worth" disclosure
 * (Dashboard notice, report appendix, report Net Worth notes) uses this one
 * rule. Client-safe: pure, type-only imports (the report preview renders the
 * appendix in the browser).
 *
 * Certification fix (2026-09-27, reproduced live on DEV by three certifiers:
 * economic oracles D3, scale/UI SUI-6, golden pair GP-D5): after the bank
 * balance was Applied as a cash asset, the Dashboard still said
 * "Bank balance per statement — not in Net Worth: $11,155" while Net Worth
 * already contained it through that asset -- inviting the reader to add it a
 * second time.
 *
 * Consolidation (stage 3): the open-only figures are computed ONCE, in the
 * assets read model (computeAssets: `total` / `notInNetWorthCount` cover only
 * accounts with inNetWorthAs === null). This helper is the one place the
 * consumers turn them into a disclosure, so the two can never disagree.
 */
import type { AssetsReadModelData } from './assets';

export interface BankBalanceDisclosure {
  label: string;
  count: number;
  total: number;
}

export function bankBalancesNotInNetWorth(
  evidence: Pick<AssetsReadModelData['bankBalanceEvidence'], 'label' | 'total' | 'notInNetWorthCount'>,
): BankBalanceDisclosure | null {
  if (evidence.notInNetWorthCount === 0) return null;
  return { label: evidence.label, count: evidence.notInNetWorthCount, total: evidence.total };
}
