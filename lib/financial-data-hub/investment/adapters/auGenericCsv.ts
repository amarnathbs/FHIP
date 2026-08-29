/**
 * FDH-11 — the two CERTIFIED generic AU investment CSV layouts (spec
 * sections 15-16). Broker-neutral (`institutionCode: null`) — this is a
 * documented, explicit column-name contract, not a claim to recognise any
 * specific real broker's actual export. See
 * `docs/financial-data-hub/FDH11_AU_BROKER_ADAPTERS.md` for the exact
 * column-name contract and the honest coverage matrix for named AU brokers.
 */

import { scoreHeaderAgainstSignature, type AuInvestmentCsvAdapter } from './types';

export const AU_GENERIC_TRANSACTION_CSV: AuInvestmentCsvAdapter = {
  id: 'au_generic_investment_transaction_csv_v1',
  institutionCode: null,
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic AU investment transaction CSV',
  statementType: 'investment_transaction_csv',
  csvKind: 'transaction',
  signature: {
    requiredHeaders: ['Date', 'Type', 'Amount'],
    optionalHeaders: ['Code', 'ISIN', 'Security Name', 'Quantity', 'Price', 'Brokerage', 'Settlement Date'],
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

export const AU_GENERIC_PORTFOLIO_CSV: AuInvestmentCsvAdapter = {
  id: 'au_generic_portfolio_csv_v1',
  institutionCode: null,
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic AU portfolio/holdings CSV',
  statementType: 'portfolio_csv',
  csvKind: 'portfolio',
  signature: {
    requiredHeaders: ['Security Name', 'Quantity'],
    optionalHeaders: ['Code', 'ISIN', 'Price', 'Market Value', 'Valuation Date'],
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
