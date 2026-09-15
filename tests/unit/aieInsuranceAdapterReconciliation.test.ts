/**
 * AIE-1.4 — Insurance adapter: reconciliation rule tests (AIE14-INS-09/10,
 * P4 — no confidence input anywhere).
 */
import { describe, it, expect } from 'vitest';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import { parseInsuranceDocument } from '@/lib/aie/adapters/insurance/parser';
import { buildAieInsuranceFixtureText, buildAieInsurancePdsFixtureText } from '../support/buildAieInsuranceFixtureText';

function runRule(text: string) {
  const parsed = parseInsuranceDocument(text);
  const rule = buildInsuranceReconciliationRule();
  return rule({ runId: 'run-1', candidates: parsed.candidates });
}

function outcomeFor(results: ReturnType<typeof runRule>, ruleId: string) {
  return results.find((r) => r.ruleId === ruleId)?.outcome;
}

describe('AIE-1.4 Insurance adapter — reconciliation rule', () => {
  it('a clean, fully-reconciling policy schedule passes every rule (fixture: premium 100.00/month x 12 = printed annual total 1200.00 exactly)', () => {
    const results = runRule(buildAieInsuranceFixtureText());
    expect(outcomeFor(results, 'insurance_document_class_supported')).toBe('pass');
    expect(outcomeFor(results, 'insurance_required_fields_present')).toBe('pass');
    expect(outcomeFor(results, 'insurance_currency_supported')).toBe('pass');
    expect(outcomeFor(results, 'insurance_multi_component_not_supported')).toBe('not_applicable');
    expect(outcomeFor(results, 'insurance_premium_totals_reconciled')).toBe('pass');
  });

  it('an unsupported document sub-class (PDS) fails the class-supported rule and every other rule stays not_applicable — no double-guessing', () => {
    const results = runRule(buildAieInsurancePdsFixtureText());
    expect(outcomeFor(results, 'insurance_document_class_supported')).toBe('fail');
    expect(outcomeFor(results, 'insurance_required_fields_present')).toBe('not_applicable');
  });

  it('an unsupported currency fails currencySupported without touching pass/fail of other rules', () => {
    const results = runRule(buildAieInsuranceFixtureText({ currency: 'USD' }));
    expect(outcomeFor(results, 'insurance_currency_supported')).toBe('fail');
    expect(outcomeFor(results, 'insurance_required_fields_present')).toBe('pass'); // currencyCode field IS present, just unsupported
  });

  it('a missing required field fails requiredFieldsPresent', () => {
    const results = runRule(buildAieInsuranceFixtureText({ omitFields: ['coverAmount'] }));
    expect(outcomeFor(results, 'insurance_required_fields_present')).toBe('fail');
  });

  it('a multi-component policy is reported indeterminate, never silently collapsed to the first component (AIE14-INS-08/09)', () => {
    const results = runRule(buildAieInsuranceFixtureText({ includeSecondComponent: true }));
    expect(outcomeFor(results, 'insurance_multi_component_not_supported')).toBe('indeterminate');
  });

  it('a printed annual premium total that does NOT match premium x periods-per-year fails premiumTotalsReconciled', () => {
    const results = runRule(buildAieInsuranceFixtureText({ annualPremiumTotal: '5000.00' })); // way off from 100*12=1200
    expect(outcomeFor(results, 'insurance_premium_totals_reconciled')).toBe('fail');
  });

  it('a printed annual premium total within 1% tolerance passes_with_tolerance rather than a hard fail', () => {
    const results = runRule(buildAieInsuranceFixtureText({ annualPremiumTotal: '1205.00' })); // 1200 expected, 5 off, within 1%*1200=12 tolerance
    expect(outcomeFor(results, 'insurance_premium_totals_reconciled')).toBe('pass_with_tolerance');
  });

  it('no printed annual total on the document means premiumTotalsReconciled is not_applicable, never a fabricated pass', () => {
    const results = runRule(buildAieInsuranceFixtureText({ omitFields: ['annualPremiumTotal'] }));
    expect(outcomeFor(results, 'insurance_premium_totals_reconciled')).toBe('not_applicable');
  });

  it('has NO confidence-shaped parameter anywhere in its signature (P4) — verified structurally: the rule takes only {runId, candidates}', () => {
    const rule = buildInsuranceReconciliationRule();
    expect(rule.length).toBeLessThanOrEqual(1); // exactly one positional param: the request object
  });

  // -------------------------------------------------------------------------
  // M12B-F4 / M12B-F5 — `insurance_printed_fact_completeness`.
  // -------------------------------------------------------------------------
  describe('M12B — printed-fact completeness', () => {
    it('a clean policy asserts completeness POSITIVELY rather than staying silent', () => {
      const results = runRule(buildAieInsuranceFixtureText());
      const r = results.find((x) => x.ruleId === 'insurance_printed_fact_completeness');
      expect(r?.outcome).toBe('pass');
      expect(r?.materiality).toBe('all_printed_facts_read');
    });

    it('money printed under a label the taxonomy does not recognise is reported indeterminate, not lost (M12B-F4)', () => {
      const text = `${buildAieInsuranceFixtureText()}\nTrauma Cover: 150,000.00`;
      const results = runRule(text);
      const r = results.find((x) => x.ruleId === 'insurance_printed_fact_completeness');
      expect(r?.outcome).toBe('indeterminate');
      expect(r?.materiality).toBe('printed_fact_unread');
      expect(r?.delta).toBe(1);
      // And the other rules are untouched — "did the arithmetic close?" and
      // "did we read everything?" stay two separate questions.
      expect(outcomeFor(results, 'insurance_premium_totals_reconciled')).toBe('pass');
      expect(outcomeFor(results, 'insurance_required_fields_present')).toBe('pass');
    });

    it('a NON-money value under an unrecognised label is NOT flagged — the rule is deliberately narrow', () => {
      const text = `${buildAieInsuranceFixtureText()}\nBranch Reference: NORTH-4471\nCustomer Care: 1800 000 000`;
      const results = runRule(text);
      expect(outcomeFor(results, 'insurance_printed_fact_completeness')).toBe('pass');
    });

    it('a renewal date printed in an uncertified format is reported rather than silently dropped (M12B-F5)', () => {
      const parsed = parseInsuranceDocument(buildAieInsuranceFixtureText({ renewalDate: '31/08/2027' }));
      // Still never GUESSED at — no renewalDate candidate is invented.
      expect(parsed.candidates.find((c) => c.fieldName === 'renewalDate')).toBeUndefined();
      const evidence = parsed.candidates.find((c) => c.fieldName === 'unreadablePrintedFactEvidence');
      expect(JSON.parse(evidence!.valueRaw as string)).toEqual([{ label: 'renewal date', reason: 'unsupported_date_format' }]);

      const results = buildInsuranceReconciliationRule()({ runId: 'run-1', candidates: parsed.candidates });
      expect(outcomeFor(results, 'insurance_printed_fact_completeness')).toBe('indeterminate');
    });

    it('an ABSENT completeness candidate fails CLOSED — a run from a pre-M12B parser must block, never sail through', () => {
      // The entire defect was an absent signal being read as good news.
      const parsed = parseInsuranceDocument(buildAieInsuranceFixtureText());
      const withoutCandidate = parsed.candidates.filter((c) => c.fieldName !== 'unreadablePrintedFactCount');
      const results = buildInsuranceReconciliationRule()({ runId: 'run-1', candidates: withoutCandidate });
      const r = results.find((x) => x.ruleId === 'insurance_printed_fact_completeness');
      expect(r?.outcome).toBe('indeterminate');
      expect(r?.materiality).toBe('completeness_not_reported');
    });

    it('an out-of-scope document sub-class reports not_applicable — no noise on an already-rejected document', () => {
      const results = runRule(buildAieInsurancePdsFixtureText());
      expect(outcomeFor(results, 'insurance_printed_fact_completeness')).toBe('not_applicable');
    });
  });
});
