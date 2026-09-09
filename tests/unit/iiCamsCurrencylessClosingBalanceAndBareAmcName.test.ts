import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// Real production incident, 2026-09-07: a real CAMS consolidated statement
// (alternate/free-text-header layout) reported "succeeded" with
// schemes_found: 8, transactions_found: 300, but holdings_found: 0, plus
// spurious `unparseable_transaction_row` errors on lines that were neither
// transactions nor malformed. Root-caused to TWO real gaps in camsParser.ts,
// both traced directly against the real run's own error array (see the
// "Post-Gate-A production finding" / "Post-Gate-A production finding #2"
// comments above ALT_CLOSING_RE and BARE_AMC_NAME_RE):
//
// 1. ALT_CLOSING_RE required a "Rs."/"₹" currency marker before the
//    "Total Cost Value" amount, but the real document prints that amount
//    with NO currency marker at all ("Total Cost Value: 93,000.00"). Every
//    existing synthetic fixture happened to include "Rs.", so this was
//    never exercised — the regex silently matched zero closing-balance
//    lines, `parseHoldings()` produced zero holdings, and in
//    `parseTransactions()` `inTable` never reset, so the closing-balance
//    line and the following AMC-name line were both wrongly fed to the
//    transaction-row grammar as fabricated `unparseable_transaction_row`
//    errors.
// 2. The AMC/fund-house name also appears as a bare, unlabelled line (just
//    "<Name> Mutual Fund", no "AMC Name:" prefix) — a third real-world
//    header shape undocumented in either existing grammar. Without
//    recognising it, `lastKnownAmcName` stayed stale at the previous
//    scheme's AMC, silently misattributing fund-house identity for every
//    scheme that follows one of these bare headers.
//
// Every value below is invented (folios, PANs, ISINs, ARNs, fund/scheme/AMC
// names, amounts) — this fixture reproduces only the STRUCTURAL shape of
// the real failure, matching this codebase's own "zero real values"
// fixture convention (see pc3-q11-alternate-cams-layout.* and
// iiCamsWrappedSchemeHeaderAndKfintechRegistrar.test.ts for the precedent).

function buildText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-NOCUR',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 30-Jun-2025',
    '',
    'Folio No: 8800220099001',
    'PAN: NOCU0011F',
    '',
    // Bare, unlabelled AMC/fund-house name -- no "AMC Name:" prefix.
    'Vantage Mutual Fund',
    'Solaris Flexi Cap Fund - Growth (Regular Plan) - ISIN: INF555K01AA1(Advisor: ARN00555) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '05-Feb-2025   8,000.00         40.0000      200.000     Purchase                             200.000  [Ref: NOCUR-A-001]',
    '',
    // Real-world shape: NO "Rs."/"₹" marker before the amount.
    'Closing Unit Balance: 200.000 Total Cost Value: 8,000.00',
    '',
    'Folio No: 8800220099002',
    'PAN: NOCU0012F',
    '',
    // A DIFFERENT bare AMC name -- proves lastKnownAmcName doesn't bleed
    // through from the previous scheme once this is fixed.
    'Meridian Bridge Mutual Fund',
    'Halcyon Debt Opportunities Fund - Growth (Regular Plan) - ISIN: INF444K01BB2(Advisor: ARN00444) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '12-Mar-2025   3,000.00         30.0000      100.000     Purchase                             100.000  [Ref: NOCUR-B-001]',
    '',
    'Closing Unit Balance: 100.000 Total Cost Value: 3,000.00',
  ].join('\n');
}

describe('CAMS alt-layout: currency-less closing balance + bare AMC name (real production incident, 2026-09-07)', () => {
  it('produces zero parse errors -- neither the closing-balance line nor the AMC-name line is wrongly fed to the transaction grammar', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.errors).toEqual([]);
  });

  it('folio A: currency-less closing balance now produces a holding (was silently dropped before the fix)', () => {
    const result = parseExtractedDocument(buildText());
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '8800220099001');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toContain('Solaris Flexi Cap Fund');
    expect(scaledToDecimalString(holding!.unitsScaled, 3)).toBe('200.000');
    expect(holding!.valueScaled).not.toBeNull();
    expect(scaledToDecimalString(holding!.valueScaled!, 2)).toBe('8000.00');
  });

  it('folio B: currency-less closing balance now produces a holding', () => {
    const result = parseExtractedDocument(buildText());
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '8800220099002');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toContain('Halcyon Debt Opportunities Fund');
    expect(scaledToDecimalString(holding!.unitsScaled, 3)).toBe('100.000');
  });

  it('both folios produce exactly one holding each -- none silently dropped', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.holdings.length).toBe(2);
    expect(result.parsed!.transactions.length).toBe(2);
  });

  it('bare AMC-name lines are correctly attached to their OWN scheme, not stale-inherited from the previous one', () => {
    const result = parseExtractedDocument(buildText());
    const holdingA = result.parsed!.holdings.find((h) => h.folioNumber === '8800220099001');
    const holdingB = result.parsed!.holdings.find((h) => h.folioNumber === '8800220099002');
    expect(holdingA!.scheme.amcName).toBe('Vantage Mutual Fund');
    expect(holdingB!.scheme.amcName).toBe('Meridian Bridge Mutual Fund');
    const txnA = result.parsed!.transactions.find((t) => t.sourceReference === 'NOCUR-A-001');
    const txnB = result.parsed!.transactions.find((t) => t.sourceReference === 'NOCUR-B-001');
    expect(txnA!.scheme.amcName).toBe('Vantage Mutual Fund');
    expect(txnB!.scheme.amcName).toBe('Meridian Bridge Mutual Fund');
  });
});
