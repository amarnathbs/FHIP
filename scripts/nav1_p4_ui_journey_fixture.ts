// NAV 1 completion (2026-09-27), brief P4 -- the synthetic genuine-format CAMS
// statement pack for the 18-point UI journey.
//
// WHY A NEW PACK. The PC3 qualification fixtures pair real AMFI codes with the
// WRONG scheme names and ISINs (e.g. pc3-q07 says "HDFC Flexi Cap Fund ...
// ISIN INF179K01YW8, AMFI Code 118834", but AMFI 118834 is Mirae Asset Large &
// Midcap Fund - Direct, ISIN INF769K01BI1; 103504 is SBI Large Cap Fund with
// ISIN INF200K01180, not INF200K01UP0). They test the parser's grammar, not
// scheme resolution. P4 checkpoint 6 ("validate scheme-code and ISIN
// resolution") needs identifiers that agree with each other.
//
// WHAT IS GENUINE: the AMFI scheme codes, ISINs, fund-house and scheme names
// (verified read-only against production ii_scheme_master on 2026-09-27), and
// every NAV on a transaction date (AMFI's published NAV for that date, as
// stored in production and reconciled against AMFI 720/720 on 2026-09-25).
// WHAT IS SYNTHETIC: the investor (name, PAN with the repository's
// never-real "PCQAL" prefix, folio numbers, address-free), the transactions
// and their references (prefix NAV1P4-).
//
// Files (lib/fixtures/investment-intelligence/nav1-p4-ui-journey/):
//   nav1-p4-main.pdf/.txt/.expected.json
//       Folio 1, scheme A: Parag Parikh Flexi Cap Fund - Direct Plan - Growth
//         (AMFI 122639, INF879O01027), five SIPs 2023-04 .. 2025-04 and one
//         partial redemption 2026-03-02 -> a CURRENT holding.
//       Folio 2, scheme B: SBI Large Cap Fund - Regular Plan - Growth
//         (AMFI 103504, INF200K01180), two purchases 2023, FULL redemption
//         2025-04-01 -> closing balance 0.000 (the brief's fully-redeemed case).
//       Oldest transaction 2023-04-03, well before the changeover 2026-09-21
//       (the brief's "predates the changeover" case).
//   nav1-p4-unresolved.pdf/.txt
//       One scheme whose AMFI code 999999 and ISIN INF999Z99ZZ9 exist nowhere
//       (clearly synthetic) -- checkpoint 9, the deliberately unresolved row.
//
// Run: npx tsx scripts/nav1_p4_ui_journey_fixture.ts

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

const OUT_DIR = join(__dirname, '..', 'lib', 'fixtures', 'investment-intelligence', 'nav1-p4-ui-journey');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`; };
const fx = (v: number, dp: number) => v.toFixed(dp);
function inr(v: number): string {
  const [i, f] = v.toFixed(2).split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest ? `${rest},` : ''}${last3}.${f}`;
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface Txn { date: string; description: string; type: 'purchase' | 'sip' | 'redemption'; amount: number; nav: number; ref: string; units?: number }
interface Scheme { amc: string; name: string; isin: string; amfiCode: string; txns: Txn[]; closingNav: number }
interface Folio { folio: string; schemes: Scheme[] }

const PERIOD = { from: '2023-04-01', to: '2026-09-18' };
const INVESTOR = { name: 'NAVONE SYNTHETIC TESTUSER', pan: 'PCQAL0927F' };

// NAVs: AMFI's published NAV on each date (production ii_prices_nav, read 2026-09-27).
const PPFAS: Scheme = {
  amc: 'PPFAS Mutual Fund', name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', isin: 'INF879O01027', amfiCode: '122639', closingNav: 89.8569,
  txns: [
    { date: '2023-04-03', description: 'SIP Purchase', type: 'sip', amount: 10000, nav: 53.4035, ref: 'NAV1P4-001' },
    { date: '2023-10-03', description: 'SIP Purchase', type: 'sip', amount: 10000, nav: 62.4944, ref: 'NAV1P4-002' },
    { date: '2024-04-02', description: 'SIP Purchase', type: 'sip', amount: 10000, nav: 75.6672, ref: 'NAV1P4-003' },
    { date: '2024-10-01', description: 'SIP Purchase', type: 'sip', amount: 10000, nav: 88.6465, ref: 'NAV1P4-004' },
    { date: '2025-04-01', description: 'SIP Purchase', type: 'sip', amount: 10000, nav: 84.9643, ref: 'NAV1P4-005' },
    { date: '2026-03-02', description: 'Redemption', type: 'redemption', amount: 15000, nav: 91.422, ref: 'NAV1P4-006' },
  ],
};
const SBI: Scheme = {
  amc: 'SBI Mutual Fund', name: 'SBI Large Cap Fund - Regular Plan - Growth', isin: 'INF200K01180', amfiCode: '103504', closingNav: 91.1604,
  txns: [
    { date: '2023-04-03', description: 'Purchase', type: 'purchase', amount: 25000, nav: 61.9583, ref: 'NAV1P4-101' },
    { date: '2023-10-03', description: 'Purchase', type: 'purchase', amount: 15000, nav: 71.4771, ref: 'NAV1P4-102' },
    // Full redemption: every unit, at the 2025-04-01 NAV (amount = units x NAV).
    { date: '2025-04-01', description: 'Redemption', type: 'redemption', amount: 0, nav: 85.1468, ref: 'NAV1P4-103' },
  ],
};
const UNRESOLVED: Scheme = {
  amc: 'Synthetic Unresolvable Mutual Fund', name: 'NAV1 P4 Unresolvable Test Scheme - Direct Plan - Growth', isin: 'INF999Z99ZZ9', amfiCode: '999999', closingNav: 10,
  txns: [{ date: '2024-01-02', description: 'Purchase', type: 'purchase', amount: 5000, nav: 10, ref: 'NAV1P4-901' }],
};

function settle(s: Scheme) {
  let bal = 0;
  const rows: Array<Txn & { units: number; balance: number }> = [];
  for (const t of s.txns) {
    let units: number;
    let amount = t.amount;
    if (t.type === 'redemption' && amount === 0) { units = bal; amount = Math.round(units * t.nav * 100) / 100; }
    else units = r3(amount / t.nav);
    bal = r3(bal + (t.type === 'redemption' ? -units : units));
    rows.push({ ...t, amount, units, balance: bal });
  }
  return { rows, closingUnits: bal };
}

function render(folios: Folio[]): { lines: string[]; expected: unknown } {
  const lines: string[] = ['CAMS Consolidated Account Statement', `Statement Period : ${dmy(PERIOD.from)} To ${dmy(PERIOD.to)}`, ''];
  const expected: { investor: string; statementPeriod: typeof PERIOD; schemes: unknown[] } = { investor: 'synthetic', statementPeriod: PERIOD, schemes: [] };
  for (const f of folios) {
    lines.push(`Folio No: ${f.folio}`, `PAN: ${INVESTOR.pan}`, `Name: ${INVESTOR.name}`, 'Holding Mode: SI', '');
    for (const s of f.schemes) {
      const { rows, closingUnits } = settle(s);
      lines.push(`AMC Name: ${s.amc}`, `Scheme Name: ${s.name}`, `ISIN: ${s.isin}`, `AMFI Code: ${s.amfiCode}`, 'Registrar: CAMS', '');
      lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
      for (const t of rows) {
        lines.push(`${dmy(t.date)}   ${t.description.padEnd(38)}${inr(t.amount)}  ${fx(t.units, 3)}  ${fx(t.nav, 4)}  ${fx(t.balance, 3)} [Ref: ${t.ref}]`);
      }
      lines.push('');
      const value = Math.round(closingUnits * s.closingNav * 100) / 100;
      lines.push(`Closing Unit Balance as on ${dmy(PERIOD.to)} : ${fx(closingUnits, 3)} Units   Valuation : Rs. ${inr(value)}   NAV as on ${dmy(PERIOD.to)} : Rs. ${fx(s.closingNav, 4)}`, '');
      expected.schemes.push({
        folio: f.folio, amfiCode: s.amfiCode, isin: s.isin, name: s.name,
        transactions: rows.map((t) => ({ date: t.date, type: t.type, amount: t.amount.toFixed(2), units: t.units.toFixed(3), nav: t.nav.toFixed(4), balanceAfter: t.balance.toFixed(3), ref: t.ref })),
        closingUnits: closingUnits.toFixed(3), closingValue: value.toFixed(2), fullyRedeemed: closingUnits === 0,
      });
    }
  }
  return { lines, expected };
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [id, folios] of [
  ['nav1-p4-main', [{ folio: '927010000001', schemes: [PPFAS] }, { folio: '927010000002', schemes: [SBI] }]],
  ['nav1-p4-unresolved', [{ folio: '927010000009', schemes: [UNRESOLVED] }]],
] as Array<[string, Folio[]]>) {
  const { lines, expected } = render(folios);
  writeFileSync(join(OUT_DIR, `${id}.txt`), lines.join('\n'), 'utf8');
  writeFileSync(join(OUT_DIR, `${id}.pdf`), buildMinimalTextPdf([lines]));
  writeFileSync(join(OUT_DIR, `${id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${id} (.txt, .pdf, .expected.json)`);
}
