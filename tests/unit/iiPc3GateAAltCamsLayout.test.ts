import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractPdfText } from '@/lib/services/investment-intelligence/pdfExtraction';
import { parseExtractedDocument, detectSource } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// II-PC3 Gate A — alternate CAMS layout fix (real parser incompatibility).
//
// This file proves the NARROW, SCOPED fix to camsParser.ts recognising the
// second real-world CAMS layout Gate A's structural comparison found (see
// docs/investment-intelligence/II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md).
// The fixture (pc3-q11-alternate-cams-layout.*) was built entirely from
// that document's own already-abstracted structural facts — zero real
// values, invented names/folios/PANs/amounts throughout (see
// scripts/investment-intelligence/pc3/pc3FixturePack.ts's `buildQ11()` for
// the exact synthetic construction and its property-by-property mapping
// back to Gate A's numbered findings).
//
// This is a NEW test file, not an edit to tests/unit/iiPc3QualificationPack.test.ts
// or any Q01-Q10 test — that pack (and its own regression coverage) is
// left completely unchanged; see that same file's own re-run in this task's
// regression pass.

const PACK_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/pc3-cams');
const FIXTURE_ID = 'pc3-q11-alternate-cams-layout';

function loadPdfBytes(): Buffer {
  return readFileSync(join(PACK_DIR, `${FIXTURE_ID}.pdf`));
}
function loadText(): string {
  return readFileSync(join(PACK_DIR, `${FIXTURE_ID}.txt`), 'utf8');
}

describe('II-PC3 Gate A fix — alternate CAMS layout (Q11)', () => {
  it('GREEN: source is now detected as CAMS with the alternate-layout format version (was undetectable before the fix — RED confirmed separately, not committed)', () => {
    const text = loadText();
    const detection = detectSource(text);
    expect(detection.parser?.parserCode).toBe('cams_detailed_v1');
    expect(detection.detection.sourceKey).toBe('cams');
    expect(detection.detection.confidence).toBeGreaterThanOrEqual(0.5);
    expect(detection.detection.formatVersionDetected).toBe('detailed_v1_alt_layout');
  });

  it('GREEN: real PDF bytes -> real pdf-parse extraction -> detector -> parser -> zero errors', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    expect(result.detection.parser).not.toBeNull();
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.errors).toEqual([]);
  });

  it('GREEN: investor block using only Folio No:/PAN: (no Name:/Holding Mode: labels) parses as a valid account, not an error (Gate A finding #2)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const accounts = result.parsed!.accounts;
    expect(accounts.length).toBe(2);
    const a = accounts.find((x) => x.folioNumber === '9311040001101');
    const b = accounts.find((x) => x.folioNumber === '9311040001102');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a!.holderName).toBeNull();
    expect(a!.holdingModeRaw).toBeNull();
    expect(b!.holderName).toBeNull();
    expect(b!.holdingModeRaw).toBeNull();
  });

  it('GREEN: scheme name/ISIN pulled from one free-text line, no AMFI code (a distributor "Advisor" code is NOT conflated with it) (Gate A finding #5)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const txn = result.parsed!.transactions.find((t) => t.sourceReference === 'PC3Q11-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toBe('Vishaal Composite Fund - Growth (Direct Plan)');
    expect(txn!.scheme.isin).toBe('INF555K01AB1');
    expect(txn!.scheme.amfiSchemeCode).toBeNull();
    // Folio B's scheme line has a genuinely blank ISIN slot ("ISIN: (Advisor: ...)").
    const holdingB = result.parsed!.holdings.find((h) => h.folioNumber === '9311040001102');
    expect(holdingB).toBeTruthy();
    expect(holdingB!.scheme.rawSchemeName).toBe('Zenith Diversified Fund - Growth (Regular Plan)');
    expect(holdingB!.scheme.isin).toBeNull();
  });

  it('GREEN: alternate transaction-table column order (Date/Amount/Price/Units/Transaction-type, no Description column) parses all 7 rows correctly (Gate A finding #6)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const txns = result.parsed!.transactions;
    expect(txns.length).toBe(7);
    const byRef = (ref: string) => txns.find((t) => t.sourceReference === ref)!;
    const purchase = byRef('PC3Q11-001');
    expect(purchase.transactionDateIso).toBe('2025-02-01');
    expect(scaledToDecimalString(purchase.amountScaled, 2)).toBe('10000.00');
    expect(scaledToDecimalString(purchase.unitsScaled!, 3)).toBe('83.500');
    expect(scaledToDecimalString(purchase.navScaled!, 4)).toBe('119.7605'); // "Price" column captured as this layout's NAV-equivalent slot
    expect(purchase.canonicalType).toBe('purchase');
  });

  it('GREEN: the two new real cost categories (stamp duty, STT) classify as debt/transaction COSTS (fee/tax), never dropped or miscategorised as a transfer (Gate A finding #7)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const txns = result.parsed!.transactions;
    const stampDuty = txns.find((t) => t.sourceReference === 'PC3Q11-002');
    const stt = txns.find((t) => t.sourceReference === 'PC3Q11-003');
    expect(stampDuty).toBeTruthy();
    expect(stt).toBeTruthy();
    expect(stampDuty!.canonicalType).toBe('fee');
    expect(stampDuty!.classificationConfidence).toBe(1);
    expect(stt!.canonicalType).toBe('tax');
    expect(stt!.classificationConfidence).toBe(1);
    // Neither cost line moved the running unit balance (both print 0.000 units) -- confirms
    // they were captured as genuine cost rows, not silently coerced into a unit-moving type.
    expect(scaledToDecimalString(stampDuty!.unitsScaled!, 3)).toBe('0.000');
    expect(scaledToDecimalString(stt!.unitsScaled!, 3)).toBe('0.000');
    // No 'unclassified_transaction' warning was raised for either -- proves they reached a
    // real classification rule, not a fallback/default.
    expect(result.parsed!.warnings.some((w) => w.code === 'unclassified_transaction')).toBe(false);
  });

  it('GREEN: "Closing Unit Balance: X Total Cost Value: Y" (no as-on/Valuation/NAV-as-of clause) parses via the statement period end as as-of date (Gate A finding #9)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    expect(result.parsed!.holdings.length).toBe(2);
    const holdingA = result.parsed!.holdings.find((h) => h.folioNumber === '9311040001101')!;
    expect(holdingA.asOfDateIso).toBe('2025-06-30'); // == statement period end, since this grammar prints no per-line date
    expect(scaledToDecimalString(holdingA.unitsScaled, 3)).toBe('245.280');
    expect(scaledToDecimalString(holdingA.valueScaled!, 2)).toBe('30000.00');
    expect(holdingA.navScaled).toBeNull();
  });

  it('GREEN: the transaction table continues raw across the real PDF page break with ZERO header/label reprint (Gate A finding #10) -- all 7 rows present exactly once', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const refs = result.parsed!.transactions.map((t) => t.sourceReference).sort();
    expect(refs).toEqual(['PC3Q11-001', 'PC3Q11-002', 'PC3Q11-003', 'PC3Q11-004', 'PC3Q11-005', 'PC3Q11-006', 'PC3Q11-007']);
    // The page-2-only row (after the break) parsed correctly with no
    // preceding header/scheme reprint of any kind on that page.
    const lastRow = result.parsed!.transactions.find((t) => t.sourceReference === 'PC3Q11-007');
    expect(lastRow).toBeTruthy();
    expect(lastRow!.transactionDateIso).toBe('2025-06-30');
  });

  it('GREEN: a "no activity this period" placeholder folio parses as a folio with ZERO transactions, not an error -- its closing holding is still captured (Gate A finding #12)', async () => {
    const bytes = loadPdfBytes();
    const extraction = await extractPdfText(bytes);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    const result = parseExtractedDocument(extraction.text);
    const folioBTxns = result.parsed!.transactions.filter((t) => t.folioNumber === '9311040001102');
    expect(folioBTxns.length).toBe(0);
    expect(result.parsed!.errors).toEqual([]);
    const holdingB = result.parsed!.holdings.find((h) => h.folioNumber === '9311040001102');
    expect(holdingB).toBeTruthy();
    expect(scaledToDecimalString(holdingB!.unitsScaled, 3)).toBe('60.000');
  });

  it('sanity: the fixture and its two sibling files exist (pack completeness)', () => {
    // A missing file here would make every test above pass vacuously via a
    // thrown-before-assertion ENOENT rather than a real green result --
    // this guards that the suite above is exercising real bytes.
    expect(() => loadPdfBytes()).not.toThrow();
    expect(() => loadText()).not.toThrow();
  });
});
