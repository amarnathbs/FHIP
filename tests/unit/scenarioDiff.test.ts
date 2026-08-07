import { describe, it, expect } from 'vitest';
import { diffScenarioAssumptions, isScenarioConfigured, summarizeWhatChanged } from '@/lib/engines/forecast/scenarioDiff';
import type { ResolvedAssumptionSet } from '@/lib/engines/forecast/types';

function assumption(value: number): ResolvedAssumptionSet[string] {
  return { key: 'k', category: 'test', value, valueType: 'number', unit: null, sourceType: 'global_default', sourceReference: null };
}

describe('diffScenarioAssumptions', () => {
  it('returns no diffs for two identical assumption sets', () => {
    const base: ResolvedAssumptionSet = { equity: assumption(7.5), retirement_age: assumption(65) };
    const candidate: ResolvedAssumptionSet = { equity: assumption(7.5), retirement_age: assumption(65) };
    expect(diffScenarioAssumptions(base, candidate)).toEqual([]);
    expect(isScenarioConfigured(diffScenarioAssumptions(base, candidate))).toBe(false);
  });

  it('detects a changed value for a key present in both sets', () => {
    const base: ResolvedAssumptionSet = { equity: assumption(7.5) };
    const candidate: ResolvedAssumptionSet = { equity: assumption(5) };
    const diffs = diffScenarioAssumptions(base, candidate);
    expect(diffs).toEqual([{ key: 'equity', baseValue: 7.5, candidateValue: 5 }]);
    expect(isScenarioConfigured(diffs)).toBe(true);
  });

  it('detects a key present only in the candidate (a scenario-specific override)', () => {
    const base: ResolvedAssumptionSet = {};
    const candidate: ResolvedAssumptionSet = { equity: assumption(5) };
    const diffs = diffScenarioAssumptions(base, candidate);
    expect(diffs).toEqual([{ key: 'equity', baseValue: null, candidateValue: 5 }]);
  });

  it('sorts diffs alphabetically by key for stable output', () => {
    const base: ResolvedAssumptionSet = { cash: assumption(1), equity: assumption(1) };
    const candidate: ResolvedAssumptionSet = { cash: assumption(2), equity: assumption(2) };
    const diffs = diffScenarioAssumptions(base, candidate);
    expect(diffs.map((d) => d.key)).toEqual(['cash', 'equity']);
  });
});

describe('summarizeWhatChanged', () => {
  it('returns null when there is nothing to summarize', () => {
    expect(summarizeWhatChanged([])).toBeNull();
  });

  it('builds a plain-English summary using the default humanizer', () => {
    const summary = summarizeWhatChanged([{ key: 'retirement_age', baseValue: 65, candidateValue: 60 }]);
    expect(summary).toBe('retirement age: 65 → 60');
  });

  it('joins multiple diffs and handles a null (not-set) side', () => {
    const summary = summarizeWhatChanged([
      { key: 'equity', baseValue: 7.5, candidateValue: 5 },
      { key: 'cash', baseValue: null, candidateValue: 3.5 },
    ]);
    expect(summary).toBe('equity: 7.5 → 5; cash: not set → 3.5');
  });

  it('accepts a custom humanizer for the key label', () => {
    const summary = summarizeWhatChanged([{ key: 'equity', baseValue: 7.5, candidateValue: 5 }], (k) => `[${k}]`);
    expect(summary).toBe('[equity]: 7.5 → 5');
  });
});
