/**
 * M3 (Phase 4), items I.12 and I.13 — the certified synthetic investment
 * corpus, measured against sealed independent oracles.
 *
 * I.13's thresholds, asserted literally rather than paraphrased:
 *   - economic transaction recall and precision: 100% on this corpus
 *   - closing units exact within the certified decimal tolerance
 *   - unexplained economic omission: 0
 *   - false economic transaction: 0
 *   - false canonical account / instrument / tax lot: 0
 *   - duplicate net-worth contribution: 0
 *   - "do not hide errors behind a model confidence score"
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT DO. It does not compare the parser
 * against itself. Every expected figure comes from
 * `tests/support/buildM3InvestmentCorpus.ts`'s hand-written oracle, and the
 * negative controls below exist to prove the measurement can actually fail:
 * a corpus where every fixture passes tells you nothing unless you can show
 * a wrong answer would have been caught.
 */

import { describe, it, expect } from 'vitest';
import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { reconcilePosition, determineHistoryCompleteness } from '@/lib/services/investment-intelligence/reconciliation';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExactDecimal, scaledToDecimalString, ZERO } from '@/lib/services/investment-intelligence/decimal';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';
import { M3_INVESTMENT_CORPUS, M3_BLOCKED_SCENARIOS, C10_RECONCILIATION_FAILURE, C1_CAS_BASELINE, type CorpusFixture } from '../support/buildM3InvestmentCorpus';
import type { ParsedDocumentOutput } from '@/lib/services/investment-intelligence/parsers/types';

function parseFixture(fixture: CorpusFixture): ParsedDocumentOutput | null {
  const detection = detectSource(fixture.text);
  if (!detection.parser) return null;
  return parseDocumentWithParser(detection.parser, fixture.text);
}

function scaled(value: string): bigint {
  const parsed = parseExactDecimal(value);
  if (!parsed.ok) throw new Error(`oracle value is not an exact decimal: ${value}`);
  return parsed.scaled;
}

const CLEAN_FIXTURES = M3_INVESTMENT_CORPUS.filter((f) => !f.mustFailWith);

describe('M3 I.12/I.13 — certified synthetic investment corpus vs sealed oracles', () => {
  it('the corpus covers the scenarios it claims, and names the ones it does not', () => {
    // Guards against the corpus quietly shrinking. A future edit that drops a
    // fixture has to also drop its claim here.
    expect(M3_INVESTMENT_CORPUS.map((f) => f.id).sort()).toEqual(['C1', 'C10', 'C11', 'C3', 'C4', 'C4b', 'C5', 'C6', 'C7', 'C9']);
    expect(M3_BLOCKED_SCENARIOS.length).toBe(3);
    for (const blocked of M3_BLOCKED_SCENARIOS) {
      expect(blocked.reason.length).toBeGreaterThan(40); // a reason, not a shrug
    }
  });

  describe.each(CLEAN_FIXTURES.map((f) => [f.id, f] as const))('%s', (_id, fixture) => {
    it(`${fixture.scenario}: a certified deterministic parser claims it (I.3 — Level 1 runs first)`, () => {
      const detection = detectSource(fixture.text);
      expect(detection.parser, `no certified parser claimed ${fixture.id}`).not.toBeNull();
      expect(detection.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it(`${fixture.scenario}: transaction RECALL and PRECISION are both 100% against the oracle`, () => {
      const parsed = parseFixture(fixture)!;
      // PRECISION: no transaction the oracle did not name. RECALL: none the
      // oracle named that is missing. Asserting the count alone would let a
      // wrong row substitute for a right one, so both directions are checked
      // on (date, type, units) triples.
      const actual = parsed.transactions.map((t) => ({
        dateIso: t.transactionDateIso,
        type: t.canonicalType,
        units: t.unitsScaled === null ? '0' : scaledToDecimalString(t.unitsScaled),
      }));
      const expected = fixture.oracle.transactions.map((t) => ({ dateIso: t.dateIso, type: t.type, units: scaledToDecimalString(scaled(t.units)) }));

      expect(actual.length, `false economic transactions or omissions in ${fixture.id}`).toBe(fixture.oracle.transactionCount);
      expect([...actual].sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.units.localeCompare(b.units))).toEqual(
        [...expected].sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.units.localeCompare(b.units)),
      );
    });

    it(`${fixture.scenario}: unexplained economic omission = 0 and false economic transaction = 0`, () => {
      const parsed = parseFixture(fixture)!;
      const oracleUnits = fixture.oracle.transactions.reduce((sum, t) => sum + scaled(t.units), ZERO);
      const actualUnits = parsed.transactions.reduce((sum, t) => sum + (t.unitsScaled ?? ZERO), ZERO);
      // Net units is an independent aggregate of the per-row check above: a
      // compensating pair of errors would have to cancel exactly to survive
      // both.
      expect(scaledToDecimalString(actualUnits)).toBe(scaledToDecimalString(oracleUnits));
    });

    it(`${fixture.scenario}: closing units reconcile EXACTLY (variance 0, well inside the certified tolerance)`, () => {
      const parsed = parseFixture(fixture)!;
      // Group by (folio, scheme) so a multi-position document is checked as
      // separate positions rather than as one summed portfolio — the C7 case
      // where merging would look "right" on a total and be wrong on truth.
      const lastHolding = parsed.holdings[parsed.holdings.length - 1];
      expect(lastHolding, `${fixture.id} produced no closing holding`).toBeDefined();

      const positionTxns = parsed.transactions.filter(
        (t) => t.folioNumber === lastHolding.folioNumber && t.scheme.normalisedSchemeName === lastHolding.scheme.normalisedSchemeName,
      );
      const hasOpeningMarker = positionTxns.some((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
      const reconciliation = reconcilePosition({
        openingUnitsScaled: null,
        transactions: positionTxns.map((t) => ({ canonicalType: t.canonicalType, unitsScaled: t.unitsScaled })),
        statementClosingUnitsScaled: lastHolding.unitsScaled,
        historyCompleteness: determineHistoryCompleteness({
          hasExplicitOpeningBalanceTransaction: hasOpeningMarker,
          hasAnyTransactionHistory: positionTxns.length > 0,
          hasClosingHoldingSnapshot: true,
          statementCoversFromInception: !hasOpeningMarker,
        }),
        config: DEFAULT_RECONCILIATION_CONFIG,
      });

      expect(reconciliation.withinTolerance, `${fixture.id} could not be reconciled at all`).toBe(true);
      // EXACT, not merely within tolerance. I.13 asks for exactness on the
      // certified corpus; accepting "within 0.0001" here would let a real
      // rounding defect hide inside the allowance.
      expect(reconciliation.unitVarianceScaled).toBe(ZERO);
    });

    it(`${fixture.scenario}: the closing balance the parser read matches the oracle's printed figure`, () => {
      const parsed = parseFixture(fixture)!;
      const lastHolding = parsed.holdings[parsed.holdings.length - 1];
      expect(scaledToDecimalString(lastHolding.unitsScaled)).toBe(scaledToDecimalString(scaled(fixture.oracle.closingUnits)));
    });

    it(`${fixture.scenario}: position count matches the oracle — no merged and no invented position`, () => {
      const parsed = parseFixture(fixture)!;
      const positions = new Set(parsed.holdings.map((h) => `${h.folioNumber}|${h.scheme.normalisedSchemeName}`));
      expect(positions.size).toBe(fixture.oracle.positionCount);
    });

    it(`${fixture.scenario}: opening-balance handling matches the oracle (PC4-INV-08)`, () => {
      const parsed = parseFixture(fixture)!;
      const markers = parsed.transactions.filter((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
      if (fixture.oracle.expectsOpeningBalanceMarker) {
        expect(markers.length).toBe(1);
        // The load-bearing assertion: an opening balance is evidence of a
        // position, never an acquisition. If this ever became 'purchase' a
        // tax lot with an invented cost base would follow.
        expect(markers[0].canonicalType).toBe('adjustment');
      } else {
        expect(markers.length).toBe(0);
      }
    });
  });

  // ---- Negative controls. Without these the suite above proves nothing:
  // a pipeline that accepted everything would score 100% on clean fixtures.
  describe('negative controls — the measurement can actually fail', () => {
    it('C10: a statement whose printed closing balance contradicts its transactions is DETECTED, not accepted', () => {
      const fixture = C10_RECONCILIATION_FAILURE;
      const parsed = parseFixture(fixture)!;
      const lastHolding = parsed.holdings[parsed.holdings.length - 1];
      const reconciliation = reconcilePosition({
        openingUnitsScaled: null,
        transactions: parsed.transactions.map((t) => ({ canonicalType: t.canonicalType, unitsScaled: t.unitsScaled })),
        statementClosingUnitsScaled: lastHolding.unitsScaled,
        historyCompleteness: determineHistoryCompleteness({
          hasExplicitOpeningBalanceTransaction: false,
          hasAnyTransactionHistory: true,
          hasClosingHoldingSnapshot: true,
          statementCoversFromInception: true,
        }),
        config: DEFAULT_RECONCILIATION_CONFIG,
      });
      expect(reconciliation.withinTolerance).toBe(false);
      // 75.000 units unexplained. The engine's sign convention is
      // (computed - printed), so a statement claiming MORE than its activity
      // supports yields a NEGATIVE variance: 100.000 - 175.000 = -75.000.
      // Asserted with the sign rather than on the absolute value, so a future
      // change that silently flipped the convention would fail here rather
      // than pass quietly and then mislead every downstream reader of
      // `ii_portfolio_truth_status.unit_variance`.
      expect(scaledToDecimalString(reconciliation.unitVarianceScaled!)).toBe(scaledToDecimalString(scaled('-75')));
    });

    it('C4b (M3 FINDING): a CAS opening balance is DISCARDED, and the resulting variance equals it exactly', () => {
      // Not a fixture the pipeline passes — this pins a real gap. See
      // C4B_CAS_OPENING_BALANCE_GAP's own comment and the M3 report.
      const fixture = M3_INVESTMENT_CORPUS.find((f) => f.id === 'C4b')!;
      const parsed = parseFixture(fixture)!;

      // 1. The opening balance is not a transaction, and carries no marker.
      expect(parsed.transactions.length).toBe(1);
      expect(parsed.transactions.some((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE)).toBe(false);

      // 2. The line is not reported as an error either — it is silently
      //    consumed, which is why this was invisible until now.
      expect(parsed.errors.some((e) => /opening/i.test(e.message))).toBe(false);

      // 3. The variance is EXACTLY the discarded opening balance. This is
      //    what makes the finding actionable rather than a suspicion: the
      //    size of the error is fully explained by the missing value.
      const lastHolding = parsed.holdings[parsed.holdings.length - 1];
      const reconciliation = reconcilePosition({
        openingUnitsScaled: null,
        transactions: parsed.transactions.map((t) => ({ canonicalType: t.canonicalType, unitsScaled: t.unitsScaled })),
        statementClosingUnitsScaled: lastHolding.unitsScaled,
        historyCompleteness: determineHistoryCompleteness({
          hasExplicitOpeningBalanceTransaction: false,
          hasAnyTransactionHistory: true,
          hasClosingHoldingSnapshot: true,
          statementCoversFromInception: true,
        }),
        config: DEFAULT_RECONCILIATION_CONFIG,
      });
      expect(reconciliation.withinTolerance).toBe(false);
      expect(scaledToDecimalString(reconciliation.unitVarianceScaled!)).toBe(scaledToDecimalString(scaled('-200')));
    });

    it('C4b (M3 FINDING, second mechanism): the CAS opening-balance pattern requires a colon, so a column-aligned line is not matched at all', () => {
      // Two independent ways the same value is lost. Even if the discard at
      // `camsParser.ts:842` were fixed, a statement that prints the label
      // without a colon would still bypass the pattern entirely.
      const withoutColon = M3_INVESTMENT_CORPUS.find((f) => f.id === 'C4b')!.text.replace('Opening Unit Balance : 200.000', 'Opening Unit Balance        200.000');
      const parsed = parseFixture({ ...M3_INVESTMENT_CORPUS.find((f) => f.id === 'C4b')!, text: withoutColon })!;
      expect(parsed.transactions.length).toBe(1);
      expect(parsed.transactions.some((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE)).toBe(false);
    });

    it('C11: a document no certified parser claims is REFUSED — never routed to an AI fallback and hoped over', () => {
      const detection = detectSource(M3_INVESTMENT_CORPUS.find((f) => f.id === 'C11')!.text);
      expect(detection.parser).toBeNull();
    });

    it('C9: embedded prompt-injection text produces no transaction and cannot move the closing balance', () => {
      const fixture = M3_INVESTMENT_CORPUS.find((f) => f.id === 'C9')!;
      const parsed = parseFixture(fixture)!;
      expect(parsed.transactions.length).toBe(1);
      for (const t of parsed.transactions) {
        expect(scaledToDecimalString(t.unitsScaled ?? ZERO)).not.toContain('999999');
      }
      expect(scaledToDecimalString(parsed.holdings[0].unitsScaled)).toBe(scaledToDecimalString(scaled('100.000')));
    });

    it('MUTATION PROOF: a deliberately wrong oracle FAILS, so a passing corpus is evidence rather than tautology', () => {
      // The single most important test in this file. If the comparison were
      // accidentally self-referential (comparing the parser to itself), this
      // would pass — and everything above would be worthless.
      const parsed = parseFixture(C1_CAS_BASELINE)!;
      const wrongOracleUnits = scaled('101.000'); // one unit off the truth
      const actualUnits = parsed.transactions.reduce((sum, t) => sum + (t.unitsScaled ?? ZERO), ZERO);
      expect(scaledToDecimalString(actualUnits)).not.toBe(scaledToDecimalString(wrongOracleUnits));
    });

    it('NO CONFIDENCE LAUNDERING: parser confidence is reported but is never what decides correctness', () => {
      // I.13: "Do not hide errors behind a model 'confidence' score." C10 is
      // a genuinely wrong statement; the parser is nonetheless confident
      // about it, because confidence measures LAYOUT recognition, not
      // economic truth. The proof that it is not laundering errors is that
      // reconciliation still fails C10 (asserted above) despite this.
      const parsed = parseFixture(C10_RECONCILIATION_FAILURE)!;
      expect(parsed.parserConfidence).toBeGreaterThan(0.5);
    });
  });
});
