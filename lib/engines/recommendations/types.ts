// Shared types for the Recommendations Engine (Module 10, Phase 8). Pure data
// shapes only — no Supabase/IO here, matching the engines/ vs services/
// split used by every other module. Field names mirror the user-supplied
// recommendation library's own CSV schema (forecast_category, sub_category,
// forecast_status, variance_result, recommendation_signal) rather than an
// invented vocabulary, so admin CSV uploads map onto these types directly.

export type ForecastCategory = 'net_worth' | 'retirement' | 'goal' | 'debt' | 'investment_growth' | 'cross_border' | 'resilience' | 'data_quality';

export type ForecastStatus = 'ahead_of_plan' | 'on_track' | 'slightly_behind' | 'at_risk' | 'significantly_off_track' | 'review_required';

export type VarianceResultValue = 'favourable' | 'unfavourable' | 'neutral';

export type ConditionOperator = 'equals' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'is_null' | 'is_not_null';

export interface RecommendationCondition {
  id: string;
  conditionGroup: number;
  fieldName: string;
  operator: ConditionOperator;
  comparisonValue: string | null;
  logicalOperator: string;
  evaluationOrder: number;
}

export interface RecommendationMasterRow {
  id: string;
  recommendationCode: string;
  forecastCategory: ForecastCategory;
  subCategory: string;
  scenarioName: string;
  scenarioDescription: string | null;
  varianceResult: VarianceResultValue | null;
  forecastStatus: ForecastStatus;
  severity: 'low' | 'medium' | 'high' | 'critical';
  actionType: string;
  actionTitleTemplate: string;
  actionContentTemplate: string;
  financialImpactTemplate: string | null;
  calculationMethodCode: string | null;
  priorityScore: number;
  countryCode: string | null;
  currencyCode: string | null;
  isPremium: boolean;
  isActive: boolean;
  includeInForecasting: boolean;
  includeInMonthlyReport: boolean;
}

export interface RecommendationWithConditions extends RecommendationMasterRow {
  conditions: RecommendationCondition[];
}

// A flat, scalar-valued evaluation context — every field a condition's
// field_name can address. One context represents ONE detected signal for
// ONE category (e.g. forecast_category=debt, recommendation_signal=
// overall_variance, forecast_status=at_risk, variance_result=unfavourable) —
// a user generates several of these per evaluation run, one per category
// (and potentially more than one per category, for categories with more
// than one detected signal).
export type EvaluationContext = Record<string, string | number | boolean | null>;

export interface RecommendationMatch {
  recommendation: RecommendationMasterRow;
  evaluatedImpactText: string | null;
  evaluatedImpactValue: number | null;
}
