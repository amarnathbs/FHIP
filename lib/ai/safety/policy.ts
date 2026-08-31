// Module 11.0 — safety policy versioning (spec section 30).
//
// A minimal, versioned policy: for each SafetyClassification, whether a
// request is blocked outright, and the disclosure text to attach when it is
// allowed but boundary-adjacent. Full conversational routing is deferred
// (spec section 30) — this is the policy CONTRACT prompts/gateway code will
// consult once routing exists.

import type { SafetyClassification } from '@/lib/ai/structuredOutput';

export const SAFETY_POLICY_VERSION = 'safety-policy-1.0.0';

export interface SafetyPolicyRule {
  classification: SafetyClassification;
  blocked: boolean;
  requiresDisclosure: boolean;
  disclosureText: string | null;
}

// Spec section 31's advice boundary, encoded as policy data rather than
// scattered conditionals — the classifier (lib/ai/safety/classification.ts)
// only decides WHAT a request is; this decides WHAT HAPPENS given that
// classification, so the two can evolve independently across policy
// versions.
export const SAFETY_POLICY_V1: Readonly<SafetyPolicyRule[]> = [
  { classification: 'GENERAL_EDUCATION', blocked: false, requiresDisclosure: false, disclosureText: null },
  { classification: 'FHIP_EXPLANATION', blocked: false, requiresDisclosure: false, disclosureText: null },
  { classification: 'SCENARIO_REQUEST', blocked: false, requiresDisclosure: true, disclosureText: 'This is a modelled estimate, not a guaranteed outcome.' },
  { classification: 'PRODUCT_ADVICE', blocked: true, requiresDisclosure: false, disclosureText: 'FHIP does not recommend specific financial products.' },
  { classification: 'TAX_ADVICE', blocked: true, requiresDisclosure: false, disclosureText: 'FHIP does not provide personalised tax advice — consult a registered tax agent.' },
  { classification: 'LEGAL_ADVICE', blocked: true, requiresDisclosure: false, disclosureText: 'FHIP does not provide legal advice — consult a licensed professional.' },
  { classification: 'MONEY_MOVEMENT', blocked: true, requiresDisclosure: false, disclosureText: 'FHIP AI cannot move money or execute transactions on your behalf.' },
  { classification: 'DATA_WRITE', blocked: true, requiresDisclosure: false, disclosureText: 'FHIP AI cannot modify your financial records in this phase.' },
  { classification: 'UNSUPPORTED_PREDICTION', blocked: false, requiresDisclosure: true, disclosureText: 'This outcome cannot be guaranteed and is not a prediction of future results.' },
  { classification: 'PRIVACY_SENSITIVE', blocked: true, requiresDisclosure: false, disclosureText: 'This request references identifiers that cannot be processed by FHIP AI.' },
  { classification: 'PROMPT_INJECTION_SUSPECTED', blocked: true, requiresDisclosure: false, disclosureText: null },
];

export function getPolicyRule(classification: SafetyClassification, policy: Readonly<SafetyPolicyRule[]> = SAFETY_POLICY_V1): SafetyPolicyRule {
  const rule = policy.find((r) => r.classification === classification);
  if (!rule) {
    // Fail closed on an unrecognised classification rather than silently
    // allowing it through (spec section 47).
    return { classification, blocked: true, requiresDisclosure: false, disclosureText: 'Unrecognised safety classification — blocked by default.' };
  }
  return rule;
}
