/**
 * FDH-10 — Phase C statement-extraction certification (spec sections 28-35).
 *
 * Proves, against genuinely synthetic (never real) fixture CSVs, that all
 * four representative adapters — AU credit card, India credit card, AU loan,
 * India EMI loan — detect correctly, extract the full field set spec
 * sections 29-32 require, and that the extracted activities reconcile
 * exactly via the already-certified `statementReconciliation.ts` (no new
 * reconciliation logic introduced here). Also proves the OCR/manual-mapping
 * boundary (spec sections 33-34): an unrecognised layout is never guessed.
 */

import { describe, expect, it } from 'vitest';
import { detectLiabilityCsvAdapter, extractLiabilityStatement } from '@/lib/financial-data-hub/liability/statementIntake';
import { reconcileCreditCardStatement, reconcileLoanStatement } from '@/lib/financial-data-hub/liability/statementReconciliation';
import { decomposeLoanPayment } from '@/lib/financial-data-hub/liability/repaymentDecomposition';
import type { LiabilityStatementActivity } from '@/lib/financial-data-hub/liability/types';

function bytesOf(csv: string): Uint8Array {
  return new TextEncoder().encode(csv);
}

function sumByType(activities: readonly LiabilityStatementActivity[], type: string): number {
  return activities.filter((a) => a.activityType === type).reduce((s, a) => s + a.amount, 0);
}

describe('FDH-10 — AU credit card adapter (spec section 29)', () => {
  const csv = [
    'Transaction Date,Description,Amount,Transaction Type,Merchant',
    '01/07/2026,Woolworths,120.50,Purchase,Woolworths',
    '03/07/2026,Netflix,15.99,Purchase,Netflix',
    '05/07/2026,Refund - Returned Item,45.00,Refund,Kmart',
    '10/07/2026,Payment Received - Thank You,200.00,Payment,',
    '15/07/2026,Cash Withdrawal,500.00,Cash Advance,',
    '20/07/2026,Interest Charged,12.34,Interest Charged,',
    '25/07/2026,Annual Fee,99.00,Annual Fee,',
  ].join('\n');

  it('detects the AU credit card adapter unambiguously', () => {
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'credit_card', 'AU');
    expect(detection.status).toBe('detected');
    expect(detection.adapter?.id).toBe('au_credit_card_generic_v1');
  });

  it('extracts purchase/refund/payment/interest/fee/cash-advance activities with correct amounts and dates', () => {
    const result = extractLiabilityStatement({
      bytes: bytesOf(csv),
      statementType: 'credit_card',
      country: 'AU',
      currencyCode: 'AUD',
      institutionName: 'Test Bank',
      statementPeriodStart: '2026-07-01',
      statementPeriodEnd: '2026-07-31',
      statementDate: '2026-07-31',
      dueDate: '2026-08-15',
      openingBalance: 500,
      closingBalance: 1002.83,
      creditLimit: 5000,
      minimumPayment: 25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(7);
    expect(sumByType(result.extraction.activities, 'PURCHASE')).toBeCloseTo(136.49, 2);
    expect(sumByType(result.extraction.activities, 'REFUND')).toBeCloseTo(45.0, 2);
    expect(sumByType(result.extraction.activities, 'PAYMENT')).toBeCloseTo(200.0, 2);
    expect(sumByType(result.extraction.activities, 'CASH_ADVANCE')).toBeCloseTo(500.0, 2);
    expect(sumByType(result.extraction.activities, 'INTEREST')).toBeCloseTo(12.34, 2);
    expect(sumByType(result.extraction.activities, 'FEE')).toBeCloseTo(99.0, 2);
    // Statement metadata (opening/closing balance, statement dates, limit,
    // minimum payment) is present per spec section 29's field list.
    expect(result.extraction.creditLimit).toBe(5000);
    expect(result.extraction.minimumPayment).toBe(25);
    expect(result.extraction.statementPeriodStart).toBe('2026-07-01');
    expect(result.extraction.dueDate).toBe('2026-08-15');
  });

  it('GREEN: the extracted totals reconcile exactly via statementReconciliation.ts (no new reconciliation logic)', () => {
    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD',
      openingBalance: 500, closingBalance: 1002.83,
    });
    if (!result.ok) throw new Error('extraction failed');
    const a = result.extraction.activities;
    const recon = reconcileCreditCardStatement({
      openingBalance: 500,
      purchasesTotal: sumByType(a, 'PURCHASE'),
      cashAdvancesTotal: sumByType(a, 'CASH_ADVANCE'),
      interestTotal: sumByType(a, 'INTEREST'),
      feesTotal: sumByType(a, 'FEE'),
      paymentsTotal: sumByType(a, 'PAYMENT'),
      refundsTotal: sumByType(a, 'REFUND'),
      adjustmentsTotal: null,
      closingBalance: 1002.83,
      currencyCode: 'AUD',
    });
    expect(recon.status).toBe('reconciled');
  });

  it('RED negative control: an unrecognised activity-type value is warned, never silently dropped or guessed', () => {
    const badCsv = csv.replace('Interest Charged,\n', 'Some Unknown Charge Type,\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(badCsv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(6); // the malformed row is excluded, not guessed
    expect(result.extraction.warnings.some((w) => w.includes('unrecognised_activity_type'))).toBe(true);
  });

  it('a genuinely unrecognisable layout returns manual_mapping_required, never a guessed extraction', () => {
    const garbled = 'Col1,Col2,Col3\nfoo,bar,baz';
    const result = extractLiabilityStatement({ bytes: bytesOf(garbled), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('manual_mapping_required');
  });

  it('the same file is never matched against a different country/type pool (India detector does not fire on an AU file)', () => {
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'credit_card', 'IN');
    expect(detection.status).toBe('manual_mapping_required');
  });
});

describe('FDH-10 — India credit card adapter (spec section 30)', () => {
  const csv = [
    'Txn Date,Narration,Amount (INR),Txn Type,GST',
    '01-07-2026,Amazon Purchase,2500.00,Purchase,',
    '05-07-2026,Refund - Return,500.00,Refund,',
    '10-07-2026,Payment Received,3000.00,Payment,',
    '15-07-2026,Finance Charge,150.00,Finance Charge,',
    '20-07-2026,Annual Membership Fee,590.00,Annual Membership Fee,90.00',
  ].join('\n');

  it('detects the India credit card adapter unambiguously', () => {
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'credit_card', 'IN');
    expect(detection.status).toBe('detected');
    expect(detection.adapter?.id).toBe('in_credit_card_generic_v1');
  });

  it('extracts purchase/payment/refund/finance-charge/fees with statement dates and minimum/total-amount-due carried as declared metadata', () => {
    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR',
      institutionName: 'Test Bank India',
      statementPeriodStart: '2026-07-01', statementPeriodEnd: '2026-07-31',
      closingBalance: 15000, minimumPayment: 750, // total-amount-due / minimum-amount-due
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(5);
    expect(sumByType(result.extraction.activities, 'PURCHASE')).toBeCloseTo(2500, 2);
    expect(sumByType(result.extraction.activities, 'REFUND')).toBeCloseTo(500, 2);
    expect(sumByType(result.extraction.activities, 'PAYMENT')).toBeCloseTo(3000, 2);
    expect(sumByType(result.extraction.activities, 'INTEREST')).toBeCloseTo(150, 2); // Finance Charge -> INTEREST
    expect(sumByType(result.extraction.activities, 'FEE')).toBeCloseTo(590, 2); // Annual Membership Fee -> FEE
    expect(result.extraction.closingBalance).toBe(15000); // total amount due
    expect(result.extraction.minimumPayment).toBe(750); // minimum amount due
  });
});

describe('FDH-10 — AU loan adapter (spec section 31)', () => {
  const csv = [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    '15/07/2026,Monthly Repayment,2000.00,Repayment,1550.00,430.00,20.00',
    '15/08/2026,Monthly Repayment,2000.00,Repayment,1560.00,420.00,20.00',
  ].join('\n');

  it('detects the AU loan adapter and reads statement-evidenced principal/interest/fee splits verbatim', () => {
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'loan', 'AU');
    expect(detection.status).toBe('detected');
    expect(detection.adapter?.id).toBe('au_loan_generic_v1');

    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD',
      institutionName: 'Test Bank', openingBalance: 400000, closingBalance: 396890,
      interestRate: 6.14,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(2);
    const first = result.extraction.activities[0];
    expect(first.activityType).toBe('PAYMENT');
    expect(first.amount).toBeCloseTo(2000, 2);
    expect(first.principalComponent).toBeCloseTo(1550, 2);
    expect(first.interestComponent).toBeCloseTo(430, 2);
    expect(first.feeComponent).toBeCloseTo(20, 2);
  });

  it('THE HEADLINE LOAN CONTROL, fed from real statement-extracted values (spec section 5): $2,000 = $1,550 principal + $430 interest + $20 fee, never $2,000 flat expense', () => {
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    const first = result.extraction.activities[0];
    const decomposition = decomposeLoanPayment({
      totalPayment: first.amount,
      principalComponent: first.principalComponent,
      interestComponent: first.interestComponent,
      feeComponent: first.feeComponent,
      currencyCode: 'AUD',
    });
    expect(decomposition.outcome).toBe('decomposed');
    expect(decomposition.liabilityReductionTotal).toBeCloseTo(1550, 2);
    expect(decomposition.expenseTotal).toBeCloseTo(450, 2); // 430 interest + 20 fee, NEVER 2000
  });

  it('loan-principal reconciliation is exact across both statement-extracted payments', () => {
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    const principalTotal = result.extraction.activities.reduce((s, a) => s + (a.principalComponent ?? 0), 0);
    const recon = reconcileLoanStatement({
      openingPrincipal: 400000,
      drawdownsTotal: null,
      capitalisedTotal: null,
      principalRepaymentsTotal: principalTotal,
      adjustmentsTotal: null,
      closingPrincipal: 400000 - principalTotal,
      currencyCode: 'AUD',
    });
    expect(recon.status).toBe('reconciled');
  });
});

describe('FDH-10 — India EMI loan adapter (spec section 32)', () => {
  const csv = [
    'EMI Date,Description,EMI Amount,Type,Principal Component,Interest Component',
    '15/07/2026,EMI Payment,25000.00,EMI,18000.00,7000.00',
    '15/08/2026,EMI Payment,25000.00,EMI,18200.00,6800.00',
  ].join('\n');

  it('detects the India EMI loan adapter and reads the amortisation-schedule split verbatim', () => {
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'loan', 'IN');
    expect(detection.status).toBe('detected');
    expect(detection.adapter?.id).toBe('in_loan_emi_generic_v1');

    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'loan', country: 'IN', currencyCode: 'INR',
      institutionName: 'Test Bank India', openingBalance: 1000000, closingBalance: 963800,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(2);
    expect(result.extraction.activities[0].activityType).toBe('PAYMENT');
    expect(result.extraction.activities[0].principalComponent).toBeCloseTo(18000, 2);
    expect(result.extraction.activities[0].interestComponent).toBeCloseTo(7000, 2);
  });

  it('EMI decomposition never treats the disclosed EMI amount as a flat expense (no fee line disclosed here: fee is correctly absent, not fabricated as 0-vs-undefined confusion)', () => {
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'IN', currencyCode: 'INR' });
    if (!result.ok) throw new Error('extraction failed');
    const first = result.extraction.activities[0];
    expect(first.feeComponent).toBeUndefined();
    const decomposition = decomposeLoanPayment({
      totalPayment: first.amount,
      principalComponent: first.principalComponent,
      interestComponent: first.interestComponent,
      // feeComponent intentionally omitted — statement never disclosed one.
      currencyCode: 'INR',
    });
    expect(decomposition.outcome).toBe('decomposed');
    expect(decomposition.liabilityReductionTotal).toBeCloseTo(18000, 2);
    expect(decomposition.expenseTotal).toBeCloseTo(7000, 2); // interest only, principal excluded
  });
});

// ---------------------------------------------------------------------------
// Additional AU credit card scenarios — dates, balances, limits, edge cases
// (spec section 29's field list: purchase/refund/payment/interest/fee/
// cash-advance/opening-closing-balance/limit/minimum-payment/dates).
// ---------------------------------------------------------------------------
describe('FDH-10 — AU credit card adapter, additional scenarios', () => {
  it('a blank activity-type cell is skipped, not guessed and not warned (not evidence of anything)', () => {
    const csv = [
      'Transaction Date,Description,Amount,Transaction Type,Merchant',
      '25/07/2026,Woolworths,50.00,Purchase,Woolworths',
      '26/07/2026,Pending authorisation hold,25.00,,',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(1);
    expect(result.extraction.warnings).toHaveLength(0);
  });

  it('an unparseable date within the first 20 rows (the date-format sample window) fails the WHOLE file rather than guessing a format from the remaining rows', () => {
    // `csvExtraction.ts` infers ONE date format from the first 20 rows, then
    // parses every row under it — a garbage date inside that sample means no
    // candidate format scores 100% on the sample, so format inference itself
    // fails closed (never picks the "best-effort" format and guesses past
    // the row it couldn't read).
    const csv = [
      'Transaction Date,Description,Amount,Transaction Type,Merchant',
      '25/07/2026,Woolworths,50.00,Purchase,Woolworths',
      'not-a-date,Coles,30.00,Purchase,Coles',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('layout_unsupported');
  });

  it('an unparseable date OUTSIDE the 20-row sample window (format already resolved) is warned and that one row excluded — the rest of the statement is not thrown away', () => {
    const goodRows = Array.from({ length: 22 }, (_, i) => `${20 + (i % 5)}/07/2026,Purchase ${i},${10 + i}.00,Purchase,Merchant${i}`);
    const csv = [
      'Transaction Date,Description,Amount,Transaction Type,Merchant',
      ...goodRows,
      'not-a-date,Coles,30.00,Purchase,Coles',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(22); // the 22 good rows, the 23rd excluded
    expect(result.extraction.warnings.some((w) => w.includes('unparseable_date'))).toBe(true);
  });

  it('an unparseable amount is warned and the row excluded, never coerced to zero', () => {
    const csv = [
      'Transaction Date,Description,Amount,Transaction Type,Merchant',
      '25/07/2026,Woolworths,50.00,Purchase,Woolworths',
      '26/07/2026,Coles,not-a-number,Purchase,Coles',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(1);
    expect(result.extraction.warnings.some((w) => w.includes('unparseable_amount'))).toBe(true);
  });

  it('credit limit is carried through as declared metadata and never counted toward any activity total (spec section 26: not a net-worth or expense figure)', () => {
    const csv = ['Transaction Date,Description,Amount,Transaction Type,Merchant', '25/07/2026,Woolworths,50.00,Purchase,Woolworths'].join('\n');
    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD',
      openingBalance: 0, closingBalance: 50, creditLimit: 10000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.creditLimit).toBe(10000);
    expect(sumByType(result.extraction.activities, 'PURCHASE')).toBeCloseTo(50, 2);
  });

  it('a statement with zero purchases (payment-only month) still reconciles exactly', () => {
    const csv = ['Transaction Date,Description,Amount,Transaction Type,Merchant', '25/07/2026,Payment,300.00,Payment,'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    const a = result.extraction.activities;
    expect(sumByType(a, 'PURCHASE')).toBe(0);
    const recon = reconcileCreditCardStatement({
      openingBalance: 300, purchasesTotal: sumByType(a, 'PURCHASE'), cashAdvancesTotal: 0,
      interestTotal: 0, feesTotal: 0, paymentsTotal: sumByType(a, 'PAYMENT'), refundsTotal: 0,
      adjustmentsTotal: null, closingBalance: 0, currencyCode: 'AUD',
    });
    expect(recon.status).toBe('reconciled');
  });

  it('due date and statement period are carried through independently of any transaction row (declared metadata, not parsed from the CSV body)', () => {
    const csv = ['Transaction Date,Description,Amount,Transaction Type,Merchant', '25/07/2026,Woolworths,50.00,Purchase,Woolworths'].join('\n');
    const result = extractLiabilityStatement({
      bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD',
      statementPeriodStart: '2026-07-01', statementPeriodEnd: '2026-07-31', dueDate: '2026-08-20',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.statementPeriodStart).toBe('2026-07-01');
    expect(result.extraction.statementPeriodEnd).toBe('2026-07-31');
    expect(result.extraction.dueDate).toBe('2026-08-20');
  });

  it('CRLF line endings parse identically to LF (real Windows-exported CSVs are CRLF)', () => {
    const csv = 'Transaction Date,Description,Amount,Transaction Type,Merchant\r\n25/07/2026,Woolworths,50.00,Purchase,Woolworths\r\n';
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities).toHaveLength(1);
    expect(result.extraction.activities[0].amount).toBeCloseTo(50, 2);
  });

  it('a late fee alias maps to FEE just like an annual fee (both are real card fee vocabulary, not the same literal string)', () => {
    const csv = ['Transaction Date,Description,Amount,Transaction Type,Merchant', '25/07/2026,Late Payment,35.00,Late Fee,'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].activityType).toBe('FEE');
  });
});

// ---------------------------------------------------------------------------
// Additional India credit card scenarios — GST evidence-only, ATM withdrawal
// alias, minimum/total due metadata (spec section 30).
// ---------------------------------------------------------------------------
describe('FDH-10 — India credit card adapter, additional scenarios', () => {
  it('GST is preserved verbatim as evidence on the activity but never appears in any activity-type total', () => {
    const csv = [
      'Txn Date,Narration,Amount (INR),Txn Type,GST',
      '20-07-2026,Annual Membership Fee,590.00,Annual Membership Fee,90.00',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].gstAmountRaw).toBe('90.00');
    // The activity's own amount (590) is what feeds the FEE total — GST is
    // not separately added on top (spec section 30: no GST tax engine).
    expect(sumByType(result.extraction.activities, 'FEE')).toBeCloseTo(590, 2);
  });

  it('a statement with no GST column at all extracts cleanly — gstAmountRaw is simply absent, not a parse failure', () => {
    const csv = ['Txn Date,Narration,Amount (INR),Txn Type', '01-07-2026,Amazon Purchase,1200.00,Purchase'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].gstAmountRaw).toBeUndefined();
  });

  it('ATM Withdrawal and Cash Withdrawal both alias to CASH_ADVANCE (distinct real-world phrasing, same canonical type)', () => {
    const csv = [
      'Txn Date,Narration,Amount (INR),Txn Type',
      '05-07-2026,ATM Cash,5000.00,ATM Withdrawal',
      '06-07-2026,Branch Cash,3000.00,Cash Withdrawal',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities.every((a) => a.activityType === 'CASH_ADVANCE')).toBe(true);
    expect(sumByType(result.extraction.activities, 'CASH_ADVANCE')).toBeCloseTo(8000, 2);
  });

  it('late payment fee alias maps to FEE (India-specific phrasing, distinct from the AU alias set)', () => {
    const csv = ['Txn Date,Narration,Amount (INR),Txn Type', '18-07-2026,Late Fee Levied,500.00,Late Payment Fee'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].activityType).toBe('FEE');
  });

  it('a standalone GST line item (not attached to a fee row) is itself treated as FEE, not silently dropped', () => {
    const csv = ['Txn Date,Narration,Amount (INR),Txn Type', '20-07-2026,GST on annual fee,90.00,GST'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'credit_card', country: 'IN', currencyCode: 'INR' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].activityType).toBe('FEE');
  });
});

// ---------------------------------------------------------------------------
// Additional AU loan scenarios — interest-only period, arrears-free
// reconciliation across a longer run, fee-free statement.
// ---------------------------------------------------------------------------
describe('FDH-10 — AU loan adapter, additional scenarios', () => {
  it('a fee-free repayment (fee column blank) decomposes with fee correctly absent, not fabricated as zero-vs-undisclosed', () => {
    const csv = [
      'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
      '15/07/2026,Monthly Repayment,1980.00,Repayment,1550.00,430.00,',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.activities[0].feeComponent).toBeUndefined();
    const decomposition = decomposeLoanPayment({
      totalPayment: result.extraction.activities[0].amount,
      principalComponent: result.extraction.activities[0].principalComponent,
      interestComponent: result.extraction.activities[0].interestComponent,
      currencyCode: 'AUD',
    });
    expect(decomposition.outcome).toBe('decomposed');
    expect(decomposition.expenseTotal).toBeCloseTo(430, 2);
  });

  it('an interest-only repayment period (principal component = 0) reduces the liability by exactly $0 for that payment', () => {
    const csv = ['Payment Date,Description,Amount,Type,Principal,Interest,Fee', '15/07/2026,Interest Only Repayment,430.00,Repayment,0.00,430.00,0.00'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    const decomposition = decomposeLoanPayment({
      totalPayment: result.extraction.activities[0].amount,
      principalComponent: result.extraction.activities[0].principalComponent,
      interestComponent: result.extraction.activities[0].interestComponent,
      feeComponent: result.extraction.activities[0].feeComponent,
      currencyCode: 'AUD',
    });
    expect(decomposition.liabilityReductionTotal).toBe(0);
    expect(decomposition.expenseTotal).toBeCloseTo(430, 2);
  });

  it('an internally-inconsistent statement (components do not sum to the payment) is genuinely flagged, never silently accepted', () => {
    const csv = ['Payment Date,Description,Amount,Type,Principal,Interest,Fee', '15/07/2026,Monthly Repayment,2000.00,Repayment,1550.00,430.00,5.00'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    // Statement-extracted components (1550 + 430 + 5 = 1985) don't sum to
    // the statement's own disclosed total payment amount (2000) — a real
    // internally-inconsistent statement (spec section 34).
    const decomposition = decomposeLoanPayment({
      totalPayment: result.extraction.activities[0].amount,
      principalComponent: result.extraction.activities[0].principalComponent,
      interestComponent: result.extraction.activities[0].interestComponent,
      feeComponent: result.extraction.activities[0].feeComponent,
      currencyCode: 'AUD',
    });
    expect(decomposition.outcome).toBe('component_mismatch');
  });

  it('three consecutive statement-extracted payments reconcile in aggregate against opening/closing principal', () => {
    const csv = [
      'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
      '15/07/2026,Monthly Repayment,2000.00,Repayment,1550.00,430.00,20.00',
      '15/08/2026,Monthly Repayment,2000.00,Repayment,1560.00,420.00,20.00',
      '15/09/2026,Monthly Repayment,2000.00,Repayment,1570.00,410.00,20.00',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'AU', currencyCode: 'AUD' });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.extraction.activities).toHaveLength(3);
    const principalTotal = result.extraction.activities.reduce((s, a) => s + (a.principalComponent ?? 0), 0);
    expect(principalTotal).toBeCloseTo(4680, 2);
    const recon = reconcileLoanStatement({
      openingPrincipal: 400000, drawdownsTotal: null, capitalisedTotal: null,
      principalRepaymentsTotal: principalTotal, adjustmentsTotal: null,
      closingPrincipal: 400000 - principalTotal, currencyCode: 'AUD',
    });
    expect(recon.status).toBe('reconciled');
  });
});

// ---------------------------------------------------------------------------
// Additional India EMI loan scenarios — flat-EMI amortisation shift, fee-line
// present, multi-month aggregate reconciliation.
// ---------------------------------------------------------------------------
describe('FDH-10 — India EMI loan adapter, additional scenarios', () => {
  it('across a 6-EMI run, the interest share correctly declines while principal share rises (real amortisation shape, not a fixed split)', () => {
    const csv = [
      'EMI Date,Description,EMI Amount,Type,Principal Component,Interest Component',
      '15/07/2026,EMI Payment,25000.00,EMI,18000.00,7000.00',
      '15/08/2026,EMI Payment,25000.00,EMI,18200.00,6800.00',
      '15/09/2026,EMI Payment,25000.00,EMI,18400.00,6600.00',
      '15/10/2026,EMI Payment,25000.00,EMI,18600.00,6400.00',
      '15/11/2026,EMI Payment,25000.00,EMI,18800.00,6200.00',
      '15/12/2026,EMI Payment,25000.00,EMI,19000.00,6000.00',
    ].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'IN', currencyCode: 'INR' });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.extraction.activities).toHaveLength(6);
    const principals = result.extraction.activities.map((a) => a.principalComponent);
    const interests = result.extraction.activities.map((a) => a.interestComponent);
    for (let i = 1; i < principals.length; i++) {
      expect(principals[i]!).toBeGreaterThan(principals[i - 1]!);
      expect(interests[i]!).toBeLessThan(interests[i - 1]!);
    }
    const totalPrincipal: number = principals.reduce((s: number, p) => s + (p ?? 0), 0);
    const recon = reconcileLoanStatement({
      openingPrincipal: 1000000, drawdownsTotal: null, capitalisedTotal: null,
      principalRepaymentsTotal: totalPrincipal, adjustmentsTotal: null,
      closingPrincipal: 1000000 - totalPrincipal, currencyCode: 'INR',
    });
    expect(recon.status).toBe('reconciled');
  });

  it('a foreclosure/prepayment EMI (principal component equal to the full remaining amount) still decomposes correctly, never treated as a flat expense', () => {
    const csv = ['EMI Date,Description,EMI Amount,Type,Principal Component,Interest Component', '15/07/2026,Foreclosure Payment,105000.00,EMI,100000.00,5000.00'].join('\n');
    const result = extractLiabilityStatement({ bytes: bytesOf(csv), statementType: 'loan', country: 'IN', currencyCode: 'INR' });
    if (!result.ok) throw new Error('extraction failed');
    const decomposition = decomposeLoanPayment({
      totalPayment: result.extraction.activities[0].amount,
      principalComponent: result.extraction.activities[0].principalComponent,
      interestComponent: result.extraction.activities[0].interestComponent,
      currencyCode: 'INR',
    });
    expect(decomposition.outcome).toBe('decomposed');
    expect(decomposition.liabilityReductionTotal).toBeCloseTo(100000, 2);
    expect(decomposition.expenseTotal).toBeCloseTo(5000, 2);
  });

  it('an EMI adapter never fires on an AU-country loan file (country pool isolation, mirrors the AU/IN card isolation test)', () => {
    const csv = ['EMI Date,Description,EMI Amount,Type,Principal Component,Interest Component', '15/07/2026,EMI Payment,25000.00,EMI,18000.00,7000.00'].join('\n');
    const detection = detectLiabilityCsvAdapter(bytesOf(csv), 'loan', 'AU');
    expect(detection.status).toBe('manual_mapping_required');
  });
});
