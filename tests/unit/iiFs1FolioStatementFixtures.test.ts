import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';

// II-FS1 — CAMS Individual Folio Statement golden-fixture tests
// (dispatch sections 46-52, automated test matrix FS1-T01/T04-T13/T25).
//
// Same methodology as tests/unit/iiR2ParserFixtures.test.ts (PC3's own
// pattern): entirely in-process against committed .txt/.expected.json
// fixture pairs, no DB, no network. Each oracle in this directory was
// authored independently from the fixture's own construction (dispatch
// section 50), not derived by running the parser and copying its output.

const FS1_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/r2-cas/cams-individual-folio');
const CAMS_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/r2-cas/cams');
const KFIN_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/r2-cas/kfintech');

interface ExpectedFixture {
  fixtureId: string;
  title: string;
  sourceKey: string;
  documentTypeDetected: string;
  formatVersionDetected: string;
  /** FS-Q12 only: this fixture's parse is expected to end with a fatal
   * (error-severity) warning and must NOT be asserted against a strict
   * transaction/holding shape — a malformed real-world row must surface as
   * a structured error, never a silently-wrong or silently-partial parse. */
  expectFatalParseError?: boolean;
  statementPeriodStartIso?: string;
  statementPeriodEndIso?: string;
  accounts?: { folioNumber: string; holderName: string; holdingModeRaw: string | null }[];
  transactionCount: number;
  transactions?: {
    folioNumber: string;
    scheme: string;
    isin: string | null;
    amfiSchemeCode: string | null;
    transactionDateIso: string;
    canonicalType: string;
    amount: string;
    units: string | null;
    nav: string | null;
    sourceReference: string | null;
  }[];
  holdingCount?: number;
  holdings?: { folioNumber: string; scheme: string; asOfDateIso: string; units: string; value: string | null; nav: string | null }[];
}

function loadFixtures(dir: string): { id: string; text: string; expected: ExpectedFixture }[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  return files.map((f) => {
    const id = f.replace(/\.txt$/, '');
    const text = readFileSync(join(dir, f), 'utf8');
    const expected = JSON.parse(readFileSync(join(dir, `${id}.expected.json`), 'utf8')) as ExpectedFixture;
    return { id, text, expected };
  });
}

function assertFolioFixture(text: string, expected: ExpectedFixture) {
  const result = parseExtractedDocument(text);

  expect(result.detection.parser).not.toBeNull();
  expect(result.detection.detection.sourceKey).toBe(expected.sourceKey);
  expect(result.detection.detection.confidence).toBeGreaterThanOrEqual(0.5);
  expect(result.detection.detection.documentTypeDetected).toBe(expected.documentTypeDetected);
  expect(result.detection.detection.formatVersionDetected).toBe(expected.formatVersionDetected);

  const parsed = result.parsed!;
  expect(parsed).not.toBeNull();

  if (expected.expectFatalParseError) {
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.transactions.length).toBe(expected.transactionCount);
    return; // FS-Q12: no further shape assertions — a malformed fixture is proven by the error, not by a partial success shape
  }

  expect(parsed.errors).toEqual([]);
  expect(parsed.metadata.statementPeriodStartIso).toBe(expected.statementPeriodStartIso);
  expect(parsed.metadata.statementPeriodEndIso).toBe(expected.statementPeriodEndIso);

  expect(parsed.accounts.length).toBe(expected.accounts!.length);
  for (const expAcc of expected.accounts!) {
    const found = parsed.accounts.find((a) => a.folioNumber === expAcc.folioNumber);
    expect(found, `expected account with folio ${expAcc.folioNumber} to be found`).toBeTruthy();
    expect(found!.holderName).toBe(expAcc.holderName);
    expect(found!.holdingModeRaw).toBe(expAcc.holdingModeRaw);
  }

  expect(parsed.transactions.length).toBe(expected.transactionCount);
  for (const expTxn of expected.transactions ?? []) {
    const found = parsed.transactions.find(
      (t) => t.folioNumber === expTxn.folioNumber && t.sourceReference === expTxn.sourceReference && t.transactionDateIso === expTxn.transactionDateIso
    );
    expect(found, `expected transaction ref=${expTxn.sourceReference} date=${expTxn.transactionDateIso} to be found`).toBeTruthy();
    expect(found!.scheme.rawSchemeName).toBe(expTxn.scheme);
    expect(found!.scheme.isin).toBe(expTxn.isin);
    expect(found!.scheme.amfiSchemeCode).toBe(expTxn.amfiSchemeCode);
    expect(found!.canonicalType).toBe(expTxn.canonicalType);
    expect(scaledToDecimalString(found!.amountScaled, 2)).toBe(expTxn.amount);
    expect(found!.unitsScaled === null ? null : scaledToDecimalString(found!.unitsScaled, 3)).toBe(expTxn.units);
    expect(found!.navScaled === null ? null : scaledToDecimalString(found!.navScaled, 4)).toBe(expTxn.nav);
  }

  expect(parsed.holdings.length).toBe(expected.holdingCount ?? 0);
  for (const expHolding of expected.holdings ?? []) {
    const found = parsed.holdings.find((h) => h.folioNumber === expHolding.folioNumber && h.scheme.rawSchemeName === expHolding.scheme);
    expect(found, `expected holding for folio ${expHolding.folioNumber} scheme ${expHolding.scheme} to be found`).toBeTruthy();
    expect(found!.asOfDateIso).toBe(expHolding.asOfDateIso);
    expect(scaledToDecimalString(found!.unitsScaled, 3)).toBe(expHolding.units);
    expect(found!.valueScaled === null ? null : scaledToDecimalString(found!.valueScaled, 2)).toBe(expHolding.value);
    expect(found!.navScaled === null ? null : scaledToDecimalString(found!.navScaled, 4)).toBe(expHolding.nav);
  }
}

describe('FS1 golden fixtures — CAMS individual folio statement (dispatch sections 46-52)', () => {
  const fixtures = loadFixtures(FS1_DIR);
  it('at least 8 dedicated FS1 fixture files exist (FS-Q01/03/04/08/09/10/11/12)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
  });
  for (const { id, text, expected } of fixtures) {
    it(`${id}: parses to exactly the expected accounts/transactions/holdings`, () => {
      assertFolioFixture(text, expected);
    });
  }

  it('FS-Q04: the Opening Balance row is NEVER classified as a purchase/acquisition canonical type (dispatch section 17, FS1-T07)', () => {
    const { text } = fixtures.find((f) => f.id === 'fs1-q04-opening-balance-plus-sip')!;
    const { parsed } = parseExtractedDocument(text);
    const openingTxn = parsed!.transactions.find((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
    expect(openingTxn, 'expected an Opening Balance marker transaction').toBeTruthy();
    expect(openingTxn!.canonicalType).not.toBe('purchase');
    expect(openingTxn!.canonicalType).not.toBe('sip');
    expect(openingTxn!.canonicalType).toBe('adjustment');
    // Acquisition-event mapping lives in taxRepository.ts's ACQUISITION_TYPE_MAP,
    // which this test asserts by name rather than importing (that module is
    // server/DB-oriented) — the map is {purchase, sip, switch_in,
    // reinvestment, bonus, split}. 'adjustment' is not a member, so this
    // Opening Balance row can never become an R6 acquisition/tax lot.
    const acquisitionTypes = ['purchase', 'sip', 'switch_in', 'reinvestment', 'bonus', 'split'];
    expect(acquisitionTypes).not.toContain(openingTxn!.canonicalType);
  });

  it('FS-Q03: a SIP REGISTRATION mandate table (dates spanning 2020-2030) never generates a synthetic transaction (dispatch section 25)', () => {
    const { text } = fixtures.find((f) => f.id === 'fs1-q03-sip-registration-mandate-immunity')!;
    const { parsed } = parseExtractedDocument(text);
    // Exactly the ONE real Financial Transactions row — none of the SIP
    // REGISTRATION mandate table's own dates (01-Jan-2025, 01-Jan-2030,
    // 01-Jul-2020, 01-Jul-2025) or amounts (1000.00, 500.00) ever become a
    // second canonical transaction, even though the mandate table sits
    // structurally between SUMMARY OF HOLDINGS and FINANCIAL TRANSACTIONS
    // and shares the same numeric/date vocabulary.
    expect(parsed!.transactions).toHaveLength(1);
    expect(parsed!.transactions[0].sourceReference).toBe('FS1Q03SIP001');
    const mandateOnlyDates = ['2025-01-01', '2030-01-01', '2020-07-01', '2025-07-01'];
    for (const d of mandateOnlyDates) {
      expect(parsed!.transactions.some((t) => t.transactionDateIso === d)).toBe(false);
    }
    // The SIP mandate is registration/intent, not a holding either — exactly
    // one holding (the real Summary of Holdings row), not two.
    expect(parsed!.holdings).toHaveLength(1);
  });
});

describe('FS1 source detection — precedence and fail-closed negatives (dispatch sections 9-10, FS1-T01-T04)', () => {
  it('FS1-T01: a genuine folio-statement fixture is detected as cams_folio_details, not cas_statement', () => {
    const { text } = loadFixtures(FS1_DIR).find((f) => f.id === 'fs1-q01-baseline-multi-scheme')!;
    const result = parseExtractedDocument(text);
    expect(result.detection.parser?.parserCode).toBe('cams_folio_details_v1');
    expect(result.detection.detection.documentTypeDetected).toBe('cams_folio_details');
  });

  it('FS1-T02: every existing certified CAS fixture is still detected as CAS (cas_statement), never as cams_folio_details', () => {
    const camsFixtures = loadFixtures(CAMS_DIR);
    expect(camsFixtures.length).toBeGreaterThan(0);
    for (const { id, text } of camsFixtures) {
      const result = parseExtractedDocument(text);
      expect(result.detection.parser?.parserCode, `${id} should still resolve to the CAS parser`).toBe('cams_detailed_v1');
      expect(result.detection.detection.documentTypeDetected).toBe('cas_statement');
    }
  });

  it(
    'FS1-T03: every existing certified KFintech fixture is still detected as KFintech, never as cams_folio_details',
    () => {
      const kfinFixtures = loadFixtures(KFIN_DIR);
      expect(kfinFixtures.length).toBeGreaterThan(0);
      for (const { id, text } of kfinFixtures) {
        const result = parseExtractedDocument(text);
        expect(result.detection.parser?.parserCode, `${id} should still resolve to the KFintech parser`).toBe('kfintech_detailed_v1');
        expect(result.detection.detection.sourceKey).toBe('kfintech');
      }
    },
    20_000 // 15 fixtures' worth of full parses in one test — default 5s timeout is a test-infra limit, not a functional issue (mirrors FS1-T02's CAMS loop, which happened to finish under 5s)
  );

  it('FS1-T04a: a generic PDF that merely contains the casual word "folio" is NOT detected as a folio statement', () => {
    const genericText = [
      'ABC Wealth Advisors Pvt Ltd',
      'Annual Client Newsletter',
      '',
      'Dear Investor,',
      'Please find enclosed your folio update and market commentary for the quarter.',
      'Your relationship manager will contact you regarding your investment folio soon.',
      '',
      'Regards,',
      'ABC Wealth Advisors',
    ].join('\n');
    const result = parseExtractedDocument(genericText);
    expect(result.detection.detection.documentTypeDetected).not.toBe('cams_folio_details');
    expect(result.parsed).toBeNull();
  });

  it('FS1-T04b: an unrelated AMC PDF (fact sheet, no folio-statement structural sections) is NOT detected as a folio statement', () => {
    const factSheetText = [
      'Synthetic Asset Management Company',
      'Scheme Fact Sheet — September 2025',
      '',
      'Fund Manager: Jane Synthetic',
      'Benchmark: NIFTY 500 TRI',
      'Expense Ratio: 1.25%',
      'FOLIO NUMBER : is sometimes printed on client-specific pages, not this one',
      'AUM: Rs. 12,345 Crores',
    ].join('\n');
    const result = parseExtractedDocument(factSheetText);
    expect(result.detection.detection.documentTypeDetected).not.toBe('cams_folio_details');
    expect(result.parsed).toBeNull();
  });

  it('FS1-T10 (parser-level proof): a folio statement whose ONLY content after one real transaction is a Financial Transaction Form produces zero form-derived transactions', () => {
    const { text, expected } = loadFixtures(FS1_DIR).find((f) => f.id === 'fs1-q11-form-terms-contamination')!;
    const { parsed } = parseExtractedDocument(text);
    expect(parsed!.transactions.length).toBe(expected.transactionCount); // exactly the ONE real transaction, never more from the form
  });

  it('FS1-T11 (parser-level proof): Terms and Conditions prose containing dates/percentages/transaction words produces zero transactions', () => {
    const { text } = loadFixtures(FS1_DIR).find((f) => f.id === 'fs1-q11-form-terms-contamination')!;
    const { parsed } = parseExtractedDocument(text);
    // The Terms section alone contains 5+ dates and 2 percentages that must
    // never become canonical transaction rows (see the fixture's own Terms
    // text) — already covered by the exact transactionCount===1 assertion
    // above; this test asserts it from the opposite direction for clarity.
    const suspiciousDates = ['2026-01-01', '2026-01-15', '2020-07-01', '2020-01-01', '2019-01-01'];
    for (const d of suspiciousDates) {
      expect(parsed!.transactions.some((t) => t.transactionDateIso === d)).toBe(false);
    }
  });
});
