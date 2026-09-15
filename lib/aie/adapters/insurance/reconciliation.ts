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
import {
  INSURANCE_SUPPORTED_CURRENCIES,
  INSURANCE_UNREADABLE_PRINTED_FACT_COUNT_FIELD,
  PERIODS_PER_YEAR,
  type InsurancePremiumFrequency,
} from './types';

const RULE_VERSION = '1';

/**
 * AIE-1.5 addition (disclosed): extracted from `requiredFieldsPresentResult`
 * below into a named export so AIE-1.5's review layer
 * (`lib/aie/review/moduleRegistry.ts`) can compute exactly which required
 * field(s) are missing for a given run without duplicating this list —
 * the SAME single source of truth this rule already used inline. No
 * behaviour changes: `requiredFieldsPresentResult` is refactored to read
 * from this constant instead of its own local literal.
 */
export const INSURANCE_REQUIRED_FIELDS = ['policyName', 'coverAmount', 'premium', 'premiumFrequency', 'currencyCode'] as const;

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
  const missing = INSURANCE_REQUIRED_FIELDS.filter((f) => !fields.has(f));
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

export const RULE_PRINTED_FACT_COMPLETENESS = 'insurance_printed_fact_completeness';

/**
 * M12B (M12B-F4 / M12B-F5) — ITS OWN RULE, asking its own question.
 *
 * *"Did the arithmetic close?"* and *"did we read everything the policy
 * printed?"* are two questions, and the answer to one must never be read off
 * the other. INS-B12's premium arithmetic closes to the cent while 150,000.00
 * of printed cover is missing, and INS-B14 reconciles perfectly with its
 * renewal date gone — both reached `awaiting_acceptance` and both wrote an
 * incomplete policy on an explicit accept. So the existing rules are untouched
 * and this is added alongside them.
 *
 * Three deliberate choices, each one mirroring M12A-F1's own resolution on
 * FDH-bank because the defect is the same shape:
 *
 *  1. `indeterminate`, NEVER `fail`. This adapter does not know the unread
 *     facts are WRONG — only that it could not read them, which is precisely
 *     what INDETERMINATE means everywhere else in this file.
 *  2. Emitted even at zero, as an explicit `pass`. A positive assertion beats
 *     silence, and the blocking item is produced by AIE-1.1 core's own
 *     unchanged `blockingItemsForReconciliation`, so no second exception
 *     channel is introduced (P7).
 *  3. An ABSENT candidate is `indeterminate`, not `pass`. The entire defect was
 *     an absent signal being read as good news, so a run produced by a
 *     pre-M12B parser must block rather than sail through.
 */
function printedFactCompletenessResult(fields: Map<string, string>): AieReconciliationRunResult {
  // Only meaningful once the document class itself is a supported one. An
  // out-of-scope sub-class is already reported by `documentClassSupportedResult`
  // and its parser returns before any line is read, so there is nothing to be
  // complete ABOUT — reporting an unread-fact item on top would just be noise
  // on an already-rejected document. Same reasoning, and same shape, as
  // `requiredFieldsPresentResult` above.
  const subClass = fields.get('documentSubClass');
  if (!subClass || !isInsuranceDocumentClassCertified(subClass)) {
    return { ruleId: RULE_PRINTED_FACT_COMPLETENESS, ruleVersion: RULE_VERSION, outcome: 'not_applicable' };
  }
  const raw = fields.get(INSURANCE_UNREADABLE_PRINTED_FACT_COUNT_FIELD);
  if (raw === undefined) {
    return { ruleId: RULE_PRINTED_FACT_COMPLETENESS, ruleVersion: RULE_VERSION, outcome: 'indeterminate', materiality: 'completeness_not_reported' };
  }
  const count = Number(raw);
  if (!Number.isFinite(count) || count < 0) {
    return { ruleId: RULE_PRINTED_FACT_COMPLETENESS, ruleVersion: RULE_VERSION, outcome: 'indeterminate', materiality: 'completeness_not_reported' };
  }
  if (count === 0) {
    return { ruleId: RULE_PRINTED_FACT_COMPLETENESS, ruleVersion: RULE_VERSION, outcome: 'pass', materiality: 'all_printed_facts_read' };
  }
  return { ruleId: RULE_PRINTED_FACT_COMPLETENESS, ruleVersion: RULE_VERSION, outcome: 'indeterminate', delta: count, materiality: 'printed_fact_unread' };
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
      printedFactCompletenessResult(fields),
    ];
  };
}
