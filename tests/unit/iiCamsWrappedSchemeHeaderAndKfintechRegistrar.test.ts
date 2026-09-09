import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// Real production incident, 2026-09-06/07: a genuine real CAMS consolidated
// statement (the alternate/free-text-header layout, see camsParser.ts's
// file-header comment and its "Post-Gate-A production finding" note above
// ALT_SCHEME_LINE_RE) came back with 0 holdings and probable scheme
// mis-attribution despite the run reporting "succeeded", because that
// document's scheme-header block ("<scheme> - ISIN: <isin>(Advisor: <code>)
// Registrar : <registrar>") was wrapping across 2-3 physical lines
// depending on the PDF's own page layout, and one of its schemes was
// registered with KFintech rather than CAMS. Every value below is invented
// (folios, PANs, ISINs, ARNs, fund/scheme names, amounts) -- this fixture
// reproduces the STRUCTURAL shape of the real failure (built from the
// abstracted facts already written into the code comment, matching this
// codebase's own "zero real values" fixture convention -- see
// pc3-q11-alternate-cams-layout.* for the precedent this follows), not any
// of the real document's actual content.

function buildText(): string {
  return [
    'ZQWX-STMT-TRK-2026-CAMS-WRAP',
    'Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 30-Jun-2025',
    '',
    'Folio No: 7700110099001',
    'PAN: ZQWX0011F',
    '',
    // Folio A: scheme name itself splits mid-hyphen across two lines --
    // mirrors the real "...(formerly ... merged) (Non" / "-Demat) - ISIN:
    // ..." split. Registrar is CAMS.
    'Aurora Multi-Cap Growth Fund - Growth Plan (Non',
    '-Demat) - ISIN: INF999K01ZZ9(Advisor: ARN00999) Registrar : CAMS',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '01-Feb-2025   10,000.00        50.0000      200.000     Purchase                             200.000  [Ref: WRAP-A-001]',
    '',
    'Closing Unit Balance: 200.000 Total Cost Value: Rs. 10,000.00',
    '',
    'Folio No: 7700110099002',
    'PAN: ZQWX0012F',
    '',
    // Folio B: the registrar word itself splits across the line break --
    // mirrors the real "...Registrar :" / "KFINTECH" split. Registrar is
    // KFintech, not CAMS (the other real India RTA -- a single statement
    // can and does span both across different AMCs).
    'Solstice Balanced Fund - Growth (Regular Plan) - ISIN: INF888K01YY8(Advisor: ARN00888) Registrar :',
    'KFINTECH',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '15-Mar-2025   5,000.00         100.0000     50.000      Purchase                             50.000   [Ref: WRAP-B-001]',
    '',
    'Closing Unit Balance: 50.000 Total Cost Value: Rs. 5,000.00',
    '',
    'Folio No: 7700110099003',
    'PAN: ZQWX0013F',
    '',
    // Folio C: BOTH quirks at once, spanning all 3 lines the fix's
    // lookahead is bounded to -- scheme name wraps AND the registrar word
    // wraps, with KFintech again.
    'Meridian Equity Value Fund - Growth (Institutional',
    'Plan) - ISIN: INF777K01XX7(Advisor: ARN00777) Registrar :',
    'KFINTECH',
    '',
    'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
    '20-Apr-2025   2,000.00         40.0000      50.000      Purchase                             50.000   [Ref: WRAP-C-001]',
    '',
    'Closing Unit Balance: 50.000 Total Cost Value: Rs. 2,000.00',
  ].join('\n');
}

describe('CAMS alt-layout scheme header: multi-line wrap + KFintech registrar (real production incident, 2026-09-07)', () => {
  it('detects the document as CAMS (alt layout) despite the wrapped/KFintech headers', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.detection.parser?.parserCode).toBe('cams_detailed_v1');
    expect(result.detection.detection.sourceKey).toBe('cams');
    expect(result.detection.detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('folio A (2-line wrap, mid-hyphen split, CAMS registrar): scheme correctly attached to both the transaction and the closing holding', () => {
    const result = parseExtractedDocument(buildText());
    const parsed = result.parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'WRAP-A-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Aurora Multi-Cap Growth Fund');
    expect(txn!.scheme.isin).toBe('INF999K01ZZ9');
    const holding = parsed.holdings.find((h) => h.folioNumber === '7700110099001');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toContain('Aurora Multi-Cap Growth Fund');
    expect(scaledToDecimalString(holding!.unitsScaled, 3)).toBe('200.000');
  });

  it('folio B (2-line wrap, registrar word split, KFintech registrar): scheme correctly attached, not silently dropped for using a non-CAMS registrar', () => {
    const result = parseExtractedDocument(buildText());
    const parsed = result.parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'WRAP-B-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Solstice Balanced Fund');
    expect(txn!.scheme.isin).toBe('INF888K01YY8');
    const holding = parsed.holdings.find((h) => h.folioNumber === '7700110099002');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toContain('Solstice Balanced Fund');
    expect(scaledToDecimalString(holding!.unitsScaled, 3)).toBe('50.000');
  });

  it('folio C (3-line wrap, both quirks at once, KFintech registrar): still correctly attached at the bound of the lookahead window', () => {
    const result = parseExtractedDocument(buildText());
    const parsed = result.parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'WRAP-C-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Meridian Equity Value Fund');
    expect(txn!.scheme.isin).toBe('INF777K01XX7');
    const holding = parsed.holdings.find((h) => h.folioNumber === '7700110099003');
    expect(holding).toBeTruthy();
    expect(holding!.scheme.rawSchemeName).toContain('Meridian Equity Value Fund');
  });

  it('all three folios produce exactly one holding each -- none silently dropped', () => {
    const result = parseExtractedDocument(buildText());
    expect(result.parsed!.holdings.length).toBe(3);
    expect(result.parsed!.transactions.length).toBe(3);
  });
});
