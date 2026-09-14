import { describe, it, expect } from 'vitest';
import { mergeCandidatesWithCorrections } from '@/lib/aie/review/candidateMerge';
import type { AieFieldCandidate } from '@/lib/aie/types';
import type { LatestCorrectionRow } from '@/lib/aie/db/repository';

describe('AIE-1.5 candidateMerge.ts (VALID-09/12: never mutate the original, keep fact vs. assertion distinguishable)', () => {
  const original: AieFieldCandidate[] = [
    { fieldName: 'currencyCode', valueRaw: 'ZZZ', isNull: false, sourceMethod: 'deterministic' },
    { fieldName: 'policyName', valueRaw: 'Acme Life', isNull: false, sourceMethod: 'deterministic' },
  ];

  it('overrides a field with its latest correction without touching the original array', () => {
    const corrections: LatestCorrectionRow[] = [{ fieldName: 'currencyCode', valueNormalized: 'AUD', valueRaw: 'aud', decisionId: 'd1', actorId: 'u1' }];
    const merged = mergeCandidatesWithCorrections(original, corrections);

    expect(merged.find((c) => c.fieldName === 'currencyCode')?.valueRaw).toBe('AUD');
    // The original, untouched array is unaffected (VALID-12).
    expect(original.find((c) => c.fieldName === 'currencyCode')?.valueRaw).toBe('ZZZ');
  });

  it('tags a corrected candidate with userCorrected + preserves the original value for display (TRI-05/VALID-09)', () => {
    const corrections: LatestCorrectionRow[] = [{ fieldName: 'currencyCode', valueNormalized: 'AUD', valueRaw: 'aud', decisionId: 'd1', actorId: 'u1' }];
    const merged = mergeCandidatesWithCorrections(original, corrections);
    const currency = merged.find((c) => c.fieldName === 'currencyCode');
    expect(currency?.sourceReference).toMatchObject({ userCorrected: true, correctionDecisionId: 'd1', originalValueRaw: 'ZZZ' });
  });

  it('leaves an uncorrected field byte-identical', () => {
    const merged = mergeCandidatesWithCorrections(original, []);
    expect(merged.find((c) => c.fieldName === 'policyName')).toEqual(original[1]);
  });

  it('a correction for a field with NO original candidate at all still participates (a required field the parser never found)', () => {
    const corrections: LatestCorrectionRow[] = [{ fieldName: 'premiumFrequency', valueNormalized: 'monthly', valueRaw: 'Monthly', decisionId: 'd2', actorId: 'u1' }];
    const merged = mergeCandidatesWithCorrections(original, corrections);
    const freq = merged.find((c) => c.fieldName === 'premiumFrequency');
    expect(freq).toBeDefined();
    expect(freq?.valueRaw).toBe('monthly');
    expect(freq?.isNull).toBe(false);
    expect(freq?.sourceReference).toMatchObject({ userCorrected: true, originalValueRaw: null });
  });
});
