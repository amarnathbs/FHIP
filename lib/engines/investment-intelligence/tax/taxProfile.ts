// Investment Intelligence R6-FINAL — explicit tax-profile input surface
// (spec Sections 20-22).
//
// EXPLICIT-ONLY RULE: `taxpayerType` / `taxResidencyStatus` are NEVER
// inferred from nationality, browser locale, address, portfolio country, or
// household currency — they exist only if a user (or, in a caller passing an
// override, a test harness standing in for one) deliberately supplied them.
// Absence of both fields is a real, valid, common state ("no tax profile
// declared yet") and resolves to UNKNOWN, exactly mirroring residency.ts's
// own fail-safe convention — never silently defaulted to
// RESIDENT_INDIVIDUAL.
//
// TAXPAYER-TYPE SCOPE: this module does NOT change any computed rupee
// figure. Sections 111A/112A (equity-oriented-fund STCG/LTCG, the ONLY rates
// this engine actually applies as a number) apply identically to
// RESIDENT_INDIVIDUAL and RESIDENT_HUF under Indian law — there is no
// individual-vs-HUF branch to build for that specific computation, so
// building one would be inventing a distinction that does not exist rather
// than filling a real gap. Where individual/HUF genuinely DO differ (slab-
// rate taxation of debt/specified-fund gains, Finance Act 2023) this engine
// already does not compute an actual slab-rate rupee tax figure for ANY
// taxpayer type (capitalGainsEngine.ts's debt_specified branch returns the
// GAIN only, flagged "taxed at slab rate", never a computed tax amount) — so
// there is nothing to get wrong for HUF specifically. Both facts are stated
// explicitly in `taxpayerTypeNote` rather than left implicit, per the
// "controlled status, not a guess" instruction.
//
// NRI / DTAA SCOPE: for NON_RESIDENT_INDIVIDUAL, Sections 111A/112A rates
// ALSO apply identically to residents and non-residents for equity/
// equity-oriented-fund disposals under Indian domestic law (TDS mechanics
// differ, the computed gain/rate do not) — so this engine can and does
// produce a genuine INDIA-DOMESTIC-LAW figure for an NRI. What it explicitly
// does NOT do is evaluate any Double Taxation Avoidance Agreement (DTAA)
// that might reduce or eliminate that Indian tax liability for a treaty-
// country resident — no treaty benefit is ever fabricated. The result is
// labelled `estimateBasis: 'INDIA_DOMESTIC_LAW_ESTIMATE'` with
// `dtaaEvaluated: false` and an explicit `DTAA_NOT_EVALUATED` note.

export type TaxpayerType = 'RESIDENT_INDIVIDUAL' | 'RESIDENT_HUF' | 'NON_RESIDENT_INDIVIDUAL';
export type TaxResidencyStatus = 'RESIDENT' | 'NON_RESIDENT' | 'UNKNOWN';
export type TaxEstimateBasis = 'RESIDENT_STANDARD' | 'INDIA_DOMESTIC_LAW_ESTIMATE' | 'UNKNOWN_PROFILE';

export interface TaxProfileInput {
  taxpayerType?: TaxpayerType | null;
  taxResidencyStatus?: TaxResidencyStatus | null;
  taxYear?: string | null; // e.g. "2025-26" — informational/filtering only, not used in any rate lookup (rule version is resolved by disposal date, never by this field)
}

export interface TaxpayerContextResult {
  taxpayerType: TaxpayerType | 'UNKNOWN';
  residencyStatus: TaxResidencyStatus;
  estimateBasis: TaxEstimateBasis;
  dtaaEvaluated: boolean;
  profileComplete: boolean;
  taxpayerTypeNote: string;
}

const VALID_TAXPAYER_TYPES: readonly TaxpayerType[] = ['RESIDENT_INDIVIDUAL', 'RESIDENT_HUF', 'NON_RESIDENT_INDIVIDUAL'];

const HUF_NOTE =
  'Sections 111A/112A (equity-oriented mutual fund STCG/LTCG) apply identically to individuals and HUFs under Indian law — this simulation is unaffected by HUF status. ' +
  'Slab-rate taxation of debt/specified-fund gains (Finance Act 2023) — where individual and HUF slab structures can differ — is flagged ("taxed at slab rate") but this engine does not compute an actual slab-rate rupee tax figure for ANY taxpayer type, so there is no HUF-specific gap in what is actually calculated.';

const INDIVIDUAL_NOTE = 'Resident individual — standard Section 111A/112A treatment.';

const NRI_NOTE =
  'INDIA_DOMESTIC_LAW_ESTIMATE: Sections 111A/112A rates apply identically to residents and non-residents for equity/equity-oriented-fund disposals under Indian domestic law, so this figure reflects genuine Indian domestic-law tax treatment. ' +
  'DTAA_NOT_EVALUATED: any Double Taxation Avoidance Agreement between India and your country of tax residence that might reduce or eliminate this liability is NOT evaluated by this engine — consult a tax professional for treaty relief. Differential TDS (Section 195) is also not modelled.';

const UNKNOWN_NOTE = 'No explicit tax profile has been provided (taxpayer type / residency status). Residency-dependent treatment cannot be confirmed — flagged as unknown rather than assumed resident.';

/**
 * Resolve the taxpayer/residency context from an EXPLICIT profile input
 * only. Pure function, no I/O, no inference from any other field.
 */
export function resolveTaxpayerContext(input: TaxProfileInput): TaxpayerContextResult {
  const taxpayerType = input.taxpayerType && VALID_TAXPAYER_TYPES.includes(input.taxpayerType) ? input.taxpayerType : null;

  if (!taxpayerType && (!input.taxResidencyStatus || input.taxResidencyStatus === 'UNKNOWN')) {
    return {
      taxpayerType: 'UNKNOWN',
      residencyStatus: 'UNKNOWN',
      estimateBasis: 'UNKNOWN_PROFILE',
      dtaaEvaluated: false,
      profileComplete: false,
      taxpayerTypeNote: UNKNOWN_NOTE,
    };
  }

  if (taxpayerType === 'NON_RESIDENT_INDIVIDUAL' || input.taxResidencyStatus === 'NON_RESIDENT') {
    return {
      taxpayerType: taxpayerType ?? 'NON_RESIDENT_INDIVIDUAL',
      residencyStatus: 'NON_RESIDENT',
      estimateBasis: 'INDIA_DOMESTIC_LAW_ESTIMATE',
      dtaaEvaluated: false,
      profileComplete: taxpayerType !== null,
      taxpayerTypeNote: NRI_NOTE,
    };
  }

  if (taxpayerType === 'RESIDENT_HUF') {
    return {
      taxpayerType: 'RESIDENT_HUF',
      residencyStatus: 'RESIDENT',
      estimateBasis: 'RESIDENT_STANDARD',
      dtaaEvaluated: true, // n/a for a resident — no treaty question arises
      profileComplete: true,
      taxpayerTypeNote: HUF_NOTE,
    };
  }

  if (taxpayerType === 'RESIDENT_INDIVIDUAL' || input.taxResidencyStatus === 'RESIDENT') {
    return {
      taxpayerType: taxpayerType ?? 'RESIDENT_INDIVIDUAL',
      residencyStatus: 'RESIDENT',
      estimateBasis: 'RESIDENT_STANDARD',
      dtaaEvaluated: true,
      profileComplete: taxpayerType !== null,
      taxpayerTypeNote: INDIVIDUAL_NOTE,
    };
  }

  // Defensive fallback — should be unreachable given the branches above, but
  // fails safe to unknown rather than guessing resident-individual.
  return {
    taxpayerType: 'UNKNOWN',
    residencyStatus: 'UNKNOWN',
    estimateBasis: 'UNKNOWN_PROFILE',
    dtaaEvaluated: false,
    profileComplete: false,
    taxpayerTypeNote: UNKNOWN_NOTE,
  };
}
