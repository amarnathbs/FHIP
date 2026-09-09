import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';

// Real production incident, 2026-09-07: my own BARE_AMC_NAME_RE fix (see the
// comment above it, and above its two call sites in camsParser.ts) had a
// genuine bug of its own. A scheme whose own name happens to end in the
// words "Mutual Fund" ("Solaris Global Growth Mutual Fund", say) can have
// its header wrap across two physical lines exactly like the earlier
// scheme-header-wrap fix (090adcf) already handles -- line 1 is the scheme
// name alone, line 2 carries "- ISIN: ...(Advisor: ...) Registrar : CAMS".
// Line 1, taken alone, is ALSO shaped exactly like a bare AMC/fund-house
// name line. My first version of the bare-AMC fix checked BARE_AMC_NAME_RE
// BEFORE attempting the wrap match, so it always won the race and
// `continue`d past line 1 as a plain AMC-name reset -- matchAcrossLines
// then started fresh at line 2 ALONE, which is not a match for
// ALT_SCHEME_LINE_RE by itself (no scheme-name prefix), so the scheme
// header failed to resolve at all for that fund on some code paths and, in
// parseTransactions specifically (which had a `continue` the twin
// parseHoldings did not), diverged from parseHoldings' scheme identity for
// the exact same real block -- confirmed live: two parse runs of the same
// real document resolved the same real fund to TWO DIFFERENT ii_instruments
// rows, forking its transaction history.
//
// Fixed by trying the wrap match FIRST and falling back to a plain
// AMC-name reset only when it does not match. This file proves: (a) the
// wrap-shaped case still extracts the full, correct scheme name (not
// swallowed as a bare AMC-name reset), and (b) a genuine standalone bare
// AMC-name line (not followed by a wrap continuation) is still correctly
// treated as an AMC-name reset -- both fixes coexist correctly.
//
// Every value below is invented (folios, PANs, ISINs, ARNs, fund/scheme
// names, amounts) -- reproduces only the structural shape of the incident.

function buildText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-WRAPAMC',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 30-Jun-2025',
    '',
    'Folio No: 9900330099001',
    'PAN: WAMC0011F',
    '',
    // Scheme header wraps across 2 lines; line 1 ALONE is shaped exactly
    // like a bare AMC-name line ("<Name...> Mutual Fund").
    'Solaris Global Growth Mutual Fund',
    '- ISIN: INF666K01CC3(Advisor: ARN00666) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '15-Feb-2025   6,000.00         30.0000      200.000     Purchase                             200.000  [Ref: WRAPAMC-A-001]',
    '',
    'Closing Unit Balance: 200.000 Total Cost Value: 6,000.00',
    '',
    'Folio No: 9900330099002',
    'PAN: WAMC0012F',
    '',
    // A genuine standalone bare AMC-name line -- NOT followed by a wrap
    // continuation, just a normal single-line scheme header next.
    'Meridian Bridge Mutual Fund',
    'Halcyon Debt Opportunities Fund - Growth (Regular Plan) - ISIN: INF444K01BB2(Advisor: ARN00444) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '20-Mar-2025   3,000.00         30.0000      100.000     Purchase                             100.000  [Ref: WRAPAMC-B-001]',
    '',
    'Closing Unit Balance: 100.000 Total Cost Value: 3,000.00',
  ].join('\n');
}

describe('CAMS alt-layout: bare AMC-name line vs wrapped scheme header, priority fix (real production incident, 2026-09-07)', () => {
  it('folio A: a scheme name that itself ends in "Mutual Fund" and wraps to a 2nd line is extracted in FULL, not swallowed as a bare AMC-name reset', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.errors).toEqual([]);
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'WRAPAMC-A-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toBe('Solaris Global Growth Mutual Fund');
    expect(txn!.scheme.isin).toBe('INF666K01CC3');
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '9900330099001');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toBe('Solaris Global Growth Mutual Fund');
  });

  it('folio A: parseTransactions and parseHoldings resolve the IDENTICAL scheme identity for the same real fund (the actual production bug: they diverged)', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'WRAPAMC-A-001');
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '9900330099001');
    expect(txn!.scheme.rawSchemeName).toBe(holding!.scheme.rawSchemeName);
    expect(txn!.scheme.isin).toBe(holding!.scheme.isin);
    expect(txn!.scheme.normalisedSchemeName).toBe(holding!.scheme.normalisedSchemeName);
  });

  it('folio B: a genuine standalone bare AMC-name line still correctly sets amcName on the following scheme (original fix still works)', () => {
    const result = parseExtractedDocument(buildText());
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'WRAPAMC-B-001');
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '9900330099002');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Halcyon Debt Opportunities Fund');
    expect(txn!.scheme.amcName).toBe('Meridian Bridge Mutual Fund');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.amcName).toBe('Meridian Bridge Mutual Fund');
  });
});
