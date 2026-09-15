/**
 * PC5 (M4) — K.19's foundation: reconstructing a parsed Investment
 * Intelligence document from the field candidates AIE already persisted,
 * so a re-reconciliation never has to re-read the original PDF.
 *
 * The round trip is asserted against REAL parser output — `detectSource` +
 * `parseDocumentWithParser` on a fixture the certified CAMS parser actually
 * claims — not against a hand-built candidate array. A hand-built fixture
 * would test the inverse of what I believed `toAieCandidates` writes, which
 * is exactly the assumption worth checking.
 */
import { describe, it, expect } from 'vitest';
import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { toAieCandidates } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { rehydrateParsedDocument } from '@/lib/aie/adapters/investment-intelligence/rehydrate';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';
import type { ParsedDocumentOutput } from '@/lib/services/investment-intelligence/parsers/types';

function parseFixture(text: string): ParsedDocumentOutput {
  const detection = detectSource(text);
  expect(detection.parser, 'the CAMS fixture must be claimed by a certified parser').not.toBeNull();
  return parseDocumentWithParser(detection.parser!, text);
}

describe('PC5 K.19 — rehydrateParsedDocument round-trips real parser output', () => {
  const text = buildAieIiCasFixtureText({ holderName: 'Anil Sharma', holdingMode: 'SI' });
  const original = parseFixture(text);
  const candidates = toAieCandidates(original);
  const result = rehydrateParsedDocument(candidates);

  it('succeeds on a genuine candidate set', () => {
    expect(result.ok).toBe(true);
  });

  it('restores the metadata the reconciliation context consumes', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.metadata.sourceKey).toBe(original.metadata.sourceKey);
    expect(result.parsed.metadata.statementPeriodStartIso).toBe(original.metadata.statementPeriodStartIso);
    expect(result.parsed.metadata.statementPeriodEndIso).toBe(original.metadata.statementPeriodEndIso);
    expect(result.parsed.metadata.statementAsOfDateIso).toBe(original.metadata.statementAsOfDateIso);
    expect(result.parsed.metadata.documentTypeDetected).toBe(original.metadata.documentTypeDetected);
  });

  it('restores every account, INCLUDING the owner evidence PC5 needs for K.4', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.accounts).toHaveLength(original.accounts.length);
    expect(result.parsed.accounts[0].folioNumber).toBe(original.accounts[0].folioNumber);
    // The whole reason PC5 can re-check an owner match without the PDF.
    expect(result.parsed.accounts[0].holderName).toBe('Anil Sharma');
    expect(result.parsed.accounts[0].holdingModeRaw).toBe('SI');
    expect(result.parsed.accounts[0].panMasked).toBe(original.accounts[0].panMasked);
  });

  it('restores transactions with EXACT bigint amounts — no float ever appears in the round trip', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.transactions).toHaveLength(original.transactions.length);
    for (let i = 0; i < original.transactions.length; i += 1) {
      const a = original.transactions[i];
      const b = result.parsed.transactions[i];
      expect(b.amountScaled).toBe(a.amountScaled);
      expect(b.unitsScaled).toBe(a.unitsScaled);
      expect(b.navScaled).toBe(a.navScaled);
      expect(b.balanceUnitsAfterScaled).toBe(a.balanceUnitsAfterScaled);
      expect(b.canonicalType).toBe(a.canonicalType);
      expect(b.transactionDateIso).toBe(a.transactionDateIso);
      expect(b.folioNumber).toBe(a.folioNumber);
      expect(b.sourceReference).toBe(a.sourceReference);
      // The scheme identity the fingerprint and instrument matching both
      // depend on.
      expect(b.scheme.normalisedSchemeName).toBe(a.scheme.normalisedSchemeName);
      expect(b.scheme.isin).toBe(a.scheme.isin);
      expect(b.scheme.planType).toBe(a.scheme.planType);
      expect(b.scheme.optionType).toBe(a.scheme.optionType);
    }
  });

  it('restores holdings with exact units and values', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.holdings).toHaveLength(original.holdings.length);
    for (let i = 0; i < original.holdings.length; i += 1) {
      expect(result.parsed.holdings[i].unitsScaled).toBe(original.holdings[i].unitsScaled);
      expect(result.parsed.holdings[i].valueScaled).toBe(original.holdings[i].valueScaled);
      expect(result.parsed.holdings[i].navScaled).toBe(original.holdings[i].navScaled);
      expect(result.parsed.holdings[i].asOfDateIso).toBe(original.holdings[i].asOfDateIso);
    }
  });

  it('DISCLOSED: warnings, errors and confidence do NOT round-trip, and report honestly rather than plausibly', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.warnings).toEqual([]);
    expect(result.parsed.errors).toEqual([]);
    // Zero rather than a flattering 1: if a future consumer reads it, a
    // zero is a visible wrong answer and a 1 is an invisible one.
    expect(result.parsed.parserConfidence).toBe(0);
    expect(result.parsed.parserVersion).toBe('rehydrated');
  });
});

describe('PC5 K.19 — rehydrateParsedDocument FAILS rather than fabricating an empty document', () => {
  it('refuses a candidate set with no metadata block', () => {
    const text = buildAieIiCasFixtureText();
    const candidates = toAieCandidates(parseFixture(text)).filter(
      (c) => (c.sourceReference as { recordType?: string } | undefined)?.recordType !== 'metadata',
    );
    expect(rehydrateParsedDocument(candidates)).toEqual({ ok: false, reason: 'no_metadata_candidate' });
  });

  it('refuses a candidate set with metadata but no records — a vacuously clean reconciliation is the worst outcome', () => {
    const text = buildAieIiCasFixtureText();
    const candidates = toAieCandidates(parseFixture(text)).filter(
      (c) => (c.sourceReference as { recordType?: string } | undefined)?.recordType === 'metadata',
    );
    expect(rehydrateParsedDocument(candidates)).toEqual({ ok: false, reason: 'no_records' });
  });

  it('refuses an empty candidate set', () => {
    expect(rehydrateParsedDocument([])).toEqual({ ok: false, reason: 'no_metadata_candidate' });
  });
});

describe('PC5 K.19 — rehydration is stable across repeated round trips', () => {
  it('rehydrating a rehydrated document produces the same records (idempotent under re-serialisation)', () => {
    const text = buildAieIiCasFixtureText({ holderName: 'Priya Sharma', holdingMode: 'JO' });
    const first = rehydrateParsedDocument(toAieCandidates(parseFixture(text)));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = rehydrateParsedDocument(toAieCandidates(first.parsed));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.parsed.accounts).toEqual(first.parsed.accounts);
    expect(second.parsed.transactions).toEqual(first.parsed.transactions);
    expect(second.parsed.holdings).toEqual(first.parsed.holdings);
  });
});
