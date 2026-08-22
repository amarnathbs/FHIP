// Investment Intelligence R6-P1 — NRI/residency boundary detection.
//
// SCOPE: this release models resident-Indian taxpayer rules only. It does
// not implement NRI-specific TDS or DTAA/treaty logic. This module's job is
// narrow: detect (from existing household/profile data) or otherwise flag
// when NRI-specific rules might apply, so the orchestrator can attach
// NRI_SCOPE_DISCLAIMER instead of silently applying resident rules.

export type ResidencyStatus = 'resident' | 'nri' | 'unknown';

export interface ResidencyProfileInput {
  /** From the household/profile schema if available — the field name in
   * this engine's own vocabulary; callers adapt whatever the actual
   * household-profile column is named. */
  residencyStatus?: ResidencyStatus | null;
  /** Fallback heuristic input: country of current tax residence, if the
   * household profile tracks that instead of an explicit residency flag. */
  countryOfTaxResidence?: string | null;
}

export interface ResidencyCheckResult {
  status: ResidencyStatus;
  nriRulesMayApply: boolean;
  note: string;
}

export function checkResidency(input: ResidencyProfileInput): ResidencyCheckResult {
  if (input.residencyStatus === 'nri') {
    return { status: 'nri', nriRulesMayApply: true, note: 'Household profile explicitly marks this taxpayer as NRI.' };
  }
  if (input.residencyStatus === 'resident') {
    return { status: 'resident', nriRulesMayApply: false, note: 'Household profile explicitly marks this taxpayer as resident.' };
  }
  if (input.countryOfTaxResidence && input.countryOfTaxResidence !== 'IN') {
    return {
      status: 'nri',
      nriRulesMayApply: true,
      note: `Household's country of tax residence (${input.countryOfTaxResidence}) is not India — NRI rules may apply.`,
    };
  }
  return {
    status: 'unknown',
    nriRulesMayApply: true, // fail safe: unknown residency is flagged, never silently treated as resident
    note: 'No residency status available on the household profile — cannot confirm resident-taxpayer status. Flagged rather than assumed.',
  };
}
