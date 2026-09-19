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

// Real production incident, 2026-09-19 (Axis Large Cap Fund, 2016-02-08):
// two same-day SIP instalments happened to carry the exact same
// amount/units (a fixed monthly instalment size), and BOTH were rejected
// the same day, back to back. The original one-step-back-only algorithm
// correctly paired the SECOND rejection with the SECOND purchase
// (immediately preceding), but then had nothing left to pair the FIRST
// rejection with once it also looked only one step back — leaving the
// first purchase stuck as a permanent, uncancelled 'sip' contribution.
// Every value below is invented; only the structural shape (two same-day,
// same-magnitude instalment/rejection pairs, each carrying its own
// instalment-sequence token) reproduces the real incident.
function buildAxisStyleText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-AXISDOUBLE',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2009 To 31-Dec-2012',
    '',
    'Folio No: 5500660077004',
    'PAN: RVPR0022G',
    '',
    'Vantage Growth Mutual Fund',
    'Meridian Large Cap Fund - Growth (Regular Plan) - ISIN: INF777K02FF6(Advisor: ARN00777) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '08-Feb-2016   1,000.00         70.5900      14.166      Sys. Investment (5/12)               100.000   [Ref: AXISDBL-PURCHASE-1]',
    '08-Feb-2016   1,000.00         70.5900      14.166      Sys. Investment (6/12)               114.166   [Ref: AXISDBL-PURCHASE-2]',
    '08-Feb-2016   (1,000.00)       70.5900      (14.166)    Sys. Investment Rejection (6/12)     100.000   [Ref: AXISDBL-REJECT-2]',
    '08-Feb-2016   (1,000.00)       70.5900      (14.166)    Sys. Investment Rejection (5/12)     85.834    [Ref: AXISDBL-REJECT-1]',
    '',
    'Closing Unit Balance: 85.834 Total Cost Value: 0.00',
  ].join('\n');
}

describe('CAMS: two same-day, same-magnitude rejected instalments both correctly paired (Axis Large Cap Fund, real production incident, 2026-09-19)', () => {
  it('the second rejection pairs with the second purchase (immediately preceding — the simple case still works)', () => {
    const result = parseExtractedDocument(buildAxisStyleText());
    const purchase2 = result.parsed!.transactions.find((t) => t.sourceReference === 'AXISDBL-PURCHASE-2');
    const reject2 = result.parsed!.transactions.find((t) => t.sourceReference === 'AXISDBL-REJECT-2');
    expect(purchase2!.canonicalType).toBe('reversal');
    expect(reject2!.canonicalType).toBe('reversal');
  });

  it('the first rejection correctly pairs with the first purchase, TWO positions back — not left stranded as a real contribution', () => {
    const result = parseExtractedDocument(buildAxisStyleText());
    const purchase1 = result.parsed!.transactions.find((t) => t.sourceReference === 'AXISDBL-PURCHASE-1');
    const reject1 = result.parsed!.transactions.find((t) => t.sourceReference === 'AXISDBL-REJECT-1');
    expect(purchase1!.canonicalType).toBe('reversal');
    expect(reject1!.canonicalType).toBe('reversal');
    expect(purchase1!.classificationConfidence).toBe(1);
  });

  it('end-to-end: zero real contributions remain — both instalments were genuinely rejected', () => {
    const result = parseExtractedDocument(buildAxisStyleText());
    const realContributions = result.parsed!.transactions.filter((t) => t.canonicalType === 'purchase' || t.canonicalType === 'sip');
    expect(realContributions.length).toBe(0);
  });
});

// Real production incident, 2026-09-19 (Franklin India Mid Cap Fund,
// 2016-02-08): two UNRELATED, parallel SIP series ("6/7" and "5/33")
// happened to fire the same day for the same scheme, coincidentally with
// the exact same amount/units. Only "6/7" was later rejected; "5/33" was
// a genuine, separate, never-reversed contribution. The row immediately
// before the rejection in the statement's own order is "5/33" (NOT the
// transaction actually being reversed) — a naive nearest-match would
// wrongly reclassify the genuine "5/33" contribution as reversed and
// leave the real "6/7" purchase stuck as an uncancelled contribution.
// Every value below is invented; only the structural shape (two
// unrelated, same-magnitude series, one genuinely reversed, disambiguated
// by their own printed instalment tokens) reproduces the real incident.
function buildFranklinStyleText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-FRANKLININTERLEAVE',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2009 To 31-Dec-2012',
    '',
    'Folio No: 5500660077005',
    'PAN: RVPR0033H',
    '',
    'Vantage Growth Mutual Fund',
    'Solstice Mid Cap Fund - Growth (Regular Plan) - ISIN: INF777K03GG7(Advisor: ARN00777) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '08-Feb-2016   1,000.00         62.5800      15.980      Sys. Investment (6/7)                50.000    [Ref: FRINTL-TARGET-PURCHASE]',
    '08-Feb-2016   1,000.00         62.5800      15.980      Sys. Investment (5/33)               65.980    [Ref: FRINTL-UNRELATED-PURCHASE]',
    '08-Feb-2016   (1,000.00)       62.5800      (15.980)    Sys. Investment Rejection (6/7)      50.000    [Ref: FRINTL-TARGET-REJECT]',
    '',
    'Closing Unit Balance: 50.000 Total Cost Value: 1,000.00',
  ].join('\n');
}

describe('CAMS: interleaved unrelated same-magnitude transaction correctly skipped when pairing a reversal (Franklin India Mid Cap Fund, real production incident, 2026-09-19)', () => {
  it('the true target purchase ("6/7", two positions back) is paired with its rejection', () => {
    const result = parseExtractedDocument(buildFranklinStyleText());
    const target = result.parsed!.transactions.find((t) => t.sourceReference === 'FRINTL-TARGET-PURCHASE');
    const reject = result.parsed!.transactions.find((t) => t.sourceReference === 'FRINTL-TARGET-REJECT');
    expect(target!.canonicalType).toBe('reversal');
    expect(reject!.canonicalType).toBe('reversal');
    expect(target!.classificationConfidence).toBe(1);
  });

  it('the unrelated intervening purchase ("5/33") is left untouched as a genuine contribution', () => {
    const result = parseExtractedDocument(buildFranklinStyleText());
    const unrelated = result.parsed!.transactions.find((t) => t.sourceReference === 'FRINTL-UNRELATED-PURCHASE');
    expect(unrelated!.canonicalType).toBe('sip');
  });

  it('end-to-end: exactly one real contribution remains ("5/33"), not zero and not two', () => {
    const result = parseExtractedDocument(buildFranklinStyleText());
    const realContributions = result.parsed!.transactions.filter((t) => t.canonicalType === 'purchase' || t.canonicalType === 'sip');
    expect(realContributions.length).toBe(1);
    expect(realContributions[0].sourceReference).toBe('FRINTL-UNRELATED-PURCHASE');
  });
});

// When two same-day, same-magnitude candidates satisfy the balance proof
// AND neither carries a distinguishing instalment token (so the tie
// breaker itself cannot resolve which one a reversal actually undoes),
// the never-guess discipline must win: leave every candidate exactly as
// parsed, rather than picking one arbitrarily. This is the same
// discipline the zero-candidate case already has — extended to the
// multiple-equally-valid-candidates case found while building this fix.
function buildGenuinelyAmbiguousText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-AMBIGUOUS',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2009 To 31-Dec-2012',
    '',
    'Folio No: 5500660077006',
    'PAN: RVPR0044I',
    '',
    'Vantage Growth Mutual Fund',
    'Horizon Flexi Cap Fund - Growth (Regular Plan) - ISIN: INF777K04HH8(Advisor: ARN00777) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '08-Feb-2016   1,000.00         50.0000      20.000      Additional Purchase                  50.000    [Ref: AMBIG-PURCHASE-A]',
    '08-Feb-2016   1,000.00         50.0000      20.000      Additional Purchase                  70.000    [Ref: AMBIG-PURCHASE-B]',
    '08-Feb-2016   (1,000.00)       50.0000      (20.000)    Purchase - Reversed                  50.000    [Ref: AMBIG-REJECT]',
    '',
    'Closing Unit Balance: 50.000 Total Cost Value: 1,000.00',
  ].join('\n');
}

describe('CAMS: genuinely ambiguous same-magnitude candidates with no distinguishing token are left untouched (never guess)', () => {
  it('neither candidate purchase is reclassified when the arithmetic and the instalment-token tie breaker both fail to uniquely resolve', () => {
    const result = parseExtractedDocument(buildGenuinelyAmbiguousText());
    const purchaseA = result.parsed!.transactions.find((t) => t.sourceReference === 'AMBIG-PURCHASE-A');
    const purchaseB = result.parsed!.transactions.find((t) => t.sourceReference === 'AMBIG-PURCHASE-B');
    const reject = result.parsed!.transactions.find((t) => t.sourceReference === 'AMBIG-REJECT');
    expect(purchaseA!.canonicalType).toBe('purchase');
    expect(purchaseB!.canonicalType).toBe('purchase');
    expect(reject!.canonicalType).toBe('reversal'); // the rejection line's OWN wording is still correctly classified — only the pairing to a specific purchase side is withheld
  });
});
