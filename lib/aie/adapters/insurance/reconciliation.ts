/**
 * AIE-1.4 — Insurance adapter's own deterministic reconciliation rule
 * (execution sequence step 5/AIE14-INS-09/10), wired into AIE-1.1's
 * `ReconciliationRule` contract (lib/aie/reconciliation/types.ts) exactly
 * like AIE-1.2/1.3's own adapter rules — no orchestrator change required
 * (the shared `runExtractionPipeline` calls whatever `ReconciliationRule`
 * its caller injects).
 *
 * NO CONFIDENCE SCORE INPUT (P4) — like AIE-1.1's own `ReconciliationRule`
 * type, this function's signature has no `confidence` parameter anywhere.
 *
 * Every genuinely adapter-specific exception this pass needs (unsupported
 * document sub-class, unsupported currency, missing required fields,
 * un-reconcilable multi-component policy) is expressed as a distinct
 * `AieReconciliationRunResult` here, rather than as a second, parallel
 * exception mechanism — `blockingItemsForReconciliation`
 * (lib/aie/reconciliation/types.ts, AIE-1.1 core, unchanged) turns any
 * `fail`/`indeterminate` result into a blocking `aie_unresolved_item` row
 * keyed on this rule's own `ruleId`, so every reason code below is
 * traceable straight back to the check that raised it.
 */

import type { ReconciliationHandoffRequest, ReconciliationRule } from '../../reconciliation/types';
import type { AieFieldCandidate, AieReconciliationRunResult } from '../../types';
import { isInsuranceDocumentClassCertified } from './documentCatalogue';
import { INSURANCE_SUPPORTED_CURRENCIES, PERIODS_PER_YEAR, type InsurancePremiumFrequency } from './types';

const RULE_VERSION = '1';

function fieldMap(candidates: readonly AieFieldCandidate[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of candidates) {
    if (!c.isNull && c.valueRaw !== null) map.set(c.fieldName, c.valueRaw);
  }
  return map;
}

function documentClassSupportedResult(fields: Map<string, string>): AieReconciliationRunResult {
  const subClass = fields.get('documentSubClass');
  if (!subClass) return { ruleId: 'insurance_document_class_supported', ruleVersion: RULE_VERSION, outcome: 'indeterminate' };
  return {
    ruleId: 'insurance_document_class_supported',
    ruleVersion: RULE_VERSION,
    outcome: isInsuranceDocumentClassCertified(subClass) ? 'pass' : 'fail',
  };
}

function requiredFieldsPresentResult(fields: Map<string, string>): AieReconciliationRunResult {
  const subClass = fields.get('documentSubClass');
  // Only meaningful once the document class itself is a supported one — an
  // out-of-scope sub-class is already reported by
  // `documentClassSupportedResult` above; re-reporting every missing
  // canonical field on top of that would just be noise on an already-
  // rejected document.
  if (!subClass || !isInsuranceDocumentClassCertified(subClass)) {
    return { ruleId: 'insurance_required_fields_present', ruleVersion: RULE_VERSION, outcome: 'not_applicable' };
  }
  const required = ['policyName', 'coverAmount', 'premium', 'premiumFrequency', 'currencyCode'];
  const missing = required.filter((f) => !fields.has(f));
  return {
    ruleId: 'insurance_required_fields_present',
    ruleVersion: RULE_VERSION,
    outcome: missing.length === 0 ? 'pass' : 'fail',
  };
}

function currencySupportedResult(fields: Map<string, string>): AieReconciliationRunResult {
  const currency = fields.get('currencyCode');
  if (!currency) return { ruleId: 'insurance_currency_supported', ruleVersion: RULE_VERSION, outcome: 'not_applicable' };
  return {
    ruleId: 'insurance_currency_supported',
    ruleVersion: RULE_VERSION,
    outcome: (INSURANCE_SUPPORTED_CURRENCIES as readonly string[]).includes(currency) ? 'pass' : 'fail',
  };
}

function multiComponentResult(fields: Map<string, string>): AieReconciliationRunResult {
  const flag = fields.get('multiComponentPolicyDetected');
  return {
    ruleId: 'insurance_multi_component_not_supported',
    ruleVersion: RULE_VERSION,
    // Genuinely cannot be determined correct or incorrect against a single
    // flat canonical row (AIE14-INS-08/09) — indeterminate, not a guess.
    outcome: flag === 'true' ? 'indeterminate' : 'not_applicable',
  };
}

/** AIE14-INS-09: "Reconcile component covers/premiums to printed totals
 * where defined." No statutory/insurance rate is invented anywhere here —
 * the only arithmetic is periods-per-year x the document's OWN stated
 * per-period premium, compared against the document's OWN printed annual
 * total. */
function premiumTotalsReconciledResult(fields: Map<string, string>): AieReconciliationRunResult {
  const printedTotalRaw = fields.get('printedAnnualPremiumTotal');
  const premiumRaw = fields.get('premium');
  const frequencyRaw = fields.get('premiumFrequency') as InsurancePremiumFrequency | undefined;
  if (!printedTotalRaw || !premiumRaw || !frequencyRaw) {
    return { ruleId: 'insurance_premium_totals_reconciled', ruleVersion: RULE_VERSION, outcome: 'not_applicable' };
  }
  const printedTotal = Number(printedTotalRaw);
  const premium = Number(premiumRaw);
  const periodsPerYear = PERIODS_PER_YEAR[frequencyRaw];
  if (!Number.isFinite(printedTotal) || !Number.isFinite(premium) || !periodsPerYear) {
    return { ruleId: 'insurance_premium_totals_reconciled', ruleVersion: RULE_VERSION, outcome: 'indeterminate' };
  }
  const expected = premium * periodsPerYear;
  const delta = Math.abs(expected - printedTotal);
  const tolerance = Math.max(1, expected * 0.01);
  let outcome: AieReconciliationRunResult['outcome'];
  if (delta === 0) outcome = 'pass';
  else if (delta <= tolerance) outcome = 'pass_with_tolerance';
  else outcome = 'fail';
  return { ruleId: 'insurance_premium_totals_reconciled', ruleVersion: RULE_VERSION, outcome, delta, tolerance };
}

export function buildInsuranceReconciliationRule(): ReconciliationRule {
  return (req: ReconciliationHandoffRequest): AieReconciliationRunResult[] => {
    const fields = fieldMap(req.candidates);
    return [
      documentClassSupportedResult(fields),
      requiredFieldsPresentResult(fields),
      currencySupportedResult(fields),
      multiComponentResult(fields),
      premiumTotalsReconciledResult(fields),
    ];
  };
}
