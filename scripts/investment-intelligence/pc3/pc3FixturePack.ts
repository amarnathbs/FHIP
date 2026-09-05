// II-PC3 — Real-CAMS Production Qualification Pack: fixture generator.
//
// Builds the Q01-Q10 qualification pack as REAL PDF byte fixtures (not
// pre-extracted text, unlike the R2 golden-fixture catalog — see
// docs/investment-intelligence/II_PC3_CAMS_STRUCTURAL_FINGERPRINT.md
// section on why this pack deliberately goes one layer lower than R2's
// text-only fixtures) using the SAME certified CAMS grammar
// camsParser.ts targets (documented in R2_SUPPORTED_CAS_FORMATS.md and
// reproduced structurally in II_PC3_CAMS_STRUCTURAL_FINGERPRINT.md).
//
// Every `.expected.json` oracle below is authored directly from this
// script's own scenario data structures — it NEVER imports or calls
// camsParser.ts / registry.ts / transactionTypeMapping.ts to produce
// expected values, so tests/unit/iiPc3QualificationPack.test.ts comparing
// parser OUTPUT against these oracles is a genuine test, not a tautology
// (same discipline as R2's generateR2Fixtures.mjs).
//
// Run: npx tsx scripts/investment-intelligence/pc3/pc3FixturePack.ts

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf';
import { buildEncryptedTextPdf } from '../../../tests/support/buildEncryptedCamsPdf';

const OUT_DIR = join(__dirname, '..', '..', '..', 'lib', 'fixtures', 'investment-intelligence', 'pc3-cams');

// --------------------------------------------------------------------------
// Formatting helpers (deliberately duplicated from
// scripts/investment-intelligence/generateR2Fixtures.mjs rather than
// imported — this is fixture-authoring infrastructure, not product code,
// and PC3 is a self-contained qualification pack).
// --------------------------------------------------------------------------
function formatIndianAmount(value: number, dp = 2): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const [intPart, fracPart = ''] = abs.toFixed(dp).split('.');
  let other = intPart.length > 3 ? intPart.slice(0, -3) : '';
  const lastThree = intPart.length > 3 ? intPart.slice(-3) : intPart;
  if (other !== '') other = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = other === '' ? lastThree : `${other},${lastThree}`;
  return (negative ? '-' : '') + grouped + (dp > 0 ? `.${fracPart}` : '');
}
function formatPlain(value: number, dp = 3): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  return (negative ? '-' : '') + abs.toFixed(dp);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dmyCams(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}
function pan(seed: number): string {
  return `PCQAL${String(seed).padStart(4, '0')}F`; // "PCQAL" prefix — deliberately never a real PAN prefix, and distinct from R2's ABCDE range
}

const FIXTURE_DIRECTION: Record<string, number> = {
  purchase: 1, sip: 1, switch_in: 1, stp_in: 1, transfer_in: 1, reinvestment: 1,
  redemption: -1, switch_out: -1, stp_out: -1, swp: -1, transfer_out: -1,
  dividend: 0, fee: 0, tax: 0, transfer: 0, merger: 0, segregation: 0, adjustment: 0, reversal: -1, unclassified: 0,
};
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

interface Txn { date: string; description: string; expectedType: string; amount: number; units: number; nav: number; ref?: string; indianFormat?: boolean }
interface RenderedTxn extends Txn { balanceAfter: number }
function withRunningBalance(openingUnits: number, txns: Txn[]): { transactions: RenderedTxn[]; closingUnits: number } {
  let balance = openingUnits;
  const out: RenderedTxn[] = [];
  for (const t of txns) {
    const direction = FIXTURE_DIRECTION[t.expectedType] ?? 0;
    balance = round6(balance + direction * t.units);
    out.push({ ...t, balanceAfter: balance });
  }
  return { transactions: out, closingUnits: balance };
}

interface Scheme { amc: string; schemeName: string; isin: string | null; amfiCode: string | null; transactions: RenderedTxn[]; closing: { asOf: string; units: number; value: number; nav: number; indianFormat?: boolean } | null }
interface Folio { folioNumber: string; pan: string; name: string; holdingMode?: string; schemes: Scheme[] }
interface Scenario { id: string; title: string; periodStart: string; periodEnd: string; folios: Folio[]; notes?: string }

function renderCamsBody(scenario: Scenario, opts?: { corruptFirstAmount?: boolean }): string[] {
  const lines: string[] = [];
  lines.push('CAMS Consolidated Account Statement');
  lines.push(`Statement Period : ${dmyCams(scenario.periodStart)} To ${dmyCams(scenario.periodEnd)}`);
  lines.push('');
  for (const folio of scenario.folios) {
    lines.push(`Folio No: ${folio.folioNumber}`);
    lines.push(`PAN: ${folio.pan}`);
    lines.push(`Name: ${folio.name}`);
    lines.push(`Holding Mode: ${folio.holdingMode ?? 'SI'}`);
    lines.push('');
    for (const scheme of folio.schemes) {
      lines.push(`AMC Name: ${scheme.amc}`);
      lines.push(`Scheme Name: ${scheme.schemeName}`);
      lines.push(`ISIN: ${scheme.isin ?? ''}`);
      lines.push(`AMFI Code: ${scheme.amfiCode ?? ''}`);
      lines.push('Registrar: CAMS');
      lines.push('');
      if (scheme.transactions.length > 0) {
        lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
        let first = true;
        for (const t of scheme.transactions) {
          const ref = t.ref ? ` [Ref: ${t.ref}]` : '';
          let amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
          if (opts?.corruptFirstAmount && first) amountStr = 'N/A-CORRUPT'; // deliberately breaks TXN_ROW_RE's numeric-field capture (Q10)
          first = false;
          const descPadded = t.description.length < 38 ? t.description.padEnd(38) : `${t.description}  `;
          lines.push(`${dmyCams(t.date)}   ${descPadded}${amountStr}  ${formatPlain(t.units, 3)}  ${formatPlain(t.nav, 4)}  ${formatPlain(t.balanceAfter, 3)}${ref}`);
        }
        lines.push('');
      }
      if (scheme.closing) {
        const c = scheme.closing;
        const valueStr = c.indianFormat ? formatIndianAmount(c.value) : formatPlain(c.value, 2);
        lines.push(`Closing Unit Balance as on ${dmyCams(c.asOf)} : ${formatPlain(c.units, 3)} Units   Valuation : Rs. ${valueStr}   NAV as on ${dmyCams(c.asOf)} : Rs. ${formatPlain(c.nav, 4)}`);
      }
      lines.push('');
    }
  }
  return lines;
}

function buildExpected(scenario: Scenario, extra: Record<string, unknown> = {}) {
  const accounts = scenario.folios.map((f) => ({ folioNumber: f.folioNumber, holderName: f.name, holdingModeRaw: f.holdingMode ?? 'SI' }));
  const transactions: unknown[] = [];
  const holdings: unknown[] = [];
  for (const folio of scenario.folios) {
    for (const scheme of folio.schemes) {
      for (const t of scheme.transactions) {
        transactions.push({
          folioNumber: folio.folioNumber, scheme: scheme.schemeName, isin: scheme.isin || null, amfiSchemeCode: scheme.amfiCode || null,
          transactionDateIso: t.date, canonicalType: t.expectedType, amount: t.amount.toFixed(2), units: t.units.toFixed(3), nav: t.nav.toFixed(4), sourceReference: t.ref || null,
        });
      }
      if (scheme.closing) {
        holdings.push({ folioNumber: folio.folioNumber, scheme: scheme.schemeName, asOfDateIso: scheme.closing.asOf, units: scheme.closing.units.toFixed(3), value: scheme.closing.value.toFixed(2), nav: scheme.closing.nav.toFixed(4) });
      }
    }
  }
  return {
    fixtureId: scenario.id, title: scenario.title, sourceKey: 'cams', documentTypeDetected: 'cas_statement', formatVersionDetected: 'detailed_v1',
    statementPeriodStartIso: scenario.periodStart, statementPeriodEndIso: scenario.periodEnd,
    accounts, transactionCount: transactions.length, transactions, holdingCount: holdings.length, holdings,
    notes: scenario.notes ?? null,
    ...extra,
  };
}

// ==========================================================================
// Q01 — baseline multi-folio, multi-AMC, clean parse + reconciliation
// ==========================================================================
const q01Folios: Folio[] = (() => {
  const t1 = withRunningBalance(0, [{ date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.7605, ref: 'PC3Q1-001', indianFormat: true }]);
  const t2 = withRunningBalance(0, [{ date: '2025-02-10', description: 'Purchase', expectedType: 'purchase', amount: 15000, units: 62.1, nav: 241.55, ref: 'PC3Q1-002', indianFormat: true }]);
  return [
    { folioNumber: '9301040000101', pan: pan(1), name: 'ARJUN KAPOOR', schemes: [{ amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: t1.transactions, closing: { asOf: '2025-06-30', units: t1.closingUnits, value: Math.round(t1.closingUnits * 134.9 * 100) / 100, nav: 134.9 } }] },
    { folioNumber: '9301040000102', pan: pan(1), name: 'ARJUN KAPOOR', schemes: [{ amc: 'SBI Mutual Fund', schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)', isin: 'INF200K01UP0', amfiCode: '103504', transactions: t2.transactions, closing: { asOf: '2025-06-30', units: t2.closingUnits, value: Math.round(t2.closingUnits * 264.1 * 100) / 100, nav: 264.1 } }] },
  ];
})();
const Q01: Scenario = { id: 'pc3-q01-baseline-multi-folio-multi-amc', title: 'Q01 baseline: multi-folio, multi-AMC, clean parse + reconciliation', periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: q01Folios };

// ==========================================================================
// Q03 — same instrument, two folios (F1 account-scoping probe)
// ==========================================================================
const q03OldTxns = withRunningBalance(0, [{ date: '2024-01-10', description: 'Purchase', expectedType: 'purchase', amount: 12000, units: 100.19, nav: 119.77, ref: 'PC3Q3-OLD-001', indianFormat: true }]);
const q03NewPurchase = withRunningBalance(0, [{ date: '2025-05-10', description: 'Purchase', expectedType: 'purchase', amount: 20000, units: 148.94, nav: 134.29, ref: 'PC3Q3-NEW-001', indianFormat: true }]);
const q03NewRedemption = withRunningBalance(q03NewPurchase.closingUnits, [{ date: '2025-06-10', description: 'Redemption', expectedType: 'redemption', amount: 8000, units: 58.65, nav: 136.4, ref: 'PC3Q3-NEW-002', indianFormat: true }]);
const Q03: Scenario = {
  id: 'pc3-q03-same-instrument-two-folios-fifo-scope',
  title: 'Q03 — same instrument in two folios (Folio A older/cheaper, Folio B newer, redemption from Folio B only) — F1 account-scoped FIFO probe',
  periodStart: '2024-01-01', periodEnd: '2025-06-30',
  folios: [
    { folioNumber: '9303040000301', pan: pan(3), name: 'MEERA VISHWANATH', schemes: [{ amc: 'Axis Mutual Fund', schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)', isin: 'INF846K01EW2', amfiCode: '135944', transactions: q03OldTxns.transactions, closing: { asOf: '2025-06-30', units: q03OldTxns.closingUnits, value: Math.round(q03OldTxns.closingUnits * 131 * 100) / 100, nav: 131 } }] },
    { folioNumber: '9303040000302', pan: pan(3), name: 'MEERA VISHWANATH', schemes: [{ amc: 'Axis Mutual Fund', schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)', isin: 'INF846K01EW2', amfiCode: '135944', transactions: [...q03NewPurchase.transactions, ...q03NewRedemption.transactions], closing: { asOf: '2025-06-30', units: q03NewRedemption.closingUnits, value: Math.round(q03NewRedemption.closingUnits * 131 * 100) / 100, nav: 131 } }] },
  ],
  notes: 'Folio A (9303040000301) must retain its 100.19 units untouched by Folio B (9303040000302)\'s redemption — zero cross-account contamination required.',
};

// ==========================================================================
// Q04 — monthly delta pair (same folio, cumulative statement 2 reuses statement 1's transaction)
// ==========================================================================
const q04Month1 = withRunningBalance(0, [{ date: '2025-01-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, nav: 119.76, ref: 'PC3Q4-001', indianFormat: true }]);
const Q04A: Scenario = { id: 'pc3-q04a-month1', title: 'Q04a — first monthly statement (Jan only)', periodStart: '2025-01-01', periodEnd: '2025-01-31', folios: [{ folioNumber: '9304040000401', pan: pan(4), name: 'KABIR SETH', schemes: [{ amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: q04Month1.transactions, closing: { asOf: '2025-01-31', units: q04Month1.closingUnits, value: Math.round(q04Month1.closingUnits * 121 * 100) / 100, nav: 121 } }] }] };
const q04Month2Cumulative = withRunningBalance(0, [
  { date: '2025-01-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, nav: 119.76, ref: 'PC3Q4-001', indianFormat: true }, // identical ref to statement 1 -> must fingerprint-dedup, not duplicate
  { date: '2025-02-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.5, nav: 123.46, ref: 'PC3Q4-002', indianFormat: true }, // genuinely new
]);
const Q04B: Scenario = { id: 'pc3-q04b-month1-plus-2-cumulative', title: 'Q04b — second monthly statement, cumulative Jan+Feb (Jan transaction repeated, Feb new)', periodStart: '2025-01-01', periodEnd: '2025-02-28', folios: [{ folioNumber: '9304040000401', pan: pan(4), name: 'KABIR SETH', schemes: [{ amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: q04Month2Cumulative.transactions, closing: { asOf: '2025-02-28', units: q04Month2Cumulative.closingUnits, value: Math.round(q04Month2Cumulative.closingUnits * 123.9 * 100) / 100, nav: 123.9 } }] }] };

// ==========================================================================
// Q06 — SIP-rich: monthly cadence, one skipped month (March), resumed April
// ==========================================================================
const q06Raw: Txn[] = [
  { date: '2025-01-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, nav: 119.76, ref: 'PC3Q6-001' },
  { date: '2025-02-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.51, nav: 120.5, ref: 'PC3Q6-002' },
  // March deliberately skipped — no transaction row for this month
  { date: '2025-04-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.88, nav: 122.3, ref: 'PC3Q6-003' },
  { date: '2025-05-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 39.96, nav: 125.1, ref: 'PC3Q6-004' },
  { date: '2025-06-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.12, nav: 124.63, ref: 'PC3Q6-005' },
];
const q06 = withRunningBalance(0, q06Raw);
const Q06: Scenario = {
  id: 'pc3-q06-sip-rich-skipped-month',
  title: 'Q06 — SIP-rich: 5 monthly instalments Jan/Feb/Apr/May/Jun, March deliberately skipped and resumed April',
  periodStart: '2025-01-01', periodEnd: '2025-06-30',
  folios: [{ folioNumber: '9306040000601', pan: pan(6), name: 'NANDINI RAO', schemes: [{ amc: 'Axis Mutual Fund', schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)', isin: 'INF846K01EW2', amfiCode: '135944', transactions: q06.transactions, closing: { asOf: '2025-06-30', units: q06.closingUnits, value: Math.round(q06.closingUnits * 124.63 * 100) / 100, nav: 124.63 } }] }],
  notes: 'Exactly 5 SIP transactions expected (Jan,Feb,Apr,May,Jun) — a gap exists between Feb and Apr. Gap/series/XIRR DETECTION itself is an R5 analytical claim outside this DB-free pack\'s scope (no live DEV available) — this fixture proves the PARSER surfaces the correct raw signal (5 txns, correct dates, no phantom March row) that R5 would need.',
};

// ==========================================================================
// Q07 — transaction-rich: one of each currently-supported type
// ==========================================================================
const q07SchemeATxns = withRunningBalance(0, [
  { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'PC3Q7-001', indianFormat: true },
  { date: '2025-02-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, nav: 119.76, ref: 'PC3Q7-002', indianFormat: true },
  { date: '2025-03-15', description: 'Redemption', expectedType: 'redemption', amount: 3000, units: 24.5, nav: 122.4, ref: 'PC3Q7-003', indianFormat: true },
  { date: '2025-04-20', description: 'IDCW Payout', expectedType: 'dividend', amount: 450, units: 0, nav: 45.2, ref: 'PC3Q7-004', indianFormat: true },
  { date: '2025-05-20', description: 'IDCW Reinvestment', expectedType: 'reinvestment', amount: 620, units: 13.5, nav: 45.93, ref: 'PC3Q7-005', indianFormat: true },
  { date: '2025-06-01', description: 'Switch Out To SBI Bluechip Fund', expectedType: 'switch_out', amount: 12000, units: 89.66, nav: 133.83, ref: 'PC3Q7-006', indianFormat: true },
]);
const q07SchemeBTxns = withRunningBalance(0, [{ date: '2025-06-01', description: 'Switch In From HDFC Flexi Cap Fund', expectedType: 'switch_in', amount: 12000, units: 45.4, nav: 264.32, ref: 'PC3Q7-007', indianFormat: true }]);
const Q07: Scenario = {
  id: 'pc3-q07-transaction-rich',
  title: 'Q07 — every currently-supported transaction type: purchase, SIP purchase, redemption, dividend, reinvestment, switch-out/switch-in',
  periodStart: '2025-01-01', periodEnd: '2025-06-30',
  folios: [{
    folioNumber: '9307040000701', pan: pan(7), name: 'ROHAN DESHPANDE',
    schemes: [
      { amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: q07SchemeATxns.transactions, closing: { asOf: '2025-06-30', units: q07SchemeATxns.closingUnits, value: Math.round(q07SchemeATxns.closingUnits * 134.9 * 100) / 100, nav: 134.9 } },
      { amc: 'SBI Mutual Fund', schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)', isin: 'INF200K01UP0', amfiCode: '103504', transactions: q07SchemeBTxns.transactions, closing: { asOf: '2025-06-30', units: q07SchemeBTxns.closingUnits, value: Math.round(q07SchemeBTxns.closingUnits * 264.1 * 100) / 100, nav: 264.1 } },
    ],
  }],
};

// ==========================================================================
// Q08 — reconciliation exception: closing balance deliberately mismatches
// ==========================================================================
const q08Txns = withRunningBalance(0, [{ date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'PC3Q8-001', indianFormat: true }]);
const Q08: Scenario = {
  id: 'pc3-q08-reconciliation-exception',
  title: 'Q08 — reconciliation exception: transaction-derived units (83.5) deliberately mismatch the stated closing balance (70.0)',
  periodStart: '2025-01-01', periodEnd: '2025-06-30',
  folios: [{ folioNumber: '9308040000801', pan: pan(8), name: 'TANVI GHOSH', schemes: [{ amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: q08Txns.transactions, closing: { asOf: '2025-06-30', units: 70.0, value: 9443.0, nav: 134.9 } }] }],
  notes: 'Statement prints closing=70.0 units but the transaction history sums to 83.5 units — reconciliation MUST detect this variance, never silently certify.',
};

// ==========================================================================
// Q10 — controlled malformed: one bad numeric field
// ==========================================================================
const q10Txns = withRunningBalance(0, [
  { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'PC3Q10-001', indianFormat: true }, // this row's amount field gets corrupted at render time
  { date: '2025-03-01', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, nav: 121.36, ref: 'PC3Q10-002', indianFormat: true }, // this one must still parse cleanly
]);
const Q10: Scenario = {
  id: 'pc3-q10-controlled-malformed',
  title: 'Q10 — controlled malformed: first transaction row has a non-numeric Amount field (fails the TXN_ROW_RE grammar)',
  periodStart: '2025-01-01', periodEnd: '2025-06-30',
  folios: [{ folioNumber: '9310040001001', pan: pan(10), name: 'ISHAAN MALHOTRA', schemes: [{ amc: 'HDFC Mutual Fund', schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)', isin: 'INF179K01YW8', amfiCode: '118834', transactions: q10Txns.transactions, closing: { asOf: '2025-06-30', units: q10Txns.closingUnits, value: Math.round(q10Txns.closingUnits * 134.9 * 100) / 100, nav: 134.9 } }] }],
  notes: 'Row 1 (PC3Q10-001) must be REJECTED with an unparseable_transaction_row error-severity warning, never silently dropped/coerced. Row 2 (PC3Q10-002) must still parse correctly. Expected transaction count for the ORACLE below therefore intentionally lists only the ONE surviving clean row.',
};

// ==========================================================================
// Q09 — multi-page continuation (built directly as two PDF pages, not via renderCamsBody)
// ==========================================================================
function buildQ09(): { pages: string[][]; expected: ReturnType<typeof buildExpected> } {
  const all = withRunningBalance(0, [
    { date: '2025-01-05', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'PC3Q9-001', indianFormat: true },
    { date: '2025-01-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, nav: 121.36, ref: 'PC3Q9-002', indianFormat: true },
    { date: '2025-02-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.5, nav: 123.46, ref: 'PC3Q9-003', indianFormat: true },
    { date: '2025-02-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 39.8, nav: 125.63, ref: 'PC3Q9-004', indianFormat: true },
    { date: '2025-03-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 38.9, nav: 128.53, ref: 'PC3Q9-005', indianFormat: true },
    { date: '2025-03-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 38.1, nav: 131.23, ref: 'PC3Q9-006', indianFormat: true },
    // ---- page break falls here ----
    { date: '2025-04-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 37.4, nav: 133.69, ref: 'PC3Q9-007', indianFormat: true },
    { date: '2025-04-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 36.9, nav: 135.5, ref: 'PC3Q9-008', indianFormat: true },
    { date: '2025-05-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 36.2, nav: 138.12, ref: 'PC3Q9-009', indianFormat: true },
    { date: '2025-05-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 35.6, nav: 140.45, ref: 'PC3Q9-010', indianFormat: true },
    { date: '2025-06-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 35.0, nav: 142.86, ref: 'PC3Q9-011', indianFormat: true },
    { date: '2025-06-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 34.5, nav: 144.93, ref: 'PC3Q9-012', indianFormat: true },
  ]);
  const folioNumber = '9309040000901';
  const scheme = { amc: 'Axis Mutual Fund', schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)', isin: 'INF846K01EW2', amfiCode: '135944' };
  const first6 = all.transactions.slice(0, 6);
  const last6 = all.transactions.slice(6);
  const headerLine = 'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance';
  const txnLine = (t: RenderedTxn) => {
    const ref = t.ref ? ` [Ref: ${t.ref}]` : '';
    const amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
    const descPadded = t.description.length < 38 ? t.description.padEnd(38) : `${t.description}  `;
    return `${dmyCams(t.date)}   ${descPadded}${amountStr}  ${formatPlain(t.units, 3)}  ${formatPlain(t.nav, 4)}  ${formatPlain(t.balanceAfter, 3)}${ref}`;
  };

  const page1 = [
    'CAMS Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 30-Jun-2025',
    '',
    `Folio No: ${folioNumber}`,
    `PAN: ${pan(9)}`,
    'Name: DIVYA KRISHNAN',
    'Holding Mode: SI',
    '',
    `AMC Name: ${scheme.amc}`,
    `Scheme Name: ${scheme.schemeName}`,
    `ISIN: ${scheme.isin}`,
    `AMFI Code: ${scheme.amfiCode}`,
    'Registrar: CAMS',
    '',
    headerLine,
    ...first6.map(txnLine),
  ];
  // Page 2 REPRINTS the AMC/Scheme/ISIN/AMFI/Registrar block and the column
  // header — an exact repeat of page 1's own label lines (the one pattern
  // camsParser.ts's own doc comment documents as supported for
  // "multi-folio, multi-AMC, multi-scheme statements... repeat"). A
  // decorated "(Contd.)"-style variant was deliberately NOT fabricated
  // here — see II_PC3_CAMS_STRUCTURAL_FINGERPRINT.md section 1.6 for why
  // that convention cannot be asserted without a real sample.
  const page2 = [
    `AMC Name: ${scheme.amc}`,
    `Scheme Name: ${scheme.schemeName}`,
    `ISIN: ${scheme.isin}`,
    `AMFI Code: ${scheme.amfiCode}`,
    'Registrar: CAMS',
    '',
    headerLine,
    ...last6.map(txnLine),
    '',
    `Closing Unit Balance as on 30-Jun-2025 : ${formatPlain(all.closingUnits, 3)} Units   Valuation : Rs. ${formatIndianAmount(Math.round(all.closingUnits * 131 * 100) / 100)}   NAV as on 30-Jun-2025 : Rs. ${formatPlain(131, 4)}`,
  ];

  const scenario: Scenario = {
    id: 'pc3-q09-multi-page-continuation', title: 'Q09 — scheme transactions spanning a real PDF page break, header block reprinted on page 2',
    periodStart: '2025-01-01', periodEnd: '2025-06-30',
    folios: [{ folioNumber, pan: pan(9), name: 'DIVYA KRISHNAN', schemes: [{ ...scheme, transactions: all.transactions, closing: { asOf: '2025-06-30', units: all.closingUnits, value: Math.round(all.closingUnits * 131 * 100) / 100, nav: 131 } }] }],
    notes: 'Genuine 2-content-object PDF page break falls mid-table (after the 6th transaction). Header block (AMC/Scheme/ISIN/AMFI/Registrar + column header) is reprinted verbatim on page 2. Expected: all 12 transactions present exactly once, zero loss, zero duplication.',
  };
  return { pages: [page1, page2], expected: buildExpected(scenario) };
}

// ==========================================================================
// Q11 — II-PC3 Gate A alternate CAMS layout (real-parser-incompatibility
// fix probe). Built entirely from the ABSTRACT STRUCTURAL FACTS recorded
// in docs/investment-intelligence/II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md
// -- invented names, invented PAN-shaped-but-fake identifiers, invented
// folio numbers, invented amounts. NOTHING here is copied or derived from
// the real statement Gate A inspected; only the document's SHAPE
// (label vocabulary, line grammar, column order) is reproduced, matching
// the discipline that document itself was built under (zero real values).
//
// Reproduces, structurally, every property Gate A found DIFFERS or
// UNMODELLED against the certified "detailed_v1" grammar:
//   (1) title fragments on separate, non-adjacent lines (a tracking/
//       version-stamp line containing "CAMS" only as a substring, then a
//       separate standalone "Consolidated Account Statement" line);
//   (2) investor block using only Folio No:/PAN: -- no Name:/Holding Mode:;
//   (3) no "AMC Name:" label anywhere (out of scope for this fix -- see
//       II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md's "still open" section);
//   (5) scheme/ISIN/advisor-code/registrar folded onto ONE free-text line,
//       with no "Scheme Name:"/"AMFI Code:" labels (the parenthetical is a
//       distributor "Advisor" code, never an AMFI scheme code);
//   (6) transaction table column order Date/Amount/Price/Units/
//       Transaction-type, no separate Description column;
//   (7) two real transaction-cost categories (stamp duty, STT) exercised
//       as actual transaction rows;
//   (9) "Closing Unit Balance: X Total Cost Value: Y" -- no "as on"/
//       "Valuation"/"NAV as on" clause;
//   (10) zero header reprint at a real page boundary, mid-table;
//   (12) a "no activity this period" placeholder folio.
function buildQ11(): { pages: string[][]; expected: Record<string, unknown> } {
  const folioA = '9311040001101';
  const folioB = '9311040001102';
  const schemeALine = 'Vishaal Composite Fund - Growth (Direct Plan) - ISIN: INF555K01AB1(Advisor: ARN00234) Registrar : CAMS';
  const schemeBLine = 'Zenith Diversified Fund - Growth (Regular Plan) - ISIN: (Advisor: ARN00567) Registrar : CAMS';
  const altHeaderLine = 'Date          Amount           Price        Units       Transaction Type                    Unit Balance';

  const page1 = [
    'CQAL-STMT-TRK-2026-CAMS-Q11V3', // tracking/version-stamp line -- "CAMS" only as a substring of a longer code, never the standalone word adjacent to the title
    'Consolidated Account Statement', // separate line -- no "CAMS" immediately precedes this anywhere in the document
    'Statement Period : 01-Jan-2025 To 30-Jun-2025',
    '',
    `Folio No: ${folioA}`,
    `PAN: ${pan(11)}`, // no Name:/Holding Mode: lines -- genuinely absent in this layout
    '',
    schemeALine,
    '',
    altHeaderLine,
    '01-Feb-2025   10,000.00        119.7605     83.500      Purchase                             83.500   [Ref: PC3Q11-001]',
    '05-Feb-2025   50.00            0.0000       0.000       Stamp Duty                           83.500   [Ref: PC3Q11-002]',
    '10-Feb-2025   120.00           0.0000       0.000       STT                                  83.500   [Ref: PC3Q11-003]',
    '15-Mar-2025   5,000.00         121.3600     41.200      SIP Purchase                         124.700  [Ref: PC3Q11-004]',
    '20-Apr-2025   5,000.00         123.4600     40.500      SIP Purchase                         165.200  [Ref: PC3Q11-005]',
    '25-May-2025   5,000.00         125.1000     39.960      SIP Purchase                         205.160  [Ref: PC3Q11-006]',
  ];
  // Page 2: the transaction table continues RAW across the page break --
  // zero header/label reprint of any kind (Gate A row 10's finding is the
  // OPPOSITE of Q09's verbatim-reprint assumption, not a variant of it).
  const page2 = [
    '30-Jun-2025   5,000.00         124.6300     40.120      SIP Purchase                         245.280  [Ref: PC3Q11-007]',
    '',
    'Closing Unit Balance: 245.280 Total Cost Value: Rs. 30,000.00',
    '',
    `Folio No: ${folioB}`,
    `PAN: ${pan(12)}`,
    '',
    schemeBLine,
    '',
    'No transactions during this statement period.',
    '',
    'Closing Unit Balance: 60.000 Total Cost Value: Rs. 6,000.00',
  ];

  const expected = {
    fixtureId: 'pc3-q11-alternate-cams-layout',
    title: 'Q11 — II-PC3 Gate A alternate CAMS layout (real structural-incompatibility fix probe)',
    sourceKey: 'cams',
    documentTypeDetected: 'cas_statement',
    formatVersionDetected: 'detailed_v1_alt_layout',
    statementPeriodStartIso: '2025-01-01',
    statementPeriodEndIso: '2025-06-30',
    accounts: [
      { folioNumber: folioA, holderName: null, holdingModeRaw: null },
      { folioNumber: folioB, holderName: null, holdingModeRaw: null },
    ],
    transactionCount: 7,
    transactions: [
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-02-01', canonicalType: 'purchase', amount: '10000.00', units: '83.500000', navRaw: '119.760500', sourceReference: 'PC3Q11-001' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-02-05', canonicalType: 'fee', amount: '50.00', units: '0.000000', navRaw: '0.000000', sourceReference: 'PC3Q11-002' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-02-10', canonicalType: 'tax', amount: '120.00', units: '0.000000', navRaw: '0.000000', sourceReference: 'PC3Q11-003' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-03-15', canonicalType: 'sip', amount: '5000.00', units: '41.200000', navRaw: '121.360000', sourceReference: 'PC3Q11-004' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-04-20', canonicalType: 'sip', amount: '5000.00', units: '40.500000', navRaw: '123.460000', sourceReference: 'PC3Q11-005' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-05-25', canonicalType: 'sip', amount: '5000.00', units: '39.960000', navRaw: '125.100000', sourceReference: 'PC3Q11-006' },
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', isin: 'INF555K01AB1', amfiSchemeCode: null, transactionDateIso: '2025-06-30', canonicalType: 'sip', amount: '5000.00', units: '40.120000', navRaw: '124.630000', sourceReference: 'PC3Q11-007' },
    ],
    holdingCount: 2,
    holdings: [
      { folioNumber: folioA, scheme: 'Vishaal Composite Fund - Growth (Direct Plan)', asOfDateIso: '2025-06-30', units: '245.280000', value: '30000.00' },
      { folioNumber: folioB, scheme: 'Zenith Diversified Fund - Growth (Regular Plan)', asOfDateIso: '2025-06-30', units: '60.000000', value: '6000.00' },
    ],
    notes:
      'Folio B (9311040001102) has a "no activity this period" placeholder in place of a transaction table -- must parse as zero transactions for that scheme, never a parse error, while its closing holding (60.000 units, unaffected) is still captured via the alternate closing-balance grammar using the statement period end as the as-of date (this layout prints no per-line date at all on its closing line).',
  };

  return { pages: [page1, page2], expected };
}

// ==========================================================================
// Write everything
// ==========================================================================
mkdirSync(OUT_DIR, { recursive: true });

function writeTextAndPdfFixture(scenario: Scenario, opts?: { corruptFirstAmount?: boolean; oracleTransactionCountOverride?: number }) {
  const bodyLines = renderCamsBody(scenario, opts);
  const text = bodyLines.join('\n');
  writeFileSync(join(OUT_DIR, `${scenario.id}.txt`), text, 'utf8');
  const pdf = buildMinimalTextPdf([bodyLines]);
  writeFileSync(join(OUT_DIR, `${scenario.id}.pdf`), pdf);
  let expected = buildExpected(scenario);
  if (opts?.oracleTransactionCountOverride !== undefined) {
    // Q10 only: the oracle intentionally lists just the surviving clean
    // transaction(s) — the corrupted row is expected to be REJECTED, not
    // silently included as if it parsed.
    const kept = (expected.transactions as unknown[]).slice(-(opts.oracleTransactionCountOverride));
    expected = { ...expected, transactions: kept, transactionCount: kept.length };
  }
  writeFileSync(join(OUT_DIR, `${scenario.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${scenario.id} (.txt, .pdf, .expected.json)`);
}

writeTextAndPdfFixture(Q01);

// Q02 — encrypted duplicate of Q01 (economically identical content).
// The qualification password is deliberately NOT persisted into this
// fixture's .expected.json — it lives in exactly one place, the test
// code that needs it to attempt decryption (tests/unit/
// iiPc3QualificationPack.test.ts and tests/live-dev/
// iiPc3RealCamsQualificationLiveDev.test.ts), matching the task's own
// "never persisted/committed in plaintext where avoidable" instruction —
// avoidable here, since nothing besides those two test files needs it.
{
  const bodyLines = renderCamsBody(Q01);
  const encPassword = 'PC3-Qualification-2026';
  const enc = buildEncryptedTextPdf([bodyLines], encPassword);
  writeFileSync(join(OUT_DIR, 'pc3-q02-encrypted-duplicate-of-q01.pdf'), enc.bytes);
  writeFileSync(join(OUT_DIR, 'pc3-q02-encrypted-duplicate-of-q01.expected.json'), JSON.stringify(buildExpected({ ...Q01, id: 'pc3-q02-encrypted-duplicate-of-q01', title: 'Q02 — password-protected duplicate of Q01' }), null, 2) + '\n', 'utf8');
  console.log('wrote pc3-q02-encrypted-duplicate-of-q01 (.pdf [RC4-40-bit encrypted], .expected.json)');
}

writeTextAndPdfFixture(Q03);
writeTextAndPdfFixture(Q04A);
writeTextAndPdfFixture(Q04B);
writeTextAndPdfFixture(Q06);
writeTextAndPdfFixture(Q07);
writeTextAndPdfFixture(Q08);
writeTextAndPdfFixture(Q10, { corruptFirstAmount: true, oracleTransactionCountOverride: 1 });

// Q09 — bespoke 2-page build
{
  const { pages, expected } = buildQ09();
  const text = pages.map((p) => p.join('\n')).join('\n-- 1 of 2 --\n');
  writeFileSync(join(OUT_DIR, 'pc3-q09-multi-page-continuation.txt'), text, 'utf8');
  const pdf = buildMinimalTextPdf(pages);
  writeFileSync(join(OUT_DIR, 'pc3-q09-multi-page-continuation.pdf'), pdf);
  writeFileSync(join(OUT_DIR, 'pc3-q09-multi-page-continuation.expected.json'), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log('wrote pc3-q09-multi-page-continuation (.txt, .pdf [2 real PDF pages], .expected.json)');
}

// Q11 — bespoke 2-page build, alternate CAMS layout (II-PC3 Gate A fix probe)
{
  const { pages, expected } = buildQ11();
  const text = pages.map((p) => p.join('\n')).join('\n-- 1 of 2 --\n');
  writeFileSync(join(OUT_DIR, 'pc3-q11-alternate-cams-layout.txt'), text, 'utf8');
  const pdf = buildMinimalTextPdf(pages);
  writeFileSync(join(OUT_DIR, 'pc3-q11-alternate-cams-layout.pdf'), pdf);
  writeFileSync(join(OUT_DIR, 'pc3-q11-alternate-cams-layout.expected.json'), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log('wrote pc3-q11-alternate-cams-layout (.txt, .pdf [2 real PDF pages, alternate grammar], .expected.json)');
}

console.log('\nQ05 = exact reimport of Q01 (pc3-q01-baseline-multi-folio-multi-amc.pdf uploaded twice) — no separate fixture file needed.');
console.log('Done.');
