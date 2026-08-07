// Forecasting P1 fix FHIP-FC-SCN-001/002. Custom scenarios are never
// auto-seeded with assumption overrides (deliberate — see
// forecastData.ts's ensureStandardScenarios comment), so nothing before this
// checked whether a scenario actually differs from Base; it would silently
// forecast identically with no warning. resolveAssumptions() already
// returns a keyed ResolvedAssumptionSet per scenario — this just diffs two
// of them key-by-key.
import type { ResolvedAssumptionSet } from './types';

export interface AssumptionDiff {
  key: string;
  baseValue: number | null;
  candidateValue: number | null;
}

export function diffScenarioAssumptions(base: ResolvedAssumptionSet, candidate: ResolvedAssumptionSet): AssumptionDiff[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  const diffs: AssumptionDiff[] = [];
  for (const key of keys) {
    const baseValue = base[key]?.value ?? null;
    const candidateValue = candidate[key]?.value ?? null;
    if (baseValue !== candidateValue) diffs.push({ key, baseValue, candidateValue });
  }
  return diffs.sort((a, b) => a.key.localeCompare(b.key));
}

export function isScenarioConfigured(diffs: AssumptionDiff[]): boolean {
  return diffs.length > 0;
}

// Plain-English "what changed" summary — e.g. "retirement age: 65 -> 60;
// equity: 7.5 -> 5". humanizeKey lets callers reuse whatever key-label
// convention they already have (e.g. AssumptionsTable.tsx's) rather than
// this module inventing a second one.
export function summarizeWhatChanged(diffs: AssumptionDiff[], humanizeKey: (key: string) => string = (k) => k.replace(/_/g, ' ')): string | null {
  if (diffs.length === 0) return null;
  return diffs
    .map((d) => {
      const base = d.baseValue === null ? 'not set' : String(d.baseValue);
      const candidate = d.candidateValue === null ? 'not set' : String(d.candidateValue);
      return `${humanizeKey(d.key)}: ${base} → ${candidate}`;
    })
    .join('; ');
}
