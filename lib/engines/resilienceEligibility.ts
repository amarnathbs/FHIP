// Phase 0C.1 §24-27: minimal presentation-state layer for Financial
// Resilience, closing the same class of gap Phase 0C fixed for the Health
// Score — the Resilience gauge always rendered a number even when almost
// nothing was actually known, presenting a low-data result with the same
// visual authority as a fully-informed one.
//
// Deliberately thin: no new Resilience methodology, no new formulas, no
// change to component weights/bands/risk-override caps. This only answers
// "how much of the Resilience picture is actually known" from the
// component treatments computeResilience() already produces.
import type { ResilienceComponentResult } from './resilience';

export type ResilienceState = 'not_yet_available' | 'preliminary' | 'full';

export interface ResilienceEligibility {
  state: ResilienceState;
  scoredComponents: number;
  totalComponents: number;
  canDisplayNumericScore: boolean;
  missingComponentLabels: string[];
}

// Resilience has no 'not_applicable' treatment today (unlike the Health
// Score's Investments/Retirement) — every component is either 'scored' or
// 'missing_data' (see resilience.ts). Fewer than this many scored
// components means too little of the picture is known to show any number
// at all — chosen to match the Health Score's own conservative-minimum
// spirit (more than a single component, since e.g. Emergency Fund alone
// scoring wouldn't say much about "resilience" as a whole).
const MINIMUM_SCORED_FOR_PRELIMINARY = 2;

export function computeResilienceEligibility(components: ResilienceComponentResult[]): ResilienceEligibility {
  const scored = components.filter((c) => c.treatment === 'scored');
  const missing = components.filter((c) => c.treatment !== 'scored');

  const totalComponents = components.length;
  const scoredComponents = scored.length;
  const isComplete = missing.length === 0;

  const state: ResilienceState = isComplete
    ? 'full'
    : scoredComponents >= MINIMUM_SCORED_FOR_PRELIMINARY
      ? 'preliminary'
      : 'not_yet_available';

  return {
    state,
    scoredComponents,
    totalComponents,
    canDisplayNumericScore: state !== 'not_yet_available',
    missingComponentLabels: missing.map((c) => c.label),
  };
}
