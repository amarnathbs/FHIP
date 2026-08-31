/**
 * FDH-11 — Australia investment CSV adapter registry (spec sections 15-16).
 */

import { AU_GENERIC_TRANSACTION_CSV, AU_GENERIC_PORTFOLIO_CSV } from './auGenericCsv';
import type { AuInvestmentCsvAdapter } from './types';

export const AU_INVESTMENT_CSV_ADAPTER_REGISTRY: readonly AuInvestmentCsvAdapter[] = [
  AU_GENERIC_TRANSACTION_CSV,
  AU_GENERIC_PORTFOLIO_CSV,
];

export function getAuInvestmentAdapterById(id: string): AuInvestmentCsvAdapter | null {
  return AU_INVESTMENT_CSV_ADAPTER_REGISTRY.find((a) => a.id === id) ?? null;
}

export function certifiedAuInvestmentAdapterCount(): number {
  return AU_INVESTMENT_CSV_ADAPTER_REGISTRY.filter((a) => a.coverageState === 'certified').length;
}

export { AU_GENERIC_TRANSACTION_CSV, AU_GENERIC_PORTFOLIO_CSV };
export type { AuInvestmentCsvAdapter } from './types';
