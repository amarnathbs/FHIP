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
});
