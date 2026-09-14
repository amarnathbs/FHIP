/**
 * M3 (Phase 4), item I.7 — deterministic-vs-AI disagreement resolution.
 *
 * The property under test is the one the dispatch states and that a naive
 * implementation would get wrong: NEITHER SOURCE WINS BY DEFAULT. The
 * obvious implementation is a precedence table ("deterministic beats AI"),
 * which is explicitly forbidden — and rightly, because the deterministic
 * parser's real failure mode is a confident wrong number from a glued or
 * wrapped row (PC4 defects #2 and #7b), which a precedence table would hide.
 */

import { describe, it, expect } from 'vitest';
import {
  compareFieldEvidence,
  unresolvedItemsForDisagreements,
  objectiveResolutionsForAudit,
  isMaterialFinancialField,
  type CandidateEvidence,
  type FieldComparison,
} from '@/lib/aie/adapters/investment-intelligence/disagreement';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';

const CONFIG = DEFAULT_RECONCILIATION_CONFIG;

function det(value: string | null): CandidateEvidence {
  return { value, producedBy: 'cams_detailed_v1@1.0.0', provenance: { line: 9, sourceReference: 'REF-001' } };
}
function ai(value: string | null): CandidateEvidence {
  return { value, producedBy: 'aie_ii_document_facts@1', provenance: { page: 1, line: 9 } };
}
function scaled(v: string): bigint {
  const p = parseExactDecimal(v);
  if (!p.ok) throw new Error(`bad test value ${v}`);
  return p.scaled;
}

describe('M3 I.7 — deterministic vs AI disagreement', () => {
  describe('agreement and one-sidedness are not disagreements', () => {
    it('identical values AGREE', () => {
      const result = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('100.000') }, CONFIG);
      expect(result.kind).toBe('agree');
    });

    it('numerically equal but differently formatted values AGREE — "100.000" and "100.0" are the same units', () => {
      // Failing a document over a formatting difference would be a defect,
      // not a safety property.
      const result = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('100.0') }, CONFIG);
      expect(result.kind).toBe('agree');
    });

    it('one side silent is ONE-SIDED, not a conflict — D.5 already covers "null plus a reason"', () => {
      const detOnly = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai(null) }, CONFIG);
      expect(detOnly).toMatchObject({ kind: 'one_sided', presentSide: 'deterministic', value: '100.000' });

      const aiOnly = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'narrative', deterministic: det(null), ai: ai('Purchase') }, CONFIG);
      expect(aiOnly).toMatchObject({ kind: 'one_sided', presentSide: 'ai', value: 'Purchase' });
    });

    it('both silent AGREE on null', () => {
      expect(compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'navOrPrice', deterministic: det(null), ai: ai(null) }, CONFIG).kind).toBe('agree');
    });
  });

  describe('NEITHER SIDE WINS BY DEFAULT', () => {
    it('a material disagreement with no objective tie-breaker is UNRESOLVED — the deterministic value is NOT auto-selected', () => {
      const result = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') }, CONFIG);
      expect(result.kind).toBe('disagree_material');
      // The specific thing a precedence table would have done, asserted as
      // NOT happening.
      expect(result).not.toHaveProperty('winner');
      expect(result).not.toHaveProperty('value');
    });

    it('the AI value is not auto-selected either, in the symmetric case', () => {
      const result = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'amount', deterministic: det('5000.00'), ai: ai('5500.00') }, CONFIG);
      expect(result.kind).toBe('disagree_material');
      expect(result).not.toHaveProperty('winner');
    });

    it('a disagreement on a NON-material field does not block — two spellings of a narrative are not an economic conflict', () => {
      const result = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'narrative', deterministic: det('Purchase'), ai: ai('Purchase - Systematic') }, CONFIG);
      expect(result.kind).toBe('disagree_immaterial');
    });

    it('materiality is a closed property of the FIELD, never of the size of the gap', () => {
      for (const material of ['units', 'amount', 'navOrPrice', 'transactionDateIso', 'transactionTypeCandidate', 'closingUnits']) {
        expect(isMaterialFinancialField(material)).toBe(true);
      }
      for (const immaterial of ['narrative', 'schemeText', 'amcOrInstitutionText']) {
        expect(isMaterialFinancialField(immaterial)).toBe(false);
      }
      // A tiny disagreement on a material field is STILL material — a 0.001
      // unit error is small but it is still wrong about someone's money.
      const tiny = compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('100.010') }, CONFIG);
      expect(tiny.kind).toBe('disagree_material');
    });
  });

  describe('objective resolution — the DOCUMENT decides, not a preference', () => {
    it('the printed running unit balance settles a units disagreement when exactly one candidate closes the arithmetic', () => {
      // Opening 0 + 100 = 100, which is what the statement printed. The AI's
      // 110 does not close. The deterministic value wins HERE because the
      // document says so, not because it is deterministic.
      const result = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('100.000') },
      );
      expect(result.kind).toBe('objectively_resolved');
      expect(result).toMatchObject({ winner: 'deterministic', value: '100.000', resolvedBy: 'printed_running_unit_balance_roll_forward' });
    });

    it('the SAME mechanism picks the AI value when the AI is the one that closes — proving it is not a dressed-up precedence rule', () => {
      // This is the test that distinguishes a genuine tie-breaker from
      // "deterministic wins, with extra steps". The arithmetic is identical;
      // only which side is right has changed.
      const result = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('110.000') },
      );
      expect(result.kind).toBe('objectively_resolved');
      expect(result).toMatchObject({ winner: 'ai', value: '110.000' });
    });

    it('when NEITHER candidate closes, the disagreement STANDS — the nearer one is not chosen', () => {
      // The printed balance disagreeing with both sources is itself a
      // finding. Picking the closer value would manufacture an answer out of
      // a document that contradicts everything.
      const result = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('500.000') },
      );
      expect(result.kind).toBe('disagree_material');
    });

    it('the tie-breaker is NOT applied to a field where the identity does not hold', () => {
      // "opening + amount == running unit balance" is not true of amounts or
      // NAVs. Applying it there would fabricate a winner.
      const result = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'amount', deterministic: det('5000.00'), ai: ai('5500.00') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('5000.00') },
      );
      expect(result.kind).toBe('disagree_material');
    });

    it('an objective resolution carries the arithmetic that decided it, so the decision is auditable', () => {
      const result = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('100.000') },
      ) as Extract<FieldComparison, { kind: 'objectively_resolved' }>;
      expect(result.evidence).toMatchObject({
        deterministicCandidate: '100.000',
        aiCandidate: '110.000',
        deterministicClosesArithmetic: true,
        aiClosesArithmetic: false,
      });
      expect(result.evidence.printedRunningBalance).toBeDefined();
      expect(result.evidence.unitTolerance).toBeDefined();
    });
  });

  describe('unresolved items carry BOTH candidates and BOTH provenances', () => {
    const comparisons: FieldComparison[] = [
      compareFieldEvidence({ recordRef: 'transaction:3', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') }, CONFIG),
      compareFieldEvidence({ recordRef: 'transaction:3', fieldName: 'narrative', deterministic: det('Purchase'), ai: ai('Buy') }, CONFIG),
      compareFieldEvidence({ recordRef: 'transaction:4', fieldName: 'units', deterministic: det('50.000'), ai: ai('50.000') }, CONFIG),
    ];

    it('creates a BLOCKING item for the material disagreement only', () => {
      const items = unresolvedItemsForDisagreements(comparisons);
      expect(items).toHaveLength(1);
      expect(items[0].severity).toBe('blocking');
      expect(items[0].reasonCode).toBe('ii_adapter:source_disagreement:units');
    });

    it('the item is ACTIONABLE — PC5 cannot present a choice it was not given the options for', () => {
      const [item] = unresolvedItemsForDisagreements(comparisons);
      const evidence = item.evidenceRef as Record<string, Record<string, unknown>>;
      expect(evidence.deterministic.value).toBe('100.000');
      expect(evidence.ai.value).toBe('110.000');
      expect(evidence.deterministic.producedBy).toBe('cams_detailed_v1@1.0.0');
      expect(evidence.ai.producedBy).toBe('aie_ii_document_facts@1');
      expect(evidence.deterministic.provenance).toBeDefined();
      expect(evidence.ai.provenance).toBeDefined();
    });

    it('the display string names both candidates without implying either is authoritative', () => {
      const [item] = unresolvedItemsForDisagreements(comparisons);
      expect(item.displayCandidate).toContain('100.000');
      expect(item.displayCandidate).toContain('110.000');
      expect(item.displayCandidate).not.toMatch(/correct|authoritative|preferred|wins/i);
    });

    it('uses AIE-1.5\'s existing action vocabulary — no bespoke action type is forked here', () => {
      const [item] = unresolvedItemsForDisagreements(comparisons);
      expect(item.permittedActionTypes).toEqual(['request_reprocessing', 'reject_document']);
    });

    it('an OBJECTIVELY RESOLVED disagreement produces no item, but is still recorded as evidence', () => {
      const resolved = compareFieldEvidence(
        { recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') },
        CONFIG,
        { openingUnitsScaled: scaled('0'), printedRunningBalanceScaled: scaled('100.000') },
      );
      expect(unresolvedItemsForDisagreements([resolved])).toHaveLength(0);
      // Silently discarding "the two sources disagreed and the document
      // settled it" would hide a real signal about parser quality.
      const audit = objectiveResolutionsForAudit([resolved]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ recordRef: 'transaction:0', fieldName: 'units', winner: 'deterministic' });
    });
  });

  it('NO CONFIDENCE ANYWHERE — the comparison signature has no channel for a score (P4/REC-04)', () => {
    // Structural: the only way a confidence value could influence the outcome
    // is if it could be passed in. `compareFieldEvidence` takes exactly three
    // parameters, none of which is a score.
    expect(compareFieldEvidence.length).toBe(3); // input, config, tieBreak
    const serialised = JSON.stringify(
      compareFieldEvidence({ recordRef: 'transaction:0', fieldName: 'units', deterministic: det('100.000'), ai: ai('110.000') }, CONFIG),
    );
    expect(serialised).not.toMatch(/confidence/i);
  });
});
