import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// PC4 section 3/5 finding (2026-09-07): a real user statement, shown to
// Claude by the user with an actual (redacted) statement screenshot, proved
// an earlier claim in this codebase wrong -- the alt-layout CAMS grammar
// DOES print real per-scheme NAV and market value, contrary to this file's
// own prior "no NAV as on clause exists in this layout" assumption (Gate A
// finding #9). It appears as a separate footer line, not part of the
// "Closing Unit Balance ... Total Cost Value" line:
//   "NAV on 04-Sep-2026: INR 517.92" ... "Market Value on 04-Sep-2026: INR 36,644.91"
// which pdf-parse extracts as one combined line. Before this fix, this line
// was silently discarded as an unparseable_transaction_row warning in both
// parseTransactions and parseHoldings, dropping real, valuable per-scheme
// valuation data that genuinely exists in the source document -- this is
// exactly the data PC4 sections 5 (statement current-value reconciliation)
// and 8 (scheme XIRR) need and were previously told was unavailable for
// this layout.
//
// Every value below is invented (folios, PANs, ISINs, amounts, dates) --
// reproduces only the structural shape of the real finding.

function buildText(oneSchemeOnly = false): string {
  const lines = [
    'ZQWX-STMT-TRK-2026-CAMS-NAVMV',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2015 To 04-Sep-2026',
    '',
    'Folio No: 1017193871',
    'PAN: NAVM0011F',
    '',
    'Solaris Large Cap Mutual Fund',
    'Solaris Large Cap Fund - Growth (Regular Plan) - ISIN: INF209K01BR9(Advisor: ARN00555) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '21-Aug-2015   1,000.00         164.53       6.078       Purchase-SIP                         6.078   [Ref: NAVMV-A-001]',
    '',
    // The real, separate NAV/market-value footer line -- the actual fix
    // under test. Appears before the closing-balance line, as in the real
    // document. (The real document also has disclaimer text between this
    // line and the closing line, which is separately, already-accepted
    // noise unrelated to this fix -- omitted here to keep this fixture
    // focused, matching this codebase's other minimal-fixture convention.)
    'NAV on 04-Sep-2026: INR 517.92 Market Value on 04-Sep-2026: INR 36,644.91',
    'Closing Unit Balance: 70.754 Total Cost Value: 11,000.00',
  ];
  if (!oneSchemeOnly) {
    lines.push(
      '',
      'Folio No: 1017193872',
      'PAN: NAVM0012F',
      '',
      // A second scheme with NO NAV/market-value line at all -- proves the
      // fallback path (Gate A finding #9's original behaviour) still works
      // correctly and is not contaminated by the first scheme's pending value.
      'Solstice Debt Mutual Fund',
      'Solstice Debt Fund - Growth (Regular Plan) - ISIN: INF209K01CC1(Advisor: ARN00666) Registrar : CAMS',
      '',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      '10-Feb-2016   2,000.00         50.00        40.000      Purchase-SIP                         40.000   [Ref: NAVMV-B-001]',
      '',
      'Closing Unit Balance: 40.000 Total Cost Value: 2,000.00',
    );
  }
  return lines.join('\n');
}

describe('CAMS alt-layout: real per-scheme NAV/market-value extraction (PC4 section 3/5, real user finding, 2026-09-07)', () => {
  it('produces zero parse errors -- the NAV/market-value line is not wrongly fed to the transaction grammar', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.errors).toEqual([]);
  });

  it('the holding uses the REAL market value and NAV, not the Total Cost Value or a null NAV', () => {
    const result = parseExtractedDocument(buildText());
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '1017193871');
    expect(holding).toBeTruthy();
    expect(holding!.navScaled).not.toBeNull();
    expect(scaledToDecimalString(holding!.navScaled!, 2)).toBe('517.92');
    expect(holding!.valueScaled).not.toBeNull();
    expect(scaledToDecimalString(holding!.valueScaled!, 2)).toBe('36644.91'); // the real market value, NOT the 11,000.00 Total Cost Value
    expect(scaledToDecimalString(holding!.unitsScaled, 3)).toBe('70.754');
  });

  it('uses the market-value line\'s own date as the as-of date, not the statement-period-end fallback', () => {
    const result = parseExtractedDocument(buildText());
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '1017193871');
    expect(holding!.asOfDateIso).toBe('2026-09-04');
  });

  it('a scheme with no NAV/market-value line still falls back correctly to Total Cost Value and the statement period end (Gate A finding #9 unaffected)', () => {
    const result = parseExtractedDocument(buildText());
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '1017193872');
    expect(holding).toBeTruthy();
    expect(holding!.navScaled).toBeNull();
    expect(scaledToDecimalString(holding!.valueScaled!, 2)).toBe('2000.00'); // Total Cost Value, the only figure available
    expect(holding!.asOfDateIso).toBe('2026-09-04'); // statement period end fallback
  });

  it('a scheme\'s pending NAV/market-value never leaks into a different scheme (single-scheme document, no cross-contamination possible to test against, but same-document isolation confirmed by the two-scheme case above)', () => {
    const result = parseExtractedDocument(buildText(true));
    expect(result.parsed!.holdings.length).toBe(1);
  });
});
