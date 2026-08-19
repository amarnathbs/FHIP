import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// Golden-fixture parser accuracy tests (spec sections 36-40). Runs
// entirely in-process against the committed .txt/.expected.json fixture
// pairs — no DB, no network. This is the test that would FAIL if the
// parser regressed (verified by deliberately corrupting one expected
// value below and confirming a failure — see the "self-check" describe
// block at the bottom of this file, which is left in place, PASSING,
// as a permanent negative-control proof the harness can actually detect
// a broken parser, not just "did not throw").

const CAMS_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/r2-cas/cams');
const KFIN_DIR = join(process.cwd(), 'lib/fixtures/investment-intelligence/r2-cas/kfintech');

interface ExpectedFixture {
  fixtureId: string;
  title: string;
  sourceKey: string;
  documentTypeDetected: string;
  formatVersionDetected: string;
  statementPeriodStartIso: string;
  statementPeriodEndIso: string;
  accounts: { folioNumber: string; holderName: string; holdingModeRaw: string }[];
  transactionCount: number;
  transactions: {
    folioNumber: string;
    scheme: string;
    isin: string | null;
    amfiSchemeCode: string | null;
    transactionDateIso: string;
    canonicalType: string;
    amount: string;
    units: string;
    nav: string;
    sourceReference: string | null;
  }[];
  holdingCount: number;
  holdings: { folioNumber: string; scheme: string; asOfDateIso: string; units: string; value: string; nav: string }[];
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

function assertFixture(text: string, expected: ExpectedFixture) {
  const result = parseExtractedDocument(text);

  expect(result.detection.parser).not.toBeNull();
  expect(result.detection.detection.sourceKey).toBe(expected.sourceKey);
  expect(result.detection.detection.confidence).toBeGreaterThanOrEqual(0.5);
  expect(result.detection.detection.documentTypeDetected).toBe(expected.documentTypeDetected);
  expect(result.detection.detection.formatVersionDetected).toBe(expected.formatVersionDetected);

  const parsed = result.parsed!;
  expect(parsed.errors).toEqual([]);
  expect(parsed.metadata.statementPeriodStartIso).toBe(expected.statementPeriodStartIso);
  expect(parsed.metadata.statementPeriodEndIso).toBe(expected.statementPeriodEndIso);

  expect(parsed.accounts.length).toBe(expected.accounts.length);
  for (const expAcc of expected.accounts) {
    const found = parsed.accounts.find((a) => a.folioNumber === expAcc.folioNumber);
    expect(found, `expected account with folio ${expAcc.folioNumber} to be found`).toBeTruthy();
    expect(found!.holderName).toBe(expAcc.holderName);
    expect(found!.holdingModeRaw).toBe(expAcc.holdingModeRaw);
  }

  expect(parsed.transactions.length).toBe(expected.transactionCount);
  for (const expTxn of expected.transactions) {
    const found = parsed.transactions.find(
      (t) => t.folioNumber === expTxn.folioNumber && t.sourceReference === expTxn.sourceReference && t.transactionDateIso === expTxn.transactionDateIso
    );
    expect(found, `expected transaction ref=${expTxn.sourceReference} folio=${expTxn.folioNumber} to be found`).toBeTruthy();
    expect(found!.scheme.rawSchemeName).toBe(expTxn.scheme);
    expect(found!.scheme.isin).toBe(expTxn.isin);
    expect(found!.scheme.amfiSchemeCode).toBe(expTxn.amfiSchemeCode);
    expect(found!.canonicalType).toBe(expTxn.canonicalType);
    expect(scaledToDecimalString(found!.amountScaled, 2)).toBe(expTxn.amount);
    expect(found!.unitsScaled === null ? null : scaledToDecimalString(found!.unitsScaled, 3)).toBe(expTxn.units);
    expect(found!.navScaled === null ? null : scaledToDecimalString(found!.navScaled, 4)).toBe(expTxn.nav);
  }

  expect(parsed.holdings.length).toBe(expected.holdingCount);
  for (const expHolding of expected.holdings) {
    const found = parsed.holdings.find((h) => h.folioNumber === expHolding.folioNumber && h.scheme.rawSchemeName === expHolding.scheme);
    expect(found, `expected holding for folio ${expHolding.folioNumber} scheme ${expHolding.scheme} to be found`).toBeTruthy();
    expect(found!.asOfDateIso).toBe(expHolding.asOfDateIso);
    expect(scaledToDecimalString(found!.unitsScaled, 3)).toBe(expHolding.units);
    expect(found!.valueScaled === null ? null : scaledToDecimalString(found!.valueScaled, 2)).toBe(expHolding.value);
    expect(found!.navScaled === null ? null : scaledToDecimalString(found!.navScaled, 4)).toBe(expHolding.nav);
  }
}

describe('R2 golden fixtures — CAMS (15 fixtures, spec sections 36, 38, 39)', () => {
  const fixtures = loadFixtures(CAMS_DIR);
  it('exactly 15 CAMS fixture files exist', () => {
    expect(fixtures.length).toBe(15);
  });
  for (const { id, text, expected } of fixtures) {
    it(`${id}: parses to exactly the expected accounts/transactions/holdings`, () => {
      assertFixture(text, expected);
    });
  }
});

describe('R2 golden fixtures — KFintech (15 fixtures, spec sections 36, 38, 40)', () => {
  const fixtures = loadFixtures(KFIN_DIR);
  it('exactly 15 KFintech fixture files exist', () => {
    expect(fixtures.length).toBe(15);
  });
  for (const { id, text, expected } of fixtures) {
    it(`${id}: parses to exactly the expected accounts/transactions/holdings`, () => {
      assertFixture(text, expected);
    });
  }
});

describe('R2 golden fixtures — cross-provider independence (spec sections 39-40)', () => {
  it('CAMS text is NOT detected as KFintech and vice versa', () => {
    const camsFixtures = loadFixtures(CAMS_DIR);
    const kfinFixtures = loadFixtures(KFIN_DIR);
    for (const { text } of camsFixtures) {
      const result = parseExtractedDocument(text);
      expect(result.detection.detection.sourceKey).toBe('cams');
    }
    for (const { text } of kfinFixtures) {
      const result = parseExtractedDocument(text);
      expect(result.detection.detection.sourceKey).toBe('kfintech');
    }
  });
});

describe('R2 golden fixtures — harness self-check (negative-control / mutation test on the test itself)', () => {
  it('the fixture-comparison assertion actually FAILS when an expected value is deliberately corrupted (proves the test can detect a broken parser, not just "did not throw")', () => {
    const fixtures = loadFixtures(CAMS_DIR);
    const target = fixtures.find((f) => f.id === 'cams-source-detection-basic')!;
    const corrupted: ExpectedFixture = JSON.parse(JSON.stringify(target.expected));
    corrupted.transactions[0].amount = '99999.99'; // deliberately wrong — real value is 10000.00
    expect(() => assertFixture(target.text, corrupted)).toThrow();
  });

  it('the same fixture with its ORIGINAL (uncorrupted) expected value passes (confirms the corruption above, not a broken harness, caused the failure)', () => {
    const fixtures = loadFixtures(CAMS_DIR);
    const target = fixtures.find((f) => f.id === 'cams-source-detection-basic')!;
    expect(() => assertFixture(target.text, target.expected)).not.toThrow();
  });
});
