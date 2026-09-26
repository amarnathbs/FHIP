/**
 * Field dispositions -- INSURANCE policy uploads and the other AIE-fronted
 * intakes. ACTIVE USER FLOW: NO (matrix section 6): no UI calls these routes
 * and their flags are unset in production. Every entry is `not_active`; the
 * latent defects INS-01..INS-06 are recorded, not certified.
 *
 * tests/unit/inactiveUploadFlowGuard.test.ts FAILS if any page or component
 * starts calling one of INACTIVE_UPLOAD_FLOWS while it is still `not_active`
 * here -- so activating a flow forces this registry, and the matrix, to be
 * updated first (INS-00).
 */
import { A, C, E, rows, type Row } from './build';
import type { RegistryFile } from './types';

const CANONICAL: Row[] = [
  ['policyName', A, 'insurance_policies.policy_name'],
  ['coverType', A, 'insurance_policies.cover_type (raw label lost when "other": INS-05, latent)'],
  ['coverAmount', A, 'insurance_policies.cover_amount'],
  ['premium', A, 'insurance_policies.premium'],
  ['premiumFrequency', A, 'insurance_policies.premium_frequency'],
  ['currencyCode', A, 'insurance_policies.currency_code'],
  ['renewalDate', A, 'insurance_policies.renewal_date'],
  ['waitingPeriodDays', A, 'insurance_policies.waiting_period_days (unit lost: INS-01, latent)'],
  ['benefitPeriod', A, 'insurance_policies.benefit_period'],
  ['provider', A, 'insurance_policies.provider'],
];

const EVIDENCE: Row[] = [
  ['documentSubClass', C, 'aie_field_candidate (document sub-class)'],
  ['policyNumberMasked', C, 'aie_field_candidate (INS-03, latent: not visible after accept)'],
  ['policyOwnerName', C, 'aie_field_candidate (INS-03, latent)'],
  ['insuredPersonName', C, 'aie_field_candidate (INS-03, latent)'],
  ['beneficiaryName', C, 'aie_field_candidate (INS-03, latent)'],
  ['exclusionsText', C, 'aie_field_candidate (INS-03, latent)'],
  ['excessAmount', C, 'aie_field_candidate (INS-03, latent)'],
  ['printedAnnualPremiumTotal', C, 'reconciliation cross-check'],
  ['multiComponentPolicyDetected', E, 'blocks acceptance'],
  ['unreadablePrintedFactCount', E, 'blocks acceptance'],
  ['unreadablePrintedFactEvidence', E, 'blocks acceptance'],
];

export type UploadFlowStatus = 'not_active' | 'active';

/** AIE intake routes with no user flow. Flip to 'active' only together with
 * the registry entries and the matrix (INS-00). */
export const INACTIVE_UPLOAD_FLOWS: readonly { route: string; status: UploadFlowStatus; note: string }[] = [
  { route: '/api/aie/insurance/intake', status: 'not_active', note: 'Insurance adapter: flags unset, no UI caller' },
  { route: '/api/aie/intake', status: 'not_active', note: 'Generic AIE intake: diagnostic only, Apply structurally refused' },
  { route: '/api/aie/fdh-bank/intake', status: 'not_active', note: 'AIE FDH-bank adapter: AIE_FDH_BANK_ADAPTER_ENABLED off, no UI' },
  { route: '/api/aie/investment-intelligence/intake', status: 'not_active', note: 'AIE II adapter: 2-email API pilot, canonical write flag off, no UI' },
];

export const insuranceRegistry: RegistryFile = {
  id: 'insurance',
  ownerWp: 'WP-14',
  OPEN_GAP_CEILING: 0,
  entries: [
    ...rows('insurance', 'field_list', 'aie:insurance/types.ts#CANONICAL_INSURANCE_FIELD_NAMES', CANONICAL, { notActive: true }),
    ...rows('insurance', 'field_list', 'aie:insurance/types.ts#EVIDENCE_ONLY_INSURANCE_FIELD_NAMES', EVIDENCE, { notActive: true }),
  ],
};
