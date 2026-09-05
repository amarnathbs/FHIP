// II-PC3-C1 — REAL_CAMS_VARIANT_QUALIFICATION pack: Q01-Q12 fixture
// generator, built entirely against the REAL CAMS grammar recorded in
// docs/investment-intelligence/II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md —
// NOT the pre-real-sample "detailed_v1" grammar `pc3FixturePack.ts`'s
// Q01-Q10 pack targets (that pack is kept, unmodified, as
// LEGACY_CAMS_GRAMMAR_REGRESSION — see that file's own header comment).
//
// Direction of truth: real statement -> fingerprint doc -> this generator
// -> camsParser.ts. Every value below is fully synthetic (invented names,
// PAN-shaped-but-fake identifiers, folios, amounts) — nothing here is
// copied or derived from the real statement; only its abstract SHAPE
// (already zero-real-value in the fingerprint doc) is reproduced. Every
// `.expected.json` oracle is authored directly from this script's own
// scenario data — it NEVER imports/calls camsParser.ts/registry.ts to
// produce expected values (same discipline as pc3FixturePack.ts and
// generateR2Fixtures.mjs).
//
// Run: npx tsx scripts/investment-intelligence/pc3/pc3RealVariantFixturePack.ts

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf';
import { buildEncryptedTextPdf } from '../../../tests/support/buildEncryptedCamsPdf';

const OUT_DIR = join(__dirname, '..', '..', '..', 'lib', 'fixtures', 'investment-intelligence', 'pc3-cams-real-variant');
mkdirSync(OUT_DIR, { recursive: true });

// --------------------------------------------------------------------------
// Formatting helpers — deliberately duplicated from pc3FixturePack.ts
// (fixture-authoring infrastructure, not product code; same discipline
// that file's own header comment documents).
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
// "PCRVQ" prefix — this pack's own synthetic PAN series, distinct from the
// legacy pack's "PCQAL" and Gate A's "PCQAL"-derived Q11/golden probes.
function pan(seed: number): string {
  return `PCRVQ${String(seed).padStart(4, '0')}F`;
}
function folioNo(group: number, seq: number): string {
  return `95${String(group).padStart(2, '0')}0400${String(seq).padStart(4, '0')}`;
}
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

const FIXTURE_DIRECTION: Record<string, number> = {
  purchase: 1, sip: 1, switch_in: 1, stp_in: 1, transfer_in: 1, reinvestment: 1,
  redemption: -1, switch_out: -1, stp_out: -1, swp: -1, transfer_out: -1,
  dividend: 0, fee: 0, tax: 0, transfer: 0, merger: 0, segregation: 0, adjustment: 0, reversal: -1, unclassified: 0,
};

interface Txn {
  date: string; description: string; expectedType: string; amount: number;
  units: number; price: number; ref?: string | null; isFee?: boolean; indianFormat?: boolean;
}
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

interface Scheme { schemeName: string; isin: string | null; advisorCode: string; transactions: RenderedTxn[]; closing: { units: number; value: number } | null }
interface Folio { folioNumber: string; pan: string; schemes: Scheme[] }
interface Scenario { id: string; title: string; periodStart: string; periodEnd: string; folios: Folio[]; notes?: string }

const HEADER_LINE = 'Date          Amount           Price        Units       Transaction Type                    Unit Balance';

function schemeLine(scheme: Scheme): string {
  const isinPart = scheme.isin ?? '';
  return `${scheme.schemeName} - ISIN: ${isinPart}(Advisor: ${scheme.advisorCode}) Registrar : CAMS`;
}

function fullRowLine(t: RenderedTxn): string {
  const ref = t.ref ? ` [Ref: ${t.ref}]` : '';
  const amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
  const descPadded = t.description.length < 34 ? t.description.padEnd(34) : `${t.description}  `;
  return `${dmyCams(t.date)}   ${amountStr}         ${formatPlain(t.price, 4)}     ${formatPlain(t.units, 3)}     ${descPadded}    ${formatPlain(t.balanceAfter, 3)}${ref}`;
}
function feeRowLine(t: RenderedTxn): string {
  // Real fee-row grammar (fingerprint section 8/9): Date + Amount(with a
  // non-numeric marker glued on, no space) + Type label + trailing marker
  // — NO Price/Units/Balance fields at all.
  const amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
  return `${dmyCams(t.date)}   ${amountStr}***   ${t.description}   ***`;
}
function txnLine(t: RenderedTxn): string {
  return t.isFee ? feeRowLine(t) : fullRowLine(t);
}

function renderFolioSchemeBlock(folio: Folio): string[] {
  const lines: string[] = [];
  lines.push(`Folio No: ${folio.folioNumber}`);
  lines.push(`PAN: ${folio.pan}`);
  lines.push('');
  for (const scheme of folio.schemes) {
    lines.push(schemeLine(scheme));
    lines.push('');
    if (scheme.transactions.length > 0) {
      lines.push(HEADER_LINE);
      for (const t of scheme.transactions) lines.push(txnLine(t));
      lines.push('');
    } else {
      lines.push('No transactions during this statement period.');
      lines.push('');
    }
    if (scheme.closing) {
      lines.push(`Closing Unit Balance: ${formatPlain(scheme.closing.units, 3)} Total Cost Value: Rs. ${formatIndianAmount(scheme.closing.value)}`);
    }
    lines.push('');
  }
  return lines;
}

function renderPage(scenario: Scenario, folios: Folio[], opts?: { includeTitle?: boolean; corruptDate?: { folioIdx: number; txnRef: string; badDate: string } }): string[] {
  const lines: string[] = [];
  if (opts?.includeTitle) {
    lines.push(`CQAL-STMT-TRK-2026-CAMS-${scenario.id.toUpperCase()}`);
    lines.push('Consolidated Account Statement');
    lines.push(`Statement Period : ${dmyCams(scenario.periodStart)} To ${dmyCams(scenario.periodEnd)}`);
    lines.push('');
  }
  for (const folio of folios) {
    const block = renderFolioSchemeBlock(folio);
    lines.push(...block);
  }
  if (opts?.corruptDate) {
    // Replace the real date string for the named ref with an impossible
    // calendar date (Q10 only) — a controlled, single-field corruption.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`[Ref: ${opts.corruptDate.txnRef}]`) || lines[i].includes(opts.corruptDate.txnRef)) {
        const m = /^(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(lines[i]);
        if (m) lines[i] = lines[i].replace(m[1], opts.corruptDate.badDate);
      }
    }
  }
  return lines;
}

function buildExpected(scenario: Scenario, extra: Record<string, unknown> = {}) {
  const accounts = scenario.folios.map((f) => ({ folioNumber: f.folioNumber, holderName: null, holdingModeRaw: null }));
  const transactions: unknown[] = [];
  const holdings: unknown[] = [];
  for (const folio of scenario.folios) {
    for (const scheme of folio.schemes) {
      for (const t of scheme.transactions) {
        transactions.push({
          folioNumber: folio.folioNumber, scheme: scheme.schemeName, isin: scheme.isin,
          transactionDateIso: t.date, canonicalType: t.expectedType, amount: t.amount.toFixed(2),
          units: t.isFee ? '0.000000' : t.units.toFixed(6), navRaw: t.isFee ? null : t.price.toFixed(6),
          sourceReference: t.isFee ? null : (t.ref ?? null),
        });
      }
      if (scheme.closing) {
        holdings.push({ folioNumber: folio.folioNumber, scheme: scheme.schemeName, units: scheme.closing.units.toFixed(3), value: scheme.closing.value.toFixed(2) });
      }
    }
  }
  return {
    fixtureId: scenario.id, title: scenario.title, sourceKey: 'cams', documentTypeDetected: 'cas_statement', formatVersionDetected: 'detailed_v1_alt_layout',
    statementPeriodStartIso: scenario.periodStart, statementPeriodEndIso: scenario.periodEnd,
    accounts, transactionCount: transactions.length, transactions, holdingCount: holdings.length, holdings,
    notes: scenario.notes ?? null,
    ...extra,
  };
}

function writeFixture(scenario: Scenario, pages: string[][]) {
  const text = pages.map((p) => p.join('\n')).join('\n-- 1 of 2 --\n');
  writeFileSync(join(OUT_DIR, `${scenario.id}.txt`), text, 'utf8');
  const pdf = buildMinimalTextPdf(pages);
  writeFileSync(join(OUT_DIR, `${scenario.id}.pdf`), pdf);
  const expected = buildExpected(scenario);
  writeFileSync(join(OUT_DIR, `${scenario.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${scenario.id} (.txt, .pdf, .expected.json)`);
}

// ==========================================================================
// Shared scheme/account identities (Q01 <-> Q04/Q05 reuse per the spec)
// ==========================================================================
const SCHEME_A = { schemeName: 'Composite Growth Opportunities Fund - Growth (Direct Plan)', isin: 'INF701K01AA1', advisorCode: 'ARN10001' };
const SCHEME_B = { schemeName: 'Diversified Value Builder Fund - Growth (Regular Plan)', isin: 'INF702K01BB2', advisorCode: 'ARN10002' };
const SCHEME_C = { schemeName: 'Emerging Sectors Advantage Fund - Growth (Direct Plan)', isin: 'INF703K01CC3', advisorCode: 'ARN10003' };
const SCHEME_D = { schemeName: 'Balanced Horizon Fund - Growth (Regular Plan)', isin: 'INF704K01DD4', advisorCode: 'ARN10004' };

const Q01_FOLIO1 = folioNo(1, 1);
const Q01_FOLIO2 = folioNo(1, 2);
const Q03_FOLIO_A = folioNo(3, 1);
const Q03_FOLIO_B = folioNo(3, 2);

// ==========================================================================
// Q01 — baseline: multi-AMC(-implicit)/multi-folio, purchase+SIP+redemption,
// Stamp Duty + STT where realistic, correct closing balances, multi-page.
// ==========================================================================
function buildQ01() {
  const t1 = withRunningBalance(0, [
    { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.7605, ref: 'PCRV1-001', indianFormat: true },
    { date: '2025-02-05', description: 'Stamp Duty', expectedType: 'fee', amount: 50, units: 0, price: 0, isFee: true, indianFormat: true },
    { date: '2025-03-15', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, price: 121.36, ref: 'PCRV1-003', indianFormat: true },
  ]);
  const t2 = withRunningBalance(0, [
    { date: '2025-02-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.5, price: 123.46, ref: 'PCRV1-004', indianFormat: true },
    { date: '2025-05-10', description: 'Redemption', expectedType: 'redemption', amount: 3000, units: 20.1, price: 149.25, ref: 'PCRV1-005', indianFormat: true },
    { date: '2025-05-12', description: 'STT', expectedType: 'tax', amount: 90, units: 0, price: 0, isFee: true, indianFormat: true },
  ]);
  const folio1: Folio = { folioNumber: Q01_FOLIO1, pan: pan(1), schemes: [{ ...SCHEME_A, transactions: t1.transactions, closing: { units: t1.closingUnits, value: Math.round(t1.closingUnits * 134.9 * 100) / 100 } }] };
  const folio2: Folio = { folioNumber: Q01_FOLIO2, pan: pan(2), schemes: [{ ...SCHEME_B, transactions: t2.transactions, closing: { units: t2.closingUnits, value: Math.round(t2.closingUnits * 149.25 * 100) / 100 } }] };
  const scenario: Scenario = { id: 'pc3rv-q01-baseline-multi-amc-multi-folio', title: 'Q01 real-variant baseline: multi-folio (implicit multi-AMC via distinct schemes), purchase+SIP+redemption, Stamp Duty + STT, multi-page', periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio1, folio2] };
  // Genuine multi-page: folio1 on page 1, folio2 on page 2 (a clean
  // folio-boundary break, NOT the mid-table stress this pack reserves for
  // Q09/Q12).
  const page1 = renderPage(scenario, [folio1], { includeTitle: true });
  const page2 = renderPage(scenario, [folio2], { includeTitle: false });
  return { scenario, pages: [page1, page2] };
}

// ==========================================================================
// Q03 — same instrument, two folios (F1 account-scope probe)
// ==========================================================================
function buildQ03() {
  const oldTxns = withRunningBalance(0, [{ date: '2024-01-10', description: 'Purchase', expectedType: 'purchase', amount: 12000, units: 100.19, price: 119.77, ref: 'PCRV3-OLD-001', indianFormat: true }]);
  const newPurchase = withRunningBalance(0, [{ date: '2025-05-10', description: 'Purchase', expectedType: 'purchase', amount: 20000, units: 148.94, price: 134.29, ref: 'PCRV3-NEW-001', indianFormat: true }]);
  const newRedemption = withRunningBalance(newPurchase.closingUnits, [{ date: '2025-06-10', description: 'Redemption', expectedType: 'redemption', amount: 8000, units: 58.65, price: 136.4, ref: 'PCRV3-NEW-002', indianFormat: true }]);
  const folioA: Folio = { folioNumber: Q03_FOLIO_A, pan: pan(3), schemes: [{ ...SCHEME_C, transactions: oldTxns.transactions, closing: { units: oldTxns.closingUnits, value: Math.round(oldTxns.closingUnits * 131 * 100) / 100 } }] };
  const folioB: Folio = { folioNumber: Q03_FOLIO_B, pan: pan(3), schemes: [{ ...SCHEME_C, transactions: [...newPurchase.transactions, ...newRedemption.transactions], closing: { units: newRedemption.closingUnits, value: Math.round(newRedemption.closingUnits * 131 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q03-two-folios-fifo-scope', title: 'Q03 real-variant — same instrument in two folios (Folio A older/cheaper, Folio B newer, redemption from Folio B only) — F1 probe',
    periodStart: '2024-01-01', periodEnd: '2025-06-30', folios: [folioA, folioB],
    notes: `Folio A (${Q03_FOLIO_A}) must retain its 100.19 units untouched by Folio B (${Q03_FOLIO_B})'s redemption — zero cross-account contamination required.`,
  };
  return { scenario, pages: [renderPage(scenario, [folioA], { includeTitle: true }), renderPage(scenario, [folioB], { includeTitle: false })] };
}

// ==========================================================================
// Q04 — monthly delta reusing Q01's folio1 AND Q03's folioA identities,
// only new transactions added on top of what those fixtures already had.
// ==========================================================================
function buildQ04() {
  const folio1Txns = withRunningBalance(0, [
    { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.7605, ref: 'PCRV1-001', indianFormat: true }, // identical to Q01 -> must dedup
    { date: '2025-02-05', description: 'Stamp Duty', expectedType: 'fee', amount: 50, units: 0, price: 0, isFee: true, indianFormat: true }, // identical to Q01 -> must dedup
    { date: '2025-03-15', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, price: 121.36, ref: 'PCRV1-003', indianFormat: true }, // identical to Q01 -> must dedup
    { date: '2025-07-15', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 37.9, price: 131.93, ref: 'PCRV4-NEW-001', indianFormat: true }, // genuinely NEW
  ]);
  const folioATxns = withRunningBalance(0, [
    { date: '2024-01-10', description: 'Purchase', expectedType: 'purchase', amount: 12000, units: 100.19, price: 119.77, ref: 'PCRV3-OLD-001', indianFormat: true }, // identical to Q03 -> must dedup
    { date: '2025-06-20', description: 'Purchase', expectedType: 'purchase', amount: 6000, units: 41.36, price: 145.1, ref: 'PCRV4-NEW-002', indianFormat: true }, // genuinely NEW
  ]);
  const folio1: Folio = { folioNumber: Q01_FOLIO1, pan: pan(1), schemes: [{ ...SCHEME_A, transactions: folio1Txns.transactions, closing: { units: folio1Txns.closingUnits, value: Math.round(folio1Txns.closingUnits * 134.9 * 100) / 100 } }] };
  const folioA: Folio = { folioNumber: Q03_FOLIO_A, pan: pan(3), schemes: [{ ...SCHEME_C, transactions: folioATxns.transactions, closing: { units: folioATxns.closingUnits, value: Math.round(folioATxns.closingUnits * 131 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q04-monthly-delta', title: 'Q04 real-variant — monthly delta statement reusing Q01 folio1 and Q03 folioA account identities, only new transactions added',
    periodStart: '2024-01-01', periodEnd: '2025-07-31', folios: [folio1, folioA],
    notes: 'PCRV1-001/PCRV1-002(fee)/PCRV1-003 and PCRV3-OLD-001 are IDENTICAL to Q01/Q03 and must fingerprint-dedup on reimport; PCRV4-NEW-001/PCRV4-NEW-002 are genuinely new.',
  };
  return { scenario, pages: [renderPage(scenario, [folio1], { includeTitle: true }), renderPage(scenario, [folioA], { includeTitle: false })] };
}

// ==========================================================================
// Q06 — SIP-rich, one skipped month (March), resumed April
// ==========================================================================
function buildQ06() {
  const txns = withRunningBalance(0, [
    { date: '2025-01-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, price: 119.76, ref: 'PCRV6-001', indianFormat: true },
    { date: '2025-02-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.51, price: 120.5, ref: 'PCRV6-002', indianFormat: true },
    { date: '2025-04-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.88, price: 122.3, ref: 'PCRV6-003', indianFormat: true },
    { date: '2025-05-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 39.96, price: 125.1, ref: 'PCRV6-004', indianFormat: true },
    { date: '2025-06-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.12, price: 124.63, ref: 'PCRV6-005', indianFormat: true },
  ]);
  const folio: Folio = { folioNumber: folioNo(6, 1), pan: pan(6), schemes: [{ ...SCHEME_D, transactions: txns.transactions, closing: { units: txns.closingUnits, value: Math.round(txns.closingUnits * 124.63 * 100) / 100 } }] };
  const scenario: Scenario = { id: 'pc3rv-q06-sip-rich-skipped-month', title: 'Q06 real-variant — SIP-rich: Jan/Feb/Apr/May/Jun, March deliberately skipped', periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio] };
  return { scenario, pages: [renderPage(scenario, [folio], { includeTitle: true })] };
}

// ==========================================================================
// Q07 — transaction-rich: every canonical type + fee evidence, correct
// opening/closing balance arithmetic from inception (opening = 0 always —
// avoids the class of error the legacy pack's Q07 fixture had).
// ==========================================================================
function buildQ07() {
  const schemeATxns = withRunningBalance(0, [
    { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.76, ref: 'PCRV7-001', indianFormat: true },
    { date: '2025-02-03', description: 'Stamp Duty', expectedType: 'fee', amount: 50, units: 0, price: 0, isFee: true, indianFormat: true },
    { date: '2025-02-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.75, price: 119.76, ref: 'PCRV7-002', indianFormat: true },
    { date: '2025-03-15', description: 'Redemption', expectedType: 'redemption', amount: 3000, units: 24.5, price: 122.4, ref: 'PCRV7-003', indianFormat: true },
    { date: '2025-04-20', description: 'IDCW Payout', expectedType: 'dividend', amount: 450, units: 0, price: 45.2, ref: 'PCRV7-004', indianFormat: true },
    { date: '2025-05-20', description: 'IDCW Reinvestment', expectedType: 'reinvestment', amount: 620, units: 13.5, price: 45.93, ref: 'PCRV7-005', indianFormat: true },
    { date: '2025-06-01', description: 'Switch Out To Diversified Value Builder Fund', expectedType: 'switch_out', amount: 12000, units: 89.66, price: 133.83, ref: 'PCRV7-006', indianFormat: true },
  ]);
  const schemeBTxns = withRunningBalance(0, [{ date: '2025-06-01', description: 'Switch In From Composite Growth Opportunities Fund', expectedType: 'switch_in', amount: 12000, units: 45.4, price: 264.32, ref: 'PCRV7-007', indianFormat: true }]);
  const folio: Folio = {
    folioNumber: folioNo(7, 1), pan: pan(7),
    schemes: [
      { ...SCHEME_A, transactions: schemeATxns.transactions, closing: { units: schemeATxns.closingUnits, value: Math.round(schemeATxns.closingUnits * 134.9 * 100) / 100 } },
      { ...SCHEME_B, transactions: schemeBTxns.transactions, closing: { units: schemeBTxns.closingUnits, value: Math.round(schemeBTxns.closingUnits * 264.1 * 100) / 100 } },
    ],
  };
  const scenario: Scenario = { id: 'pc3rv-q07-transaction-rich', title: 'Q07 real-variant — every canonical transaction type + fee evidence, opening balance correctly zero throughout', periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio] };
  return { scenario, pages: [renderPage(scenario, [folio], { includeTitle: true })] };
}

// ==========================================================================
// Q08 — deliberate reconciliation mismatch: parse succeeds, certification
// must fail.
// ==========================================================================
function buildQ08() {
  const txns = withRunningBalance(0, [{ date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.76, ref: 'PCRV8-001', indianFormat: true }]);
  const folio: Folio = { folioNumber: folioNo(8, 1), pan: pan(8), schemes: [{ ...SCHEME_A, transactions: txns.transactions, closing: { units: 70.0, value: 9443.0 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q08-reconciliation-mismatch', title: 'Q08 real-variant — reconciliation exception: transaction-derived units (83.5) deliberately mismatch stated closing (70.0)',
    periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio],
    notes: 'Statement prints closing=70.0 units but transaction history sums to 83.5 units — reconciliation MUST detect this, never silently certify.',
  };
  return { scenario, pages: [renderPage(scenario, [folio], { includeTitle: true })] };
}

// ==========================================================================
// Q09 — page-continuation (zero header reprint) + AMC transition (a new
// folio/scheme begins right after the first closes).
// ==========================================================================
function buildQ09() {
  const all = withRunningBalance(0, [
    { date: '2025-01-05', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.76, ref: 'PCRV9-001', indianFormat: true },
    { date: '2025-01-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, price: 121.36, ref: 'PCRV9-002', indianFormat: true },
    { date: '2025-02-05', description: 'Stamp Duty', expectedType: 'fee', amount: 45, units: 0, price: 0, isFee: true, indianFormat: true },
    { date: '2025-02-20', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 39.8, price: 125.63, ref: 'PCRV9-004', indianFormat: true },
    // ---- page break falls here, mid-table, ZERO header/label reprint ----
    { date: '2025-03-05', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 38.9, price: 128.53, ref: 'PCRV9-005', indianFormat: true },
    { date: '2025-03-20', description: 'Redemption', expectedType: 'redemption', amount: 3000, units: 22.9, price: 131.23, ref: 'PCRV9-006', indianFormat: true },
  ]);
  const folio1: Folio = { folioNumber: folioNo(9, 1), pan: pan(9), schemes: [{ ...SCHEME_A, transactions: all.transactions, closing: { units: all.closingUnits, value: Math.round(all.closingUnits * 131 * 100) / 100 } }] };
  const txns2 = withRunningBalance(0, [{ date: '2025-04-10', description: 'Purchase', expectedType: 'purchase', amount: 8000, units: 40.0, price: 200.0, ref: 'PCRV9-007', indianFormat: true }]);
  const folio2: Folio = { folioNumber: folioNo(9, 2), pan: pan(10), schemes: [{ ...SCHEME_D, transactions: txns2.transactions, closing: { units: txns2.closingUnits, value: Math.round(txns2.closingUnits * 200 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q09-continuation-amc-transition', title: 'Q09 real-variant — transaction table spans a real PDF page break with ZERO header reprint, then a new folio/scheme (AMC transition) begins',
    periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio1, folio2],
    notes: 'Page 1 ends mid-table (after the 4th row, including one Stamp Duty fee row) with no header/label reprint on page 2 — matching the real statement\'s own confirmed pagination behaviour. Page 2 continues the same table raw, then closes folio 1 and begins folio 2 (the AMC-transition case this grammar expresses — a new, unrelated scheme, never a nameable AMC label).',
  };
  const page1 = [
    `CQAL-STMT-TRK-2026-CAMS-${scenario.id.toUpperCase()}`, 'Consolidated Account Statement', `Statement Period : ${dmyCams(scenario.periodStart)} To ${dmyCams(scenario.periodEnd)}`, '',
    `Folio No: ${folio1.folioNumber}`, `PAN: ${folio1.pan}`, '',
    schemeLine(folio1.schemes[0]), '', HEADER_LINE,
    ...all.transactions.slice(0, 4).map(txnLine),
  ];
  const page2 = [
    ...all.transactions.slice(4).map(txnLine),
    '', `Closing Unit Balance: ${formatPlain(all.closingUnits, 3)} Total Cost Value: Rs. ${formatIndianAmount(Math.round(all.closingUnits * 131 * 100) / 100)}`, '',
    ...renderFolioSchemeBlock(folio2),
  ];
  return { scenario, pages: [page1, page2] };
}

// ==========================================================================
// Q10 — malformed/negative: an impossible calendar date on one row.
// ==========================================================================
function buildQ10() {
  const txns = withRunningBalance(0, [
    { date: '2025-02-28', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.76, ref: 'PCRV10-001-BADDATE', indianFormat: true },
    { date: '2025-03-01', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, price: 121.36, ref: 'PCRV10-002', indianFormat: true },
  ]);
  const folio: Folio = { folioNumber: folioNo(10, 1), pan: pan(11), schemes: [{ ...SCHEME_A, transactions: txns.transactions, closing: { units: txns.closingUnits, value: Math.round(txns.closingUnits * 134.9 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q10-malformed-negative', title: 'Q10 real-variant — controlled malformed: one row carries an impossible calendar date (30-Feb-2025)',
    periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio],
    notes: 'Row 1 (PCRV10-001-BADDATE) is rendered with an impossible date (30-Feb-2025, calendar-invalid) — must be REJECTED with an unparseable_date error-severity warning, never silently coerced/dropped-without-trace. Row 2 (PCRV10-002) must still parse correctly.',
  };
  const pages = [renderPage(scenario, [folio], { includeTitle: true, corruptDate: { folioIdx: 0, txnRef: 'PCRV10-001-BADDATE', badDate: '30-Feb-2025' } })];
  // Oracle intentionally lists only the ONE surviving clean row.
  const expectedOverride = { transactions: [{ folioNumber: folio.folioNumber, scheme: SCHEME_A.schemeName, isin: SCHEME_A.isin, transactionDateIso: '2025-03-01', canonicalType: 'sip', amount: '5000.00', units: '41.200000', navRaw: '121.360000', sourceReference: 'PCRV10-002' }], transactionCount: 1 };
  return { scenario, pages, expectedOverride };
}

// ==========================================================================
// Q11 — dedicated Stamp Duty/STT fee-evidence fixture: multiple
// transactions, some with one fee, some with both, interleaved with
// normal rows — proving fees are never misclassified as units/NAV/a
// separate holding/investment amount.
// ==========================================================================
function buildQ11() {
  const txns = withRunningBalance(0, [
    { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, price: 119.76, ref: 'PCRV11-001', indianFormat: true },
    { date: '2025-02-03', description: 'Stamp Duty', expectedType: 'fee', amount: 50, units: 0, price: 0, isFee: true, indianFormat: true }, // fee-only, tied to the purchase above
    { date: '2025-03-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, price: 121.36, ref: 'PCRV11-003', indianFormat: true },
    { date: '2025-03-11', description: 'Stamp Duty', expectedType: 'fee', amount: 25, units: 0, price: 0, isFee: true, indianFormat: true }, // fee only
    { date: '2025-03-11', description: 'STT', expectedType: 'tax', amount: 60, units: 0, price: 0, isFee: true, indianFormat: true }, // AND tax, same date -- "some with both"
    { date: '2025-05-15', description: 'Redemption', expectedType: 'redemption', amount: 4000, units: 27.6, price: 144.93, ref: 'PCRV11-006', indianFormat: true },
    { date: '2025-05-16', description: 'STT', expectedType: 'tax', amount: 40, units: 0, price: 0, isFee: true, indianFormat: true }, // tax-only, tied to the redemption above
  ]);
  const folio: Folio = { folioNumber: folioNo(11, 1), pan: pan(12), schemes: [{ ...SCHEME_A, transactions: txns.transactions, closing: { units: txns.closingUnits, value: Math.round(txns.closingUnits * 134.9 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q11-fee-evidence', title: 'Q11 real-variant — dedicated Stamp Duty/STT fee-evidence fixture: single-fee and dual-fee (Stamp Duty + STT same date) transactions interleaved with normal rows',
    periodStart: '2025-01-01', periodEnd: '2025-06-30', folios: [folio],
    notes: 'Every fee/tax row must classify as fee/tax with amount only, ZERO units, NULL nav, and NEVER appear as its own holding or be summed into units/NAV of the adjacent economic transaction. Fee rows never affect the running unit balance (FIXTURE_DIRECTION[fee]=FIXTURE_DIRECTION[tax]=0).',
  };
  return { scenario, pages: [renderPage(scenario, [folio], { includeTitle: true })] };
}

// ==========================================================================
// Q12 — continuation-stress: a long transaction list spanning a page
// break with no header reprint, then another folio/scheme/AMC, then
// closing — zero lost/duplicated rows, zero cross-scheme/cross-AMC leakage.
// ==========================================================================
function buildQ12() {
  const raw: Txn[] = [];
  for (let i = 1; i <= 14; i++) {
    const month = (((i - 1) % 12) + 1);
    const day = i % 2 === 0 ? 5 : 20;
    raw.push({ date: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: round6(40 - i * 0.1), price: round6(120 + i * 0.7), ref: `PCRV12-${String(i).padStart(3, '0')}`, indianFormat: true });
  }
  // insert 2 fee rows into the middle of the run, still counted precisely
  raw.splice(7, 0, { date: '2025-07-04', description: 'Stamp Duty', expectedType: 'fee', amount: 35, units: 0, price: 0, isFee: true, indianFormat: true });
  raw.splice(11, 0, { date: '2025-09-11', description: 'STT', expectedType: 'tax', amount: 55, units: 0, price: 0, isFee: true, indianFormat: true });
  const all = withRunningBalance(0, raw);
  const folio1: Folio = { folioNumber: folioNo(12, 1), pan: pan(13), schemes: [{ ...SCHEME_B, transactions: all.transactions, closing: { units: all.closingUnits, value: Math.round(all.closingUnits * 150 * 100) / 100 } }] };
  const txns2 = withRunningBalance(0, [
    { date: '2025-08-01', description: 'Purchase', expectedType: 'purchase', amount: 15000, units: 60.0, price: 250.0, ref: 'PCRV12-EXTRA-001', indianFormat: true },
    { date: '2025-08-15', description: 'Redemption', expectedType: 'redemption', amount: 5000, units: 20.0, price: 250.0, ref: 'PCRV12-EXTRA-002', indianFormat: true },
  ]);
  const folio2: Folio = { folioNumber: folioNo(12, 2), pan: pan(14), schemes: [{ ...SCHEME_D, transactions: txns2.transactions, closing: { units: txns2.closingUnits, value: Math.round(txns2.closingUnits * 250 * 100) / 100 } }] };
  const scenario: Scenario = {
    id: 'pc3rv-q12-continuation-stress', title: 'Q12 real-variant — continuation stress: 16-row transaction list spans a page break with zero header reprint, then a second folio/scheme/AMC begins, then closes',
    periodStart: '2025-01-01', periodEnd: '2025-12-31', folios: [folio1, folio2],
    notes: `Folio 1 (${folio1.folioNumber}) carries 16 rows (14 economic + 2 fee/tax) split mid-table across the page break with zero header reprint. Folio 2 (${folio2.folioNumber}) is a fully independent scheme/account — zero cross-scheme/cross-AMC contamination of units, balances, or transaction counts permitted between the two.`,
  };
  const splitAt = 9; // mid-table, after the first fee row
  const page1 = [
    `CQAL-STMT-TRK-2026-CAMS-${scenario.id.toUpperCase()}`, 'Consolidated Account Statement', `Statement Period : ${dmyCams(scenario.periodStart)} To ${dmyCams(scenario.periodEnd)}`, '',
    `Folio No: ${folio1.folioNumber}`, `PAN: ${folio1.pan}`, '',
    schemeLine(folio1.schemes[0]), '', HEADER_LINE,
    ...all.transactions.slice(0, splitAt).map(txnLine),
  ];
  const page2 = [
    ...all.transactions.slice(splitAt).map(txnLine),
    '', `Closing Unit Balance: ${formatPlain(all.closingUnits, 3)} Total Cost Value: Rs. ${formatIndianAmount(Math.round(all.closingUnits * 150 * 100) / 100)}`, '',
    ...renderFolioSchemeBlock(folio2),
  ];
  return { scenario, pages: [page1, page2] };
}

// ==========================================================================
// Write everything
// ==========================================================================
{
  const { scenario, pages } = buildQ01();
  writeFixture(scenario, pages);
}
{
  // Q02 — encrypted duplicate of Q01, synthetic qualification password
  // (NEVER the real document's password), economically identical to Q01.
  const { scenario: q01Scenario, pages: q01Pages } = buildQ01();
  const encPassword = 'PC3RV-Qualification-2026';
  const enc = buildEncryptedTextPdf(q01Pages, encPassword);
  const encId = 'pc3rv-q02-encrypted-duplicate-of-q01';
  writeFileSync(join(OUT_DIR, `${encId}.pdf`), enc.bytes);
  const expected = buildExpected({ ...q01Scenario, id: encId, title: 'Q02 real-variant — password-protected duplicate of Q01' });
  writeFileSync(join(OUT_DIR, `${encId}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${encId} (.pdf [RC4 encrypted], .expected.json)`);
}
{
  const { scenario, pages } = buildQ03();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ04();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ06();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ07();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ08();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ09();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages, expectedOverride } = buildQ10();
  const text = pages.map((p) => p.join('\n')).join('\n-- 1 of 2 --\n');
  writeFileSync(join(OUT_DIR, `${scenario.id}.txt`), text, 'utf8');
  const pdf = buildMinimalTextPdf(pages);
  writeFileSync(join(OUT_DIR, `${scenario.id}.pdf`), pdf);
  const expected = { ...buildExpected(scenario), ...expectedOverride };
  writeFileSync(join(OUT_DIR, `${scenario.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${scenario.id} (.txt, .pdf, .expected.json) [Q10 oracle overridden to the one surviving clean row]`);
}
{
  const { scenario, pages } = buildQ11();
  writeFixture(scenario, pages);
}
{
  const { scenario, pages } = buildQ12();
  writeFixture(scenario, pages);
}

console.log('\nQ05 = exact reimport of Q04 (pc3rv-q04-monthly-delta.pdf uploaded twice) — no separate fixture file needed.');
console.log('Done. 11 fixture files + oracles written (Q05 reuses Q04).');
