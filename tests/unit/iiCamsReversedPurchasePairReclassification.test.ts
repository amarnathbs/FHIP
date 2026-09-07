import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';

// Real production incident, 2026-09-07 (PC4 section 7/11 finding): fixing
// only the explicitly-worded rejection line's classification (a prior fix,
// commit 94873a1) left its PAIRED purchase line still classified 'sip' —
// still counted in full toward "Total Contributed" even though zero net
// units and zero net cash actually moved for that instalment. Confirmed
// live: after the rejection-only fix, a real fund's displayed total
// dropped from ~71,000 to ~35,000 (35 unpaired purchase-side amounts),
// still wrong — the real total was a single ~1,000 genuine contribution.
//
// This proves the deterministic pairing rule: a reversal's own running
// Unit Balance (printed by the statement itself) exactly restores the
// balance to what it was BEFORE the immediately preceding transaction.
// When that preceding transaction is a same-date, same-folio, same-scheme,
// exact-negated-amount purchase-family transaction, the pairing is
// structurally proven by the statement's own numbers -- never guessed
// from description wording alone.
//
// Every value below is invented (folios, PANs, ISINs, amounts, running
// balances) -- reproduces only the structural shape of the real incident.

function buildText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-REVPAIR',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2009 To 31-Dec-2012',
    '',
    'Folio No: 5500660077003',
    'PAN: RVPR0011F',
    '',
    'Vantage Growth Mutual Fund',
    'Solaris Insure Growth Fund - Growth (Regular Plan) - ISIN: INF777K01EE5(Advisor: ARN00777) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    // Genuine standalone contribution -- no matching reversal, must survive untouched.
    '10-Jan-2009   1,000.00         66.4900      15.041      Purchase                             15.041   [Ref: REVPAIR-GENUINE-001]',
    // A rejected pair: purchase brings balance to 28.763, same-date reversal restores it to 15.041 (the pre-purchase balance).
    '10-Feb-2009   1,000.00         72.8700      13.722      SIP Insure (14/48)                   28.763   [Ref: REVPAIR-PAIR-PURCHASE-001]',
    '10-Feb-2009   (1,000.00)       72.8700      (13.722)    Systematic Investment Rejection      15.041   [Ref: REVPAIR-PAIR-REJECT-001]',
    // A second rejected pair, immediately after, same pattern.
    '10-Mar-2009   1,000.00         77.6600      12.875      SIP Insure (15/48)                   27.916   [Ref: REVPAIR-PAIR-PURCHASE-002]',
    '10-Mar-2009   (1,000.00)       77.6600      (12.875)    Systematic Investment Rejection      15.041   [Ref: REVPAIR-PAIR-REJECT-002]',
    '',
    'Closing Unit Balance: 15.041 Total Cost Value: 1,000.00',
  ].join('\n');
}

describe('CAMS: reversed purchase/rejection PAIR reclassification (PC4 section 7/11, real production incident, 2026-09-07)', () => {
  it('the genuine standalone purchase (no matching reversal) is left untouched', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'REVPAIR-GENUINE-001');
    expect(txn).toBeTruthy();
    expect(txn!.canonicalType).toBe('purchase');
  });

  it('the first rejected pair: BOTH the purchase side and the rejection side are classified as reversal', () => {
    const result = parseExtractedDocument(buildText());
    const purchaseSide = result.parsed!.transactions.find((t) => t.sourceReference === 'REVPAIR-PAIR-PURCHASE-001');
    const rejectSide = result.parsed!.transactions.find((t) => t.sourceReference === 'REVPAIR-PAIR-REJECT-001');
    expect(purchaseSide).toBeTruthy();
    expect(rejectSide).toBeTruthy();
    expect(purchaseSide!.canonicalType).toBe('reversal');
    expect(rejectSide!.canonicalType).toBe('reversal');
    expect(purchaseSide!.classificationConfidence).toBe(1);
  });

  it('the second rejected pair (immediately following the first) is also fully reclassified', () => {
    const result = parseExtractedDocument(buildText());
    const purchaseSide = result.parsed!.transactions.find((t) => t.sourceReference === 'REVPAIR-PAIR-PURCHASE-002');
    const rejectSide = result.parsed!.transactions.find((t) => t.sourceReference === 'REVPAIR-PAIR-REJECT-002');
    expect(purchaseSide!.canonicalType).toBe('reversal');
    expect(rejectSide!.canonicalType).toBe('reversal');
  });

  it('end-to-end: only the genuine 1,000 contribution remains counted as a real purchase', () => {
    const result = parseExtractedDocument(buildText());
    const realContributions = result.parsed!.transactions.filter((t) => t.canonicalType === 'purchase' || t.canonicalType === 'sip');
    expect(realContributions.length).toBe(1);
    expect(realContributions[0].sourceReference).toBe('REVPAIR-GENUINE-001');
  });
});
