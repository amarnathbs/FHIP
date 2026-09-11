// G7 Contract 6 (docs/country-programme/g7-data-contracts.md, ownership
// G7.040) — direct unit-test coverage of lib/engines/recommendations/
// matcher.ts's country-conditional branch, a confirmed zero-coverage gap
// discovery found (the matcher's own logic was already correct — this
// closes the coverage gap, it does not change matcher.ts itself).
import { describe, it, expect } from 'vitest';
import { recommendationMatches } from '@/lib/engines/recommendations/matcher';
import type { RecommendationCondition, EvaluationContext } from '@/lib/engines/recommendations/types';

// A single AU-scoped condition, matching the real shape
// action_recommendation_conditions rows use for country_code (see
// matcher.ts's own header comment: a plain AND-chain across
// forecast_category/recommendation_signal/forecast_status/variance_result/
// country_code, one condition_group, evaluation_order-ordered). Only the
// country_code condition is relevant here — the others are omitted since
// recommendationMatches() ANDs whatever conditions it's given regardless of
// which fields they name.
function auScopedCondition(): RecommendationCondition {
  return {
    id: 'cond-au-1',
    conditionGroup: 1,
    fieldName: 'country_code',
    operator: 'eq',
    comparisonValue: 'AU',
    logicalOperator: 'AND',
    evaluationOrder: 1,
  };
}

describe('recommendationMatches — country-conditional branch (G7 Contract 6)', () => {
  it('positive: an AU-scoped rule fires for an AU household', () => {
    const context: EvaluationContext = { country_code: 'AU' };
    expect(recommendationMatches(context, [auScopedCondition()])).toBe(true);
  });

  it('negative: the same AU-scoped rule does NOT fire for an IN household', () => {
    const context: EvaluationContext = { country_code: 'IN' };
    expect(recommendationMatches(context, [auScopedCondition()])).toBe(false);
  });

  it('negative: the same AU-scoped rule does NOT fire for a null/unresolved country_of_residence', () => {
    const context: EvaluationContext = { country_code: null };
    expect(recommendationMatches(context, [auScopedCondition()])).toBe(false);
  });

  it('a country condition combines with other AND-chained conditions correctly, not evaluated in isolation', () => {
    const conditions: RecommendationCondition[] = [
      auScopedCondition(),
      { id: 'cond-au-2', conditionGroup: 1, fieldName: 'forecast_category', operator: 'eq', comparisonValue: 'debt', logicalOperator: 'AND', evaluationOrder: 2 },
    ];
    // Right country, wrong category -> no match (AND semantics).
    expect(recommendationMatches({ country_code: 'AU', forecast_category: 'goal' }, conditions)).toBe(false);
    // Right country AND right category -> match.
    expect(recommendationMatches({ country_code: 'AU', forecast_category: 'debt' }, conditions)).toBe(true);
    // Right category, wrong country -> no match.
    expect(recommendationMatches({ country_code: 'IN', forecast_category: 'debt' }, conditions)).toBe(false);
  });
});
