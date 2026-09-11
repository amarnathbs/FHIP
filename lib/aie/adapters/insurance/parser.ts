/**
 * AIE-1.4 — Insurance adapter: deterministic classifier + parser (execution
 * sequence step 6: "Implement deterministic parsers first; add masked AI
 * only for approved gaps"), registered against AIE-1.1's EXISTING
 * `aieParserRegistry` (lib/aie/classifier/registry.ts) — no second registry
 * is created (mandatory execution sequence step 5).
 *
 * See documentCatalogue.ts's header for the "no existing insurance parser
 * to wrap, bounded generic layout" disclosure, and labels.ts's header for
 * the label-matching design this file drives.
 *
 * SNIFF THRESHOLD. `sniff()` claims a document ONLY when at least two
 * distinct strong insurance-domain signals are present (REG-02: "safe
 * artifacts, not filename alone"; REG-03: an ambiguous/weak claim must
 * never silently win). A single loose keyword (e.g. "cover") is common
 * enough in unrelated financial documents that claiming on it alone would
 * risk misrouting non-insurance text into this adapter.
 */

import type { DeterministicParserResult, RegisteredParser } from '../../classifier/registry';
import { aieParserRegistry } from '../../classifier/registry';
import type { AieFieldCandidate } from '../../types';
import { matchInsuranceLabel } from './labels';
import { isInsuranceDocumentClassCertified } from './documentCatalogue';
import { INSURANCE_COVER_TYPES, INSURANCE_PREMIUM_FREQUENCIES, type InsuranceCoverType, type InsurancePremiumFrequency } from './types';

export const INSURANCE_ADAPTER_ID = 'insurance_generic_schedule_v1';
export const INSURANCE_ADAPTER_VERSION = '1';

const STRONG_SIGNAL_TERMS = [
  'sum insured',
  'policy number',
  'policy owner',
  'insured person',
  'life insured',
  'premium frequency',
  'waiting period',
  'beneficiary',
  'policy schedule',
  'renewal notice',
  'premium notice',
  'insurer',
];

function countStrongSignals(normalisedText: string): number {
  let count = 0;
  for (const term of STRONG_SIGNAL_TERMS) {
    if (normalisedText.includes(term)) count++;
  }
  return count;
}

export function sniffInsuranceDocument(extractedText: string): boolean {
  const normalised = extractedText.toLowerCase();
  return countStrongSignals(normalised) >= 2;
}

/** Never guessed — first matching header keyword wins, most specific first. */
function detectDocumentSubClass(normalisedText: string): string {
  if (normalisedText.includes('product disclosure statement') || /\bpds\b/.test(normalisedText)) return 'product_disclosure_statement';
  if (normalisedText.includes('claim')) return 'claim_document';
  if (normalisedText.includes('policy schedule')) return 'policy_schedule';
  if (normalisedText.includes('renewal notice')) return 'renewal_notice';
  if (normalisedText.includes('premium notice')) return 'premium_notice';
  return 'unclassified_insurance_document';
}

function normaliseCoverType(raw: string): InsuranceCoverType {
  const v = raw.toLowerCase();
  if (v.includes('income protection') || v.includes('salary continuance')) return 'income_protection';
  if (v.includes('life')) return 'life';
  if (v.includes('health') || v.includes('medical')) return 'health';
  if (v.includes('home') || v.includes('building') || v.includes('contents') || v.includes('landlord')) return 'home';
  if (v.includes('vehicle') || v.includes('car') || v.includes('motor') || v.includes('auto')) return 'vehicle';
  return (INSURANCE_COVER_TYPES as readonly string[]).includes(v) ? (v as InsuranceCoverType) : 'other';
}

function normaliseFrequency(raw: string): InsurancePremiumFrequency | null {
  const v = raw.toLowerCase();
  if (v.includes('week')) return 'weekly';
  if (v.includes('fortnight') || v.includes('biweek')) return 'fortnightly';
  if (v.includes('month')) return 'monthly';
  if (v.includes('quarter')) return 'quarterly';
  if (v.includes('annual') || v.includes('yearly') || v.includes('year')) return 'annually';
  if (v.includes('one off') || v.includes('one-off') || v.includes('single')) return 'one_off';
  return (INSURANCE_PREMIUM_FREQUENCIES as readonly string[]).includes(v) ? (v as InsurancePremiumFrequency) : null;
}

function extractNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,$]/g, '').match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : null;
}

function extractInt(raw: string): number | null {
  const cleaned = raw.match(/-?\d+/);
  return cleaned ? Number(cleaned[0]) : null;
}

/** Never returns the raw digits — first-2/last-4 visible, matching
 * `lib/services/investment-intelligence/parsers/textUtils.ts`'s `maskPan`
 * masking convention in substance (partial visibility, majority redacted). */
function maskPolicyNumber(raw: string): string {
  const digits = raw.replace(/\s+/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function candidate(fieldName: string, valueRaw: string | null, extra?: Partial<AieFieldCandidate>): AieFieldCandidate {
  return {
    fieldName,
    valueRaw,
    isNull: valueRaw === null,
    sourceMethod: 'deterministic',
    ...extra,
  };
}

export function parseInsuranceDocument(extractedText: string): DeterministicParserResult {
  const normalisedText = extractedText.toLowerCase();
  const documentSubClass = detectDocumentSubClass(normalisedText);
  const candidates: AieFieldCandidate[] = [candidate('documentSubClass', documentSubClass)];

  if (!isInsuranceDocumentClassCertified(documentSubClass)) {
    // AIE14-INS-01/ELIG-06/ELIG-07 — fail safely and explicitly rather than
    // coercing an out-of-scope sub-class into the policy-schedule shape.
    return {
      outcome: 'failed',
      documentClass: documentSubClass,
      candidates,
      aiEligibleGaps: [],
      failureReason: `insurance_document_sub_class_not_supported:${documentSubClass}`,
    };
  }

  const lines = extractedText.split(/\r?\n/);
  const fieldOccurrences = new Map<string, string[]>();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const label = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    const field = matchInsuranceLabel(label);
    if (!field) continue; // unrecognised label — never guessed at (AIE14-INS-10)
    const existing = fieldOccurrences.get(field) ?? [];
    existing.push(value);
    fieldOccurrences.set(field, existing);
  }

  const first = (field: string): string | undefined => fieldOccurrences.get(field)?.[0];
  const occurrenceCount = (field: string): number => fieldOccurrences.get(field)?.length ?? 0;

  // AIE14-INS-08/09 — multiple coverage components in one policy cannot be
  // reconciled to this table's single flat row; flagged, never collapsed
  // silently to "just take the first one and hope".
  const multiComponentPolicyDetected = occurrenceCount('coverAmount') > 1 || occurrenceCount('premium') > 1;
  candidates.push(candidate('multiComponentPolicyDetected', multiComponentPolicyDetected ? 'true' : 'false'));

  // --- Canonical fields (written to insurance_policies if all required present)
  const productName = first('productName');
  if (productName) candidates.push(candidate('policyName', productName));

  const policyTypeRaw = first('policyType');
  if (policyTypeRaw) candidates.push(candidate('coverType', normaliseCoverType(policyTypeRaw)));

  const coverAmountRaw = first('coverAmount');
  const coverAmount = coverAmountRaw ? extractNumber(coverAmountRaw) : null;
  if (coverAmount !== null) candidates.push(candidate('coverAmount', String(coverAmount)));

  const premiumRaw = first('premium');
  const premium = premiumRaw ? extractNumber(premiumRaw) : null;
  if (premium !== null) candidates.push(candidate('premium', String(premium)));

  const frequencyRaw = first('premiumFrequency');
  const frequency = frequencyRaw ? normaliseFrequency(frequencyRaw) : null;
  if (frequency) candidates.push(candidate('premiumFrequency', frequency));

  const currencyRaw = first('currency');
  if (currencyRaw) candidates.push(candidate('currencyCode', currencyRaw.trim().toUpperCase()));

  const renewalDateRaw = first('renewalDate');
  if (renewalDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(renewalDateRaw.trim())) {
    candidates.push(candidate('renewalDate', renewalDateRaw.trim()));
  }

  const waitingPeriodRaw = first('waitingPeriodDays');
  const waitingPeriodDays = waitingPeriodRaw ? extractInt(waitingPeriodRaw) : null;
  if (waitingPeriodDays !== null) candidates.push(candidate('waitingPeriodDays', String(waitingPeriodDays)));

  const benefitPeriod = first('benefitPeriod');
  if (benefitPeriod) candidates.push(candidate('benefitPeriod', benefitPeriod));

  const insurer = first('insurer');
  if (insurer) candidates.push(candidate('provider', insurer));

  // --- Evidence-only fields (never written — no canonical column exists) --
  const policyNumberRaw = first('policyNumber');
  if (policyNumberRaw) candidates.push(candidate('policyNumberMasked', maskPolicyNumber(policyNumberRaw)));
  const policyOwnerName = first('policyOwnerName');
  if (policyOwnerName) candidates.push(candidate('policyOwnerName', policyOwnerName));
  const insuredPersonName = first('insuredPersonName');
  if (insuredPersonName) candidates.push(candidate('insuredPersonName', insuredPersonName));
  const beneficiaryName = first('beneficiaryName');
  if (beneficiaryName) candidates.push(candidate('beneficiaryName', beneficiaryName));
  const excessRaw = first('excess');
  if (excessRaw) candidates.push(candidate('excessAmount', String(extractNumber(excessRaw) ?? excessRaw)));
  const exclusions = first('exclusions');
  if (exclusions) candidates.push(candidate('exclusionsText', exclusions));
  const annualPremiumTotalRaw = first('annualPremiumTotal');
  const annualPremiumTotal = annualPremiumTotalRaw ? extractNumber(annualPremiumTotalRaw) : null;
  if (annualPremiumTotal !== null) candidates.push(candidate('printedAnnualPremiumTotal', String(annualPremiumTotal)));

  const requiredPresent = Boolean(productName) && coverAmount !== null && premium !== null && Boolean(frequency) && Boolean(currencyRaw);

  // The ONLY AI-eligible gap this adapter ever declares — a narrative
  // clarification, never identity/instrument/currency/value (see schema.ts).
  const aiEligibleGaps: string[] = !productName ? ['policyNameClarification'] : [];

  return {
    outcome: requiredPresent ? 'complete' : 'partial',
    documentClass: documentSubClass,
    candidates,
    aiEligibleGaps,
  };
}

export const insuranceRegisteredParser: RegisteredParser = {
  adapterId: INSURANCE_ADAPTER_ID,
  version: INSURANCE_ADAPTER_VERSION,
  moduleHint: 'other',
  sniff: sniffInsuranceDocument,
  parse: parseInsuranceDocument,
};

let registered = false;

/** Idempotent — safe to call from multiple module-load sites / tests. */
export function registerInsuranceAieParser(): void {
  if (registered) return;
  aieParserRegistry.register(insuranceRegisteredParser);
  registered = true;
}
