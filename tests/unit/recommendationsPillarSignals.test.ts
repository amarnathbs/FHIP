import { describe, it, expect } from 'vitest';
import { pillarSignalsFromComponents } from '@/lib/services/recommendationsData';
import type { ComponentResult } from '@/lib/engines/healthScore';

function component(overrides: Partial<ComponentResult>): ComponentResult {
  return {
    code: 'emergency_fund',
    label: 'Emergency Fund',
    rawScore: 50,
    weight: 0.1,
    weightedContribution: 5,
    statusBand: 'fair',
    dataCompleteness: 1,
    treatment: 'scored',
    explanation: '',
    currentValue: {},
    benchmarkValue: {},
    ...overrides,
  };
}

describe('pillarSignalsFromComponents', () => {
  it('emits one signal per scored component, carrying its pillar_code and score_band', () => {
    const components: ComponentResult[] = [
      component({ code: 'emergency_fund', statusBand: 'critical', rawScore: 12 }),
      component({ code: 'debt', label: 'Debt', statusBand: 'excellent', rawScore: 92 }),
    ];
    const signals = pillarSignalsFromComponents(components, 'AU');

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ pillar_code: 'emergency_fund', score_band: 'critical', pillar_score: 12, country_code: 'AU' });
    expect(signals[1]).toMatchObject({ pillar_code: 'debt', score_band: 'excellent', pillar_score: 92, country_code: 'AU' });
  });

  it('skips components that were not actually scored (not_applicable / missing_data)', () => {
    const components: ComponentResult[] = [
      component({ code: 'insurance', treatment: 'not_applicable', statusBand: 'unknown' }),
      component({ code: 'investment', treatment: 'missing_data', statusBand: 'unknown' }),
      component({ code: 'savings', treatment: 'scored', statusBand: 'good' }),
    ];
    const signals = pillarSignalsFromComponents(components, null);

    expect(signals).toHaveLength(1);
    expect(signals[0].pillar_code).toBe('savings');
  });

  it('passes through a null country_code untouched (no forced default)', () => {
    const signals = pillarSignalsFromComponents([component({})], null);
    expect(signals[0].country_code).toBeNull();
  });

  it('returns an empty array when there are no components at all', () => {
    expect(pillarSignalsFromComponents([], 'IN')).toEqual([]);
  });
});
