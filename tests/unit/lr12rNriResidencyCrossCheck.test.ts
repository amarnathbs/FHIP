// G6 Contract 9 (docs/country-programme/g6-data-contracts.md) —
// resolveResidencyProfileForTaxReport() in
// lib/services/investmentIntelligenceReportData.ts. Extracted as a pure
// function specifically so this cross-check can be tested directly against
// the real logic, without mocking the full loadTaxForReport() pipeline
// (dataset loaders, tax profile repository, orchestrator).
import { describe, it, expect } from 'vitest';
import { resolveResidencyProfileForTaxReport } from '@/lib/services/investmentIntelligenceReportData';
import { checkResidency } from '@/lib/engines/investment-intelligence/tax/residency';

describe('G6 Contract 9 — NRI-disclaimer / country_of_residence cross-check', () => {
  it('self-declared NON_RESIDENT_INDIVIDUAL is always NRI, regardless of country_of_residence', () => {
    expect(resolveResidencyProfileForTaxReport('NON_RESIDENT_INDIVIDUAL', 'IN')).toEqual({ residencyStatus: 'nri' });
    expect(resolveResidencyProfileForTaxReport('NON_RESIDENT_INDIVIDUAL', null)).toEqual({ residencyStatus: 'nri' });
  });

  it('self-declared RESIDENT_INDIVIDUAL/RESIDENT_HUF is trusted when country_of_residence agrees (IN)', () => {
    expect(resolveResidencyProfileForTaxReport('RESIDENT_INDIVIDUAL', 'IN')).toEqual({ residencyStatus: 'resident' });
    expect(resolveResidencyProfileForTaxReport('RESIDENT_HUF', 'IN')).toEqual({ residencyStatus: 'resident' });
  });

  it('THE DEFECT THIS CONTRACT FIXES: self-declared resident but country_of_residence is not IN — no longer blindly trusted', () => {
    const profile = resolveResidencyProfileForTaxReport('RESIDENT_INDIVIDUAL', 'AU');
    expect(profile).toEqual({ countryOfTaxResidence: 'AU' });
    // And the existing checkResidency() fallback genuinely flags NRI rules
    // for this profile — proving the cross-check has a real effect on the
    // final disclaimer, not just on this function's own return shape.
    const result = checkResidency(profile);
    expect(result.nriRulesMayApply).toBe(true);
    expect(result.status).toBe('nri');
    expect(result.note).toMatch(/AU.*not India/i);
  });

  it('missing/unresolved country_of_residence never overrides a self-declared resident (never assume on missing data)', () => {
    expect(resolveResidencyProfileForTaxReport('RESIDENT_INDIVIDUAL', null)).toEqual({ residencyStatus: 'resident' });
  });

  it('no self-declared taxpayerType (null/undefined) defers entirely to checkResidency()\'s own unknown/fail-safe branch', () => {
    expect(resolveResidencyProfileForTaxReport(null, 'IN')).toEqual({});
    expect(resolveResidencyProfileForTaxReport(undefined, 'AU')).toEqual({});
    expect(checkResidency({}).nriRulesMayApply).toBe(true);
  });
});
