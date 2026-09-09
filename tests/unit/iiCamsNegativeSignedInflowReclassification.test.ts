import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';

// Real production incident, 2026-09-07 (found during PC4's reconciliation
// gate review): a real CAMS statement records a failed SIP-registration
// retry under the SAME wording as a normal instalment -- no "Rejection"/
// "Reversed" keyword anywhere (e.g. "Systematic Purchase (Continuous
// Offer)Registration Record is not available - Instalment No 1", "...
// Payment not received from investor banker - Instalment No 2"), so
// classifyTransactionType() has no keyword to catch it by. The statement
// DOES still print these rows with a genuine negative (parenthesized)
// Units value -- structurally proving the row is a cancellation, since a
// true purchase/SIP/switch-in can never subtract units by definition.
// Before this fix, reconciliation.ts's DIRECTION_TABLE forced this
// inflow-typed row's contribution to abs(units), silently flipping the
// sign back to positive and double-counting a failed retry as a genuine
// extra contribution.
//
// Every value below is invented (folios, PANs, ISINs, amounts, running
// balances) -- reproduces only the structural shape of the real incident.

function buildText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-NEGINFLOW',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2022 To 31-Dec-2025',
    '',
    'Folio No: 7700880099004',
    'PAN: NGIN0022G',
    '',
    'Meridian Growth Mutual Fund',
    'Zenith Mid Cap Fund - Growth (Regular Plan) - ISIN: INF888L02FF6(Advisor: ARN00888) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                                                Unit Balance',
    // A successful continuous-offer instalment, no matching reversal — must survive untouched.
    '23-Jun-2025   999.95           132.8650     7.526       Systematic Purchase (Continuous Offer) Instalment No - 35/36  344.512  [Ref: NEGINFLOW-GENUINE-001]',
    // A failed registration attempt, printed with negative units but NO reversal/rejection keyword at all.
    '05-Jul-2025   4,999.75         131.7250     37.956      Systematic Purchase (Continuous Offer) - Instalment 1/894     382.468  [Ref: NEGINFLOW-ATTEMPT-001]',
    '05-Jul-2025   (4,999.75)       131.7250     (37.956)    Systematic Purchase (Continuous Offer)Registration Record is not available - Instalment No 1  344.512  [Ref: NEGINFLOW-FAILED-001]',
    '',
    'Closing Unit Balance: 344.512 Total Cost Value: 45,997.70',
  ].join('\n');
}

describe('CAMS: negative-signed inflow rows with no reversal keyword (real production incident, 2026-09-07)', () => {
  it('a genuine positive-units purchase is left untouched', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-GENUINE-001');
    expect(txn).toBeTruthy();
    expect(txn!.canonicalType).toBe('purchase');
  });

  it('the exactly-negated attempt side is ALSO reclassified to reversal once its failed twin is (composes with the existing pairing logic, same convention as a keyword-matched rejection pair)', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-ATTEMPT-001');
    expect(txn).toBeTruthy();
    expect(txn!.canonicalType).toBe('reversal');
  });

  it('the failed attempt (negative units, no reversal keyword) is reclassified to reversal, not left as purchase', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-FAILED-001');
    expect(txn).toBeTruthy();
    expect(txn!.canonicalType).toBe('reversal');
    expect(txn!.classificationConfidence).toBe(1);
  });

  it('end-to-end: the failed attempt contributes zero net units once paired with its positive-sign twin (passthrough sums to zero)', () => {
    const result = parseExtractedDocument(buildText());
    const attempt = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-ATTEMPT-001')!;
    const failed = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-FAILED-001')!;
    expect(attempt.unitsScaled! + failed.unitsScaled!).toBe(BigInt(0));
  });
});

// A distinct, standalone case with NO exact-negation predecessor at all --
// proves this fix does not depend on reclassifyReversedPurchasePairs()'s
// pairing/balance-restoration proof. The real production shape (a
// different-magnitude retry days later, e.g. Kotak Mid Cap's real "Payment
// not received from investor banker" instalment, immediately followed by
// a successful retry at a different NAV/date): the sign alone is enough.

function buildStandaloneText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-NEGINFLOW-STANDALONE',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2022 To 31-Dec-2025',
    '',
    'Folio No: 7700880099005',
    'PAN: NGIN0033H',
    '',
    'Meridian Growth Mutual Fund',
    'Zenith Mid Cap Fund - Growth (Regular Plan) - ISIN: INF888L02FF6(Advisor: ARN00888) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                                                Unit Balance',
    '23-Jun-2025   999.95           132.8650     7.526       Systematic Purchase (Continuous Offer) Instalment No - 35/36  344.512  [Ref: NEGINFLOW-SA-GENUINE-001]',
    // Failed retry, no exact-negation predecessor anywhere in the document (different magnitude from every other row).
    '07-Jul-2025   (5,001.00)       136.1860     (36.719)    Systematic Purchase (Continuous Offer)Payment not received from investor banker - Instalment No 2  344.512  [Ref: NEGINFLOW-SA-FAILED-001]',
    // Successful retry a fortnight later, different magnitude again.
    '23-Jul-2025   999.95           137.5490     7.270       Systematic Purchase (Continuous Offer) Instalment No - 36/36  351.782  [Ref: NEGINFLOW-SA-NEXT-001]',
    '',
    'Closing Unit Balance: 351.782 Total Cost Value: 45,997.70',
  ].join('\n');
}

describe('CAMS: negative-signed inflow row with no pairing partner at all (standalone structural fix)', () => {
  it('the failed retry is reclassified to reversal purely from its own sign, with no matching negation pair anywhere in the document', () => {
    const result = parseExtractedDocument(buildStandaloneText());
    const failed = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-SA-FAILED-001');
    expect(failed).toBeTruthy();
    expect(failed!.canonicalType).toBe('reversal');
  });

  it('the genuine purchases before and after it are untouched', () => {
    const result = parseExtractedDocument(buildStandaloneText());
    const before = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-SA-GENUINE-001');
    const after = result.parsed!.transactions.find((t) => t.sourceReference === 'NEGINFLOW-SA-NEXT-001');
    expect(before!.canonicalType).toBe('purchase');
    expect(after!.canonicalType).toBe('purchase');
  });
});
