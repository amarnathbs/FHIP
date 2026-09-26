/**
 * NAV 1 completion (2026-09-27), brief P4 -- the UI-journey statement pack goes
 * through the PRODUCTION extraction library and parser exactly as an upload
 * would, before anyone uploads it. Oracles are the generator's own
 * .expected.json (scripts/nav1_p4_ui_journey_fixture.ts), which never calls
 * the parser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractPdfText } from '@/lib/services/investment-intelligence/pdfExtraction';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

const DIR = join(process.cwd(), 'lib', 'fixtures', 'investment-intelligence', 'nav1-p4-ui-journey');
type Expected = { schemes: Array<{ folio: string; amfiCode: string; isin: string; transactions: Array<{ date: string; units: string; nav: string; ref: string }>; closingUnits: string; fullyRedeemed: boolean }> };

async function parse(id: string) {
  const extraction = await extractPdfText(readFileSync(join(DIR, `${id}.pdf`)));
  if (!extraction.ok) throw new Error(`${id}.pdf did not extract: ${extraction.kind} ${extraction.error}`);
  return { result: parseExtractedDocument(extraction.text), expected: JSON.parse(readFileSync(join(DIR, `${id}.expected.json`), 'utf8')) as Expected };
}

describe('NAV1 P4 UI-journey statement pack', () => {
  it('main statement: CAMS detected, zero parse errors, every transaction with the oracle date/units/NAV', async () => {
    const { result, expected } = await parse('nav1-p4-main');
    expect(result.detection.parser).not.toBeNull();
    expect(result.parsed!.errors).toEqual([]);
    const txns = result.parsed!.transactions;
    const want = expected.schemes.flatMap((s) => s.transactions.map((t) => ({ ...t, folio: s.folio })));
    expect(txns.length).toBe(want.length);
    for (const w of want) {
      const t = txns.find((x) => x.sourceReference === w.ref);
      expect(t, w.ref).toBeDefined();
      expect(t!.folioNumber).toBe(w.folio);
      expect(t!.transactionDateIso).toBe(w.date);
      expect(Number(scaledToDecimalString(t!.unitsScaled!))).toBeCloseTo(Number(w.units), 3);
      expect(Number(scaledToDecimalString(t!.navScaled!))).toBeCloseTo(Number(w.nav), 4);
    }
  });

  it('main statement: genuine identifiers carried through (AMFI code + ISIN agree), and the SBI scheme closes at 0.000 (fully redeemed)', async () => {
    const { result, expected } = await parse('nav1-p4-main');
    for (const s of expected.schemes) {
      const inScheme = result.parsed!.transactions.filter((t) => t.folioNumber === s.folio);
      expect(inScheme.length).toBe(s.transactions.length);
      for (const t of inScheme) {
        expect(t.scheme.isin).toBe(s.isin);
        expect(t.scheme.amfiSchemeCode).toBe(s.amfiCode);
      }
    }
    const sbiHolding = result.parsed!.holdings.find((h) => h.scheme.amfiSchemeCode === '103504');
    if (sbiHolding) expect(scaledToDecimalString(sbiHolding.unitsScaled)).toMatch(/^0(\.0+)?$/);
    expect(expected.schemes.find((s) => s.amfiCode === '103504')!.fullyRedeemed).toBe(true);
    expect(expected.schemes.find((s) => s.amfiCode === '122639')!.fullyRedeemed).toBe(false);
    // oldest transaction predates the NAV 1 changeover date
    const oldest = expected.schemes.flatMap((s) => s.transactions.map((t) => t.date)).sort()[0];
    expect(oldest < '2026-09-21').toBe(true);
  });

  it('unresolved statement parses (the exception is raised at scheme resolution, not by the parser)', async () => {
    const { result } = await parse('nav1-p4-unresolved');
    expect(result.detection.parser).not.toBeNull();
    expect(result.parsed!.transactions.length).toBe(1);
  });
});
