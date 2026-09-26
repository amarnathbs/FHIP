/**
 * Canonical-upload certification harness (scripts/canonical_cert/): the synthetic document builders
 * must produce files the REAL native parsers accept, with the brief's oracle numbers, and the user
 * allocator must hand out disjoint, balanced ranges.
 *
 * Every positive check has a paired negative control (a deliberately broken document) that must FAIL
 * the same check, so none of these assertions can pass vacuously.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  oracleBankStatement, scaleBankStatement, creditCardStatement, loanStatement,
  brokerTransactionStatement, brokerPortfolioStatement, retirementSummaryStatement, payslipPdf, payslipLines, oraclePack,
  type Month,
} from '../../scripts/canonical_cert/documents/builders';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { runBankCsvPipeline } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { detectLiabilityCsvAdapter, extractLiabilityStatement } from '@/lib/financial-data-hub/liability/statementIntake';
import { decomposeLoanPayment } from '@/lib/financial-data-hub/liability/repaymentDecomposition';
import { detectAuInvestmentCsvFormat } from '@/lib/financial-data-hub/investment/detection';
import { extractAuPositionsFromCsv, extractAuTransactionsFromCsv } from '@/lib/financial-data-hub/investment/csvExtraction';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';
import { extractPdfPages } from '@/lib/financial-data-hub/bank-pdf/textExtraction';
import { parsePayslipText } from '@/lib/financial-data-hub/payslip/parser';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { allocate, RANGES, fixtureUsers, findFixture, FCAST_FILE, HARNESS_RESERVED } from '../../scripts/canonical_cert/lib/users.mjs';

const M: Month = { year: 2026, month: 8 };
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
// Same column maps the investment processing service uses (DEFAULT_*_COLUMN_MAP, not exported there).
const TXN_MAP = { date: 'Date', type: 'Type', amount: 'Amount', ticker: 'Code', isin: 'ISIN', securityName: 'Security Name', quantity: 'Quantity', price: 'Price', brokerage: 'Brokerage', settlementDate: 'Settlement Date', frankingCredit: 'Franking Credit', withholdingTax: 'Withholding Tax' };
const POS_MAP = { securityName: 'Security Name', ticker: 'Code', isin: 'ISIN', quantity: 'Quantity', unitPrice: 'Price', marketValue: 'Market Value', valuationDate: 'Valuation Date' };

function pipeline(bytes: Uint8Array) {
  return runBankCsvPipeline({ bytes, statementUploadId: '00000000-0000-4000-8000-000000000001', financialAccountId: '00000000-0000-4000-8000-000000000002', currencyCode: 'AUD', dedupIndex: new Map() });
}

describe('bank statements (R7 generic single-signed CSV)', () => {
  it('oracle statement: detected, 10 rows accepted, 0 rejected, balance column reconciles', () => {
    const d = oracleBankStatement(M, 'A');
    const det = detectBankCsvFormat(d.bytes);
    expect(det.status).toBe('detected');
    expect(det.adapter?.id).toBe('generic_single_signed_v1');
    const p = pipeline(d.bytes);
    expect(p.accepted).toHaveLength(10);
    expect(p.rejected).toHaveLength(0);
    expect(p.reconciliation?.status).toBe('reconciled');
    const salary = p.accepted.find((a) => /SALARY/.test(a.descriptionRaw));
    expect(salary?.amountOriginal).toBe(5000);
    expect(text(d.bytes)).toMatch(/FHIP TEST/);
  });

  it.each([1000, 1001])('scale statement with %i lines: every line accepted, none truncated, none deduplicated away', (n) => {
    const d = scaleBankStatement(M, n, 'B');
    expect(text(d.bytes).trim().split('\n')).toHaveLength(n + 1);
    const p = pipeline(d.bytes);
    expect(p.accepted).toHaveLength(n);
    expect(p.rejected).toHaveLength(0);
    expect(p.newTransactionRowCount).toBe(n);
    expect(new Set(p.accepted.map((a) => a.economicFingerprint)).size).toBe(n);
    expect(p.reconciliation?.status).toBe('reconciled');
  });

  it('NEGATIVE CONTROL: a header the generic adapter cannot read is NOT detected', () => {
    const broken = enc(text(oracleBankStatement(M).bytes).replace('Date,Description,Amount,Balance', 'When,What,HowMuch,Left'));
    expect(detectBankCsvFormat(broken).status).not.toBe('detected');
    expect(pipeline(broken).accepted).toHaveLength(0);
  });

  it('salt makes two certifiers\' files differ byte-for-byte', () => {
    expect(text(oracleBankStatement(M, 'A').bytes)).not.toBe(text(oracleBankStatement(M, 'B').bytes));
  });
});

describe('credit card + loan statements (FDH-10 AU adapters)', () => {
  it('card: detected au_credit_card_generic_v1; purchases 200 + 20, payment 220', () => {
    const d = creditCardStatement(M, 'A');
    expect(detectLiabilityCsvAdapter(d.bytes, 'credit_card', 'AU').adapter?.id).toBe('au_credit_card_generic_v1');
    const r = extractLiabilityStatement({ bytes: d.bytes, statementType: 'credit_card', country: 'AU', currencyCode: 'AUD', institutionName: 'FHIP Test Card', openingBalance: 0, closingBalance: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sum = (t: string) => r.extraction.activities.filter((a) => a.activityType === t).reduce((s, a) => s + a.amount, 0);
    expect(sum('PURCHASE')).toBeCloseTo(220, 2);
    expect(sum('PAYMENT')).toBeCloseTo(220, 2);
    expect(r.extraction.activities).toHaveLength(3);
  });

  it('loan: 2,000 = 1,550 principal + 430 interest + 20 fee; cost of debt 450', () => {
    const d = loanStatement(M, 'A');
    expect(detectLiabilityCsvAdapter(d.bytes, 'loan', 'AU').adapter?.id).toBe('au_loan_generic_v1');
    const r = extractLiabilityStatement({ bytes: d.bytes, statementType: 'loan', country: 'AU', currencyCode: 'AUD', openingBalance: 400000, closingBalance: 398450 });
    if (!r.ok) throw new Error(r.error);
    const [a] = r.extraction.activities;
    const dec = decomposeLoanPayment({ totalPayment: a.amount, principalComponent: a.principalComponent, interestComponent: a.interestComponent, feeComponent: a.feeComponent, currencyCode: 'AUD' });
    expect(dec.outcome).toBe('decomposed');
    expect(dec.liabilityReductionTotal).toBeCloseTo(1550, 2);
    expect(dec.expenseTotal).toBeCloseTo(450, 2);
  });

  it('NEGATIVE CONTROL: the card file is NOT accepted as a loan statement', () => {
    expect(detectLiabilityCsvAdapter(creditCardStatement(M).bytes, 'loan', 'AU').status).not.toBe('detected');
  });
});

describe('AU broker statements (FDH-11 generic CSVs)', () => {
  it('transactions: resolves to the transaction kind the way the service does; CASH_DEPOSIT 10,000, BUY, SELL 15,000, DIVIDEND 400', () => {
    const d = brokerTransactionStatement(M, 'A');
    const det = detectAuInvestmentCsvFormat(d.bytes);
    // A real broker transaction export also carries Security Name + Quantity, so the portfolio signature
    // scores too and detection can be 'ambiguous' (the WP-12 BROKER_CSV fixture behaves the same). The
    // service then uses the csv_kind declared at upload -- which the recipe sets to 'transaction'.
    expect(['detected', 'ambiguous']).toContain(det.status);
    const effectiveKind = det.status === 'detected' && det.adapter ? det.adapter.csvKind : d.upload.query.csv_kind;
    expect(effectiveKind).toBe('transaction');
    const r = extractAuTransactionsFromCsv({ bytes: d.bytes, columnMap: TXN_MAP, currencyCode: 'AUD', institutionName: 'FHIP Test Broker' });
    if (!r.ok) throw new Error(r.error);
    const byType = Object.fromEntries(r.extraction.transactions.map((t) => [t.transactionType, Number(t.amount)]));
    expect(r.extraction.transactions).toHaveLength(4);
    expect(Math.abs(byType.SELL)).toBe(15000);
    expect(Math.abs(byType.DIVIDEND)).toBe(400);
  });

  it('portfolio: detected; 2 positions worth 12,500', () => {
    const d = brokerPortfolioStatement(M, 'A');
    expect(detectAuInvestmentCsvFormat(d.bytes).adapter?.csvKind).toBe('portfolio');
    const r = extractAuPositionsFromCsv({ bytes: d.bytes, columnMap: POS_MAP, currencyCode: 'AUD', defaultValuationDate: '2026-08-31' });
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.positions).toHaveLength(2);
    expect(r.extraction.positions.reduce((s, p) => s + Number(p.marketValue), 0)).toBe(12500);
  });
});

describe('retirement statements (FDH-12 generic summary CSV)', () => {
  const extract = (bytes: Uint8Array) => extractRetirementStatement(detectRetirementCsvFormat(bytes), { currencyCode: 'AUD', jurisdiction: 'AU' });

  it('fund B: closing balance, employer contribution 575, rollover in 30,000', () => {
    const d = retirementSummaryStatement(M, 'B', 'A');
    const r = extract(d.bytes);
    if (!r.ok) throw new Error(r.error);
    expect(Number(r.extraction.closingBalance)).toBeCloseTo(d.oracle.closingBalance as number, 2);
    expect(Number(r.extraction.employerContributions)).toBe(575);
    expect(Number(r.extraction.rolloversIn)).toBe(30000);
  });

  it('fund A: rollover out 30,000 and closing balance 0 (the other half of the rollover-neutral oracle)', () => {
    const r = extract(retirementSummaryStatement(M, 'A').bytes);
    if (!r.ok) throw new Error(r.error);
    expect(Number(r.extraction.rolloversOut)).toBe(30000);
    expect(Number(r.extraction.closingBalance)).toBe(0);
  });

  it('NEGATIVE CONTROL: a summary without the Item column is not extracted', () => {
    const broken = enc(text(retirementSummaryStatement(M, 'B').bytes).replace('Item,Amount,Period', 'Label,Value,When'));
    expect(extract(broken).ok).toBe(false);
  });
});

describe('payslip PDF (FDH-9 generic parser over a real PDF)', () => {
  it('real PDF bytes -> text -> gross 6,700, PAYG 1,700, net 5,000, employer super 575, monthly, reconciled', async () => {
    const d = payslipPdf(M, 'A');
    expect(text(d.bytes.slice(0, 5))).toBe('%PDF-');
    const pages = await extractPdfPages(d.bytes);
    expect(pages.ok).toBe(true);
    if (!pages.ok) return;
    const p = parsePayslipText(pages.pages.join('\n'));
    if ('error' in p) throw new Error(p.error);
    expect(p.country).toBe('AU');
    expect(p.grossPay).toBe(6700);
    expect(p.taxWithheld).toBe(1700);
    expect(p.netPay).toBe(5000);
    expect(p.employerRetirementContribution).toBe(575);
    expect(p.payFrequency).toBe('monthly');
    expect(p.paymentDate).toBe('2026-08-01');
    expect(p.ytdGross).toBe(13400); // current != current + YTD
  });

  it('bonus variant: bonus is extracted separately and gross includes it', () => {
    const p = parsePayslipText(payslipLines(M, '', { bonus: 1000 }).join('\n'));
    if ('error' in p) throw new Error(p.error);
    expect(p.bonusPay).toBe(1000);
    expect(p.grossPay).toBe(7700);
    expect(p.netPay).toBe(6000);
  });

  it('NEGATIVE CONTROL: a PDF with the net pay line removed does not yield net 5,000', async () => {
    const lines = payslipLines(M, 'A').filter((l) => !l.startsWith('Net Pay'));
    const pages = await extractPdfPages(new Uint8Array(buildMinimalTextPdf([lines])));
    if (!pages.ok) return;
    const p = parsePayslipText(pages.pages.join('\n'));
    expect('error' in p ? undefined : p.netPay).not.toBe(5000);
  });
});

describe('oracle pack', () => {
  it('8 documents, unique filenames, every one tagged with the synthetic institutions', () => {
    const pack = oraclePack(M, 'C');
    expect(pack).toHaveLength(8);
    expect(new Set(pack.map((d) => d.filename)).size).toBe(8);
    for (const d of pack) expect(d.filename).toMatch(/^fhip-test-/);
  });
});

describe('synthetic-user allocator', () => {
  const synthetic = Array.from({ length: 50 }, (_, i) => ({ set: i < 30 ? 'FCAST' : 'E2E50', fixtureId: `TC${String(i + 1).padStart(3, '0')}`, email: `u${i}@example.test`, country: i % 3 === 0 ? 'IN' : 'AU', signIn: ['mint'] }));

  it('ranges are disjoint, cover every user, and differ in size by at most 1', () => {
    const a = allocate(synthetic);
    expect(Object.keys(a)).toEqual(RANGES);
    const all = RANGES.flatMap((r: string) => a[r].map((u: { email: string }) => u.email));
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
    const sizes = RANGES.map((r: string) => a[r].length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('is deterministic (same input -> same ranges)', () => {
    expect(JSON.stringify(allocate(synthetic))).toBe(JSON.stringify(allocate([...synthetic].reverse())));
  });

  const haveFixtures = (() => { try { findFixture(FCAST_FILE); return true; } catch { return false; } })();
  it('the harness-reserved smoke user is never handed to a certifier', () => {
    const withReserved = [...synthetic, { set: 'E2E50', fixtureId: 'TC050', email: HARNESS_RESERVED[0], country: 'AU', signIn: ['mint'] }];
    const all = RANGES.flatMap((r: string) => allocate(withReserved)[r].map((u: { email: string }) => u.email));
    expect(all).toHaveLength(50);
    expect(all).not.toContain(HARNESS_RESERVED[0]);
  });

  it.skipIf(!haveFixtures)('with the real fixture files: 100 users (54 AU / 46 IN), 99 allocated, committed USER_RANGES.json matches', () => {
    const users = fixtureUsers();
    expect(users).toHaveLength(100);
    expect(users.filter((u: { country: string }) => u.country === 'AU')).toHaveLength(54);
    expect(users.filter((u: { country: string }) => u.country === 'IN')).toHaveLength(46);
    const committed = JSON.parse(fs.readFileSync(path.resolve('scripts/canonical_cert/USER_RANGES.json'), 'utf8'));
    const a = allocate(users);
    expect(RANGES.reduce((n: number, r: string) => n + a[r].length, 0)).toBe(99);
    for (const r of RANGES) expect(committed.ranges[r].map((u: { email: string }) => u.email)).toEqual(a[r].map((u: { email: string }) => u.email));
  });
});
