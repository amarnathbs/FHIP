// Document2 (4) WP-H -- a configurable synthetic CAMS consolidated statement (multi folio, multi transaction), in the same structural
// shape as buildAieIiCasFixtureText (which has one folio and one transaction). Every value is invented.

export interface WphTxn {
  date: string; // 10-Jan-2025
  amount: string; // 5,000.00
  price: string; // 50.0000
  units: string; // 100.000
  balance: string; // running unit balance after this line
  ref: string;
  type?: string;
}

export interface WphFolio {
  folio: string;
  amc: string;
  scheme: string;
  isin: string;
  holderName?: string;
  txns: WphTxn[];
  closingDate: string;
  closingUnits: string;
  closingValue: string;
  closingNav: string;
}

export function buildWphCas(opts: { periodStart: string; periodEnd: string; folios: WphFolio[] }): string {
  const lines: string[] = ['CAMS Consolidated Account Statement', `Statement Period : ${opts.periodStart} To ${opts.periodEnd}`, ''];
  for (const f of opts.folios) {
    lines.push(
      `Folio No: ${f.folio}`,
      'PAN: AAAAA1111A',
      ...(f.holderName ? [`Name: ${f.holderName}`] : []),
      '',
      f.amc,
      `${f.scheme} - ISIN: ${f.isin}(Advisor: ARN00001) Registrar : CAMS`,
      '',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      ...f.txns.map((t) => `${t.date}   ${t.amount}         ${t.price}      ${t.units}     ${t.type ?? 'Purchase'}                             ${t.balance}   [Ref: ${t.ref}]`),
      '',
      `Closing Unit Balance as on ${f.closingDate} : ${f.closingUnits} Units   Valuation : Rs. ${f.closingValue}   NAV as on ${f.closingDate} : Rs. ${f.closingNav}`,
      '',
    );
  }
  return lines.join('\n');
}

/** Folio 1122334455, Prime Flexi Cap: two purchases by 31-Mar-2025 (150 units, NAV 52.00, value 7,800.00). */
export const PRIME_FOLIO_Q1: WphFolio = {
  folio: '1122334455',
  amc: 'Prime Mutual Fund',
  scheme: 'Prime Flexi Cap Fund - Growth (Direct Plan)',
  isin: 'INF999K01AB1',
  holderName: 'Asha Rao',
  txns: [
    { date: '10-Jan-2025', amount: '5,000.00', price: '50.0000', units: '100.000', balance: '100.000', ref: 'WPH-001' },
    { date: '10-Feb-2025', amount: '2,500.00', price: '50.0000', units: '50.000', balance: '150.000', ref: 'WPH-002' },
  ],
  closingDate: '31-Mar-2025',
  closingUnits: '150.000',
  closingValue: '7,800.00',
  closingNav: '52.00',
};

/** The same folio carried forward one month: one more purchase on 10-Apr-2025, closing 200 units on 30-Apr-2025 at NAV 53.00 (10,600.00). */
export const PRIME_FOLIO_APR: WphFolio = {
  ...PRIME_FOLIO_Q1,
  txns: [...PRIME_FOLIO_Q1.txns, { date: '10-Apr-2025', amount: '2,650.00', price: '53.0000', units: '50.000', balance: '200.000', ref: 'WPH-003' }],
  closingDate: '30-Apr-2025',
  closingUnits: '200.000',
  closingValue: '10,600.00',
  closingNav: '53.00',
};

/** A different fund house and folio, for "unrelated statement" controls. */
export const OTHER_FOLIO: WphFolio = {
  folio: '9988776655',
  amc: 'Zenith Mutual Fund',
  scheme: 'Zenith Bluechip Fund - Growth (Direct Plan)',
  isin: 'INF888K01ZZ9',
  holderName: 'Asha Rao',
  txns: [{ date: '15-Jun-2023', amount: '10,000.00', price: '100.0000', units: '100.000', balance: '100.000', ref: 'WPH-OTH-001' }],
  closingDate: '31-Mar-2024',
  closingUnits: '100.000',
  closingValue: '11,000.00',
  closingNav: '110.00',
};
