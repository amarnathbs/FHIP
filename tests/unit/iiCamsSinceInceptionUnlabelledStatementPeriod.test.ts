import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';

// Real production incident, 2026-09-07 (final piece of the holdings_found:
// 0 investigation): a real "since inception" CAS request (spanning the
// account's entire history, not a fixed period) prints its date range
// WITHOUT the "Statement Period :" label at all — just a bare
// "01-Jan-1990 To 06-Sep-2026" line, reprinted as a per-page tracking
// stamp. extractMetadata() only recognised the labelled form, so
// statementPeriodEndIso stayed null for the whole document — and
// ALT_CLOSING_RE's holdings extraction depends on that as its as-of-date
// fallback (its own closing-balance line carries no date). Even after
// fixing ALT_CLOSING_RE's currency-marker bug (the first of three real
// bugs found investigating this one incident), holdings_found stayed 0 for
// every scheme, since every closing-balance match hit the "no statement
// period end available" guard instead of producing a holding.
//
// Every value below is invented (folios, PANs, ISINs, amounts, dates,
// tracking-stamp text) — reproduces only the structural shape of the real
// document (the bare, unlabelled "since inception" date-range reprint),
// not any of its actual content.

function buildText(): string {
  return [
    'ZQWX-STMTWS-070926110000 Version:V3.5 Live-2026',
    'Consolidated Account Statement',
    '01-Jan-1990 To 15-Aug-2026',
    '',
    'Folio No: 7700990011002',
    'PAN: SINC0011F',
    '',
    'Bare AMC Mutual Fund',
    'Zenith Growth Opportunities Fund - Growth (Regular Plan) - ISIN: INF321K01DD4(Advisor: ARN00321) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '10-Feb-2025   5,000.00         25.0000      200.000     Purchase                             200.000  [Ref: SINC-A-001]',
    '',
    // The since-inception real document's grammar: no explicit date on the
    // closing line, and no "Statement Period :" labelled line anywhere in
    // the whole document (checked below) — the fallback must resolve to
    // the bare date range's own end date, 2026-08-15.
    'Closing Unit Balance: 200.000 Total Cost Value: 5,000.00',
  ].join('\n');
}

describe('CAMS alt-layout: since-inception unlabelled statement-period fallback (real production incident, 2026-09-07)', () => {
  it('the document genuinely contains no labelled "Statement Period :" line (confirms this fixture reproduces the real shape)', () => {
    expect(buildText()).not.toMatch(/Statement Period\s*:/i);
  });

  it('holdings are now produced using the bare date range\'s end date as the fallback as-of-date', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.errors).toEqual([]);
    const holding = result.parsed!.holdings.find((h) => h.folioNumber === '7700990011002');
    expect(holding).toBeTruthy();
    expect(holding!.asOfDateIso).toBe('2026-08-15');
    expect(holding!.scheme.rawSchemeName).toContain('Zenith Growth Opportunities Fund');
  });

  it('the sentinel start date (01-Jan-1990) is never asserted as a real statementPeriodStartIso', () => {
    const result = parseExtractedDocument(buildText());
    // Accessed via the same metadata the fallback itself uses — confirms
    // the sentinel start date is deliberately not surfaced as a real fact.
    expect(result.parsed!.metadata.statementPeriodStartIso).toBeNull();
    expect(result.parsed!.metadata.statementPeriodEndIso).toBe('2026-08-15');
  });
});
