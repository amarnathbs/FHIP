// Deterministic rule matcher. The supplied 2143-row condition set is, in
// practice, a normalized restatement of 5 columns (forecast_category,
// recommendation_signal, forecast_status, variance_result, country_code),
// every row sharing condition_group=1 and logical_operator='AND' — i.e. a
// plain AND-chain across every condition for a code, evaluated in
// evaluation_order. Conditions are combined left-to-right using each
// condition's own logical_operator (defaulting to AND), so an admin adding a
// genuine OR case later is supported without changing this evaluator.
import type { ConditionOperator, EvaluationContext, RecommendationCondition, RecommendationWithConditions, RecommendationMatch, RecommendationMasterRow } from './types';

function getField(context: EvaluationContext, fieldName: string): string | number | boolean | null {
  return Object.prototype.hasOwnProperty.call(context, fieldName) ? context[fieldName] : null;
}

function parseComparisonValue(raw: string | null): unknown {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed; // plain string comparison values (the common case here)
  }
}

export function evaluateCondition(context: EvaluationContext, condition: Pick<RecommendationCondition, 'fieldName' | 'operator' | 'comparisonValue'>): boolean {
  const actual = getField(context, condition.fieldName);
  const op: ConditionOperator = condition.operator;

  if (op === 'is_null') return actual === null;
  if (op === 'is_not_null') return actual !== null;
  if (actual === null) return false;

  const expected = parseComparisonValue(condition.comparisonValue);

  switch (op) {
    case 'equals':
    case 'eq':
      return String(actual) === String(expected);
    case 'neq':
      return String(actual) !== String(expected);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual));
    case 'not_in':
      return Array.isArray(expected) && !expected.map(String).includes(String(actual));
    default:
      return false;
  }
}

export function recommendationMatches(context: EvaluationContext, conditions: RecommendationCondition[]): boolean {
  if (conditions.length === 0) return true;

  const ordered = [...conditions].sort((a, b) => a.evaluationOrder - b.evaluationOrder);
  let result = evaluateCondition(context, ordered[0]);
  for (let i = 1; i < ordered.length; i++) {
    const conditionResult = evaluateCondition(context, ordered[i]);
    result = ordered[i].logicalOperator?.toUpperCase() === 'OR' ? result || conditionResult : result && conditionResult;
  }
  return result;
}

// Renders {{placeholder}} tokens in a template using the same evaluation
// context plus any extra computed values passed in — so impact statements
// are built from real data, not static copy.
function renderTemplate(template: string | null, context: EvaluationContext): string | null {
  if (!template) return null;
  return template.replace(/\{\{(.*?)\}\}/g, (_match, name: string) => {
    const value = getField(context, name.trim());
    return value === null ? '—' : String(value);
  });
}

export function matchRecommendations(context: EvaluationContext, library: RecommendationWithConditions[]): RecommendationMatch[] {
  const matches: RecommendationMatch[] = [];
  for (const rec of library) {
    if (!rec.isActive) continue;
    if (!recommendationMatches(context, rec.conditions)) continue;
    const evaluatedImpactText = renderTemplate(rec.financialImpactTemplate, context);
    const evaluatedImpactValue = (() => {
      const m = evaluatedImpactText?.match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    })();
    matches.push({ recommendation: rec, evaluatedImpactText, evaluatedImpactValue });
  }
  return matches.sort((a, b) => b.recommendation.priorityScore - a.recommendation.priorityScore);
}

export function renderRecommendationTitle(rec: Pick<RecommendationMasterRow, 'actionTitleTemplate'>, context: EvaluationContext): string {
  return renderTemplate(rec.actionTitleTemplate, context) ?? rec.actionTitleTemplate;
}
