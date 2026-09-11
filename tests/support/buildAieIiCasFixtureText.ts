// AIE-1.2 — synthetic CAMS CAS fixture text, in the same structural shape
// existing Investment Intelligence unit tests already use (e.g.
// tests/unit/iiCamsReversedPurchasePairReclassification.test.ts's own
// `buildText()`). Every value below (folio, PAN, ISIN, amounts, dates) is
// invented — reproduces only the structural shape a real CAMS Consolidated
// Account Statement prints, never real statement content.

export interface CasFixtureOptions {
  folioNumber?: string;
  isin?: string;
  amcName?: string;
  schemeName?: string;
  transactionDate?: string;
  amount?: string;
  price?: string;
  units?: string;
  transactionTypeText?: string;
  sourceRef?: string;
  closingDate?: string;
  closingUnits?: string;
  closingValue?: string;
  closingNav?: string;
}

const DEFAULTS: Required<CasFixtureOptions> = {
  folioNumber: '1122334455',
  isin: 'INF999K01AB1',
  amcName: 'Prime Mutual Fund',
  schemeName: 'Prime Flexi Cap Fund - Growth (Direct Plan)',
  transactionDate: '10-Jan-2025',
  amount: '5,000.00',
  price: '50.0000',
  units: '100.000',
  transactionTypeText: 'Purchase',
  sourceRef: 'AIE-FIX-001',
  closingDate: '31-Mar-2025',
  closingUnits: '100.000',
  closingValue: '5,200.00',
  closingNav: '52.00',
};

/** A single-folio, single-scheme, single-transaction CAS statement that
 * parses cleanly (zero errors/warnings) via the real `camsParser`. */
export function buildAieIiCasFixtureText(opts: CasFixtureOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  return [
    'CAMS Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 31-Mar-2025',
    '',
    `Folio No: ${o.folioNumber}`,
    'PAN: AAAAA1111A',
    '',
    o.amcName,
    `${o.schemeName} - ISIN: ${o.isin}(Advisor: ARN00001) Registrar : CAMS`,
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    `${o.transactionDate}   ${o.amount}         ${o.price}      ${o.units}     ${o.transactionTypeText}                             ${o.units}   [Ref: ${o.sourceRef}]`,
    '',
    `Closing Unit Balance as on ${o.closingDate} : ${o.closingUnits} Units   Valuation : Rs. ${o.closingValue}   NAV as on ${o.closingDate} : Rs. ${o.closingNav}`,
  ].join('\n');
}

/** A document with no recognisable CAS/KFintech/Folio-statement structure
 * at all — every registered parser's own `canHandle` should score this at
 * (or near) zero confidence. */
export function buildUnsupportedDocumentText(): string {
  return ['Certificate of Insurance', 'Policy Number: XYZ-000-111', 'Sum Insured: 500,000', 'This document is not a statement of any kind.'].join('\n');
}
