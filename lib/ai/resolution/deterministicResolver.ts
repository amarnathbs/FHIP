// Module 11.2 — DeterministicAnswerResolver (spec sections 12-20).
//
// Retrieves an EXISTING certified value out of a FinancialContextObject.
// Never recomputes a financial value itself (spec section 13: "engines
// calculate; explanation layer explains") — every extractor below is a pure
// field read (plus, for the three goal-count intents, a count/filter over
// already-certified per-goal `track_status` values, which is counting, not
// recalculating a financial figure).
//
// CERTIFICATION (spec section 19): CERTIFIED/PARTIAL/STALE may answer (STALE
// with a disclosed limitation, PARTIAL only if the specific field is
// present); INVALID/UNAVAILABLE never answer with a personalised value.
//
// ZERO vs MISSING (spec section 18): a domain that IS usable but whose
// specific field extracts to `null` is MISSING, not zero — this resolver
// never coerces a missing extraction to 0/"" to produce an answer.

import type { ContextDomain, FinancialContextObject } from '@/lib/ai/context/types';
import type { SourceReference } from '@/lib/ai/context/types';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import { METRIC_TEMPLATES, TEMPLATE_REGISTRY_VERSION, formatMetricValue, renderMetricHeadline, type MetricTemplateConfig } from '@/lib/ai/resolution/templates';
import type { ResolvedAnswerEnvelope, ResolverAttempt } from '@/lib/ai/resolution/types';

interface Extraction {
  value: unknown;
  dataAsOf: string | null;
  sourceRefs: SourceReference[];
}

type Extractor = (ctx: FinancialContextObject) => Extraction | null;

function ref(source_type: SourceReference['source_type'], source_id: string, model_version: string | null, data_as_of: string | null): SourceReference {
  return { source_type, source_id, model_version, data_as_of };
}

const ON_TRACK_STATUSES = new Set(['on_track', 'ahead_of_track']);
const AT_RISK_STATUSES = new Set(['at_risk', 'off_track']);

const EXTRACTORS: Record<string, Extractor> = {
  CURRENT_NET_WORTH: (ctx) => (ctx.balance_sheet ? { value: ctx.balance_sheet.net_worth, dataAsOf: ctx.balance_sheet.data_as_of, sourceRefs: [ref('dashboard_metric', 'net_worth', ctx.balance_sheet.calculation_version, ctx.balance_sheet.data_as_of)] } : null),
  TOTAL_ASSETS: (ctx) => (ctx.balance_sheet ? { value: ctx.balance_sheet.total_assets, dataAsOf: ctx.balance_sheet.data_as_of, sourceRefs: [ref('dashboard_metric', 'total_assets', ctx.balance_sheet.calculation_version, ctx.balance_sheet.data_as_of)] } : null),
  TOTAL_LIABILITIES: (ctx) => (ctx.balance_sheet ? { value: ctx.balance_sheet.total_liabilities, dataAsOf: ctx.balance_sheet.data_as_of, sourceRefs: [ref('dashboard_metric', 'total_liabilities', ctx.balance_sheet.calculation_version, ctx.balance_sheet.data_as_of)] } : null),
  LIQUID_ASSETS: (ctx) => (ctx.balance_sheet ? { value: ctx.balance_sheet.liquid_assets, dataAsOf: ctx.balance_sheet.data_as_of, sourceRefs: [ref('dashboard_metric', 'liquid_assets', ctx.balance_sheet.calculation_version, ctx.balance_sheet.data_as_of)] } : null),
  MONTHLY_GROSS_INCOME: (ctx) => (ctx.cash_flow ? { value: ctx.cash_flow.monthly_gross_income, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'monthly_gross_income', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  MONTHLY_NET_INCOME: (ctx) => (ctx.cash_flow ? { value: ctx.cash_flow.monthly_net_income, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'monthly_net_income', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  MONTHLY_EXPENSES: (ctx) => (ctx.cash_flow ? { value: ctx.cash_flow.monthly_expenses, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'monthly_expenses', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  ESSENTIAL_EXPENSES: (ctx) => (ctx.cash_flow ? { value: ctx.cash_flow.essential_monthly_expenses, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'essential_monthly_expenses', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  MONTHLY_SURPLUS: (ctx) => (ctx.cash_flow ? { value: ctx.cash_flow.monthly_surplus_or_deficit, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'monthly_surplus', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  SAVINGS_RATE: (ctx) => (ctx.cash_flow && ctx.cash_flow.savings_rate !== null ? { value: ctx.cash_flow.savings_rate, dataAsOf: ctx.cash_flow.data_as_of, sourceRefs: [ref('dashboard_metric', 'savings_rate', ctx.cash_flow.calculation_version, ctx.cash_flow.data_as_of)] } : null),
  FINANCIAL_HEALTH_SCORE: (ctx) => (ctx.health_score ? { value: ctx.health_score.overall_score, dataAsOf: ctx.health_score.calculation_date, sourceRefs: [ref('health_score', 'overall_score', ctx.health_score.model_version, ctx.health_score.calculation_date)] } : null),
  FINANCIAL_HEALTH_BAND: (ctx) => (ctx.health_score ? { value: ctx.health_score.score_band, dataAsOf: ctx.health_score.calculation_date, sourceRefs: [ref('health_score', 'score_band', ctx.health_score.model_version, ctx.health_score.calculation_date)] } : null),
  DNA_PRIMARY_PROFILE: (ctx) => (ctx.financial_dna?.primary_profile ? { value: ctx.financial_dna.primary_profile, dataAsOf: ctx.financial_dna.classification_date, sourceRefs: [ref('financial_dna', 'primary_profile', ctx.financial_dna.model_version, ctx.financial_dna.classification_date)] } : null),
  DNA_SECONDARY_PROFILE: (ctx) => (ctx.financial_dna?.secondary_profile ? { value: ctx.financial_dna.secondary_profile, dataAsOf: ctx.financial_dna.classification_date, sourceRefs: [ref('financial_dna', 'secondary_profile', ctx.financial_dna.model_version, ctx.financial_dna.classification_date)] } : null),
  RESILIENCE_STATUS: (ctx) => (ctx.resilience ? { value: ctx.resilience.resilience_status, dataAsOf: null, sourceRefs: [ref('resilience', 'resilience_status', ctx.resilience.model_version, null)] } : null),
  RESILIENCE_SCORE: (ctx) => (ctx.resilience ? { value: ctx.resilience.resilience_score, dataAsOf: null, sourceRefs: [ref('resilience', 'resilience_score', ctx.resilience.model_version, null)] } : null),
  EMERGENCY_FUND_MONTHS: (ctx) => (ctx.resilience && ctx.resilience.emergency_fund_months !== null ? { value: ctx.resilience.emergency_fund_months, dataAsOf: null, sourceRefs: [ref('resilience', 'emergency_fund_months', ctx.resilience.model_version, null)] } : null),
  INVESTMENT_TOTAL: (ctx) => (ctx.investments ? { value: ctx.investments.total_investment_value, dataAsOf: ctx.investments.data_as_of, sourceRefs: [ref('dashboard_metric', 'total_investment_value', ctx.investments.calculation_version, ctx.investments.data_as_of)] } : null),
  INVESTMENT_DIVERSIFICATION: (ctx) => (ctx.investments && ctx.investments.diversification_score !== null ? { value: ctx.investments.diversification_score, dataAsOf: ctx.investments.data_as_of, sourceRefs: [ref('dashboard_metric', 'diversification_score', ctx.investments.calculation_version, ctx.investments.data_as_of)] } : null),
  RETIREMENT_BALANCE: (ctx) => (ctx.retirement ? { value: ctx.retirement.retirement_balance, dataAsOf: ctx.retirement.data_as_of, sourceRefs: [ref('dashboard_metric', 'retirement_balance', ctx.retirement.calculation_version, ctx.retirement.data_as_of)] } : null),
  INSURANCE_DATA_STATUS: (ctx) => (ctx.insurance ? { value: ctx.insurance.data_status, dataAsOf: null, sourceRefs: [ref('dashboard_metric', 'insurance_data_status', null, null)] } : null),
  GOAL_COUNT: (ctx) => (ctx.domain_certification.goals.status !== 'UNAVAILABLE' && ctx.domain_certification.goals.status !== 'INVALID' ? { value: ctx.goals.length, dataAsOf: null, sourceRefs: ctx.goals.map((g) => ref('goal', g.goal_reference, g.calculation_version, null)) } : null),
  GOALS_ON_TRACK_COUNT: (ctx) => (ctx.domain_certification.goals.status !== 'UNAVAILABLE' && ctx.domain_certification.goals.status !== 'INVALID' ? { value: ctx.goals.filter((g) => g.track_status && ON_TRACK_STATUSES.has(g.track_status)).length, dataAsOf: null, sourceRefs: ctx.goals.map((g) => ref('goal', g.goal_reference, g.calculation_version, null)) } : null),
  GOALS_AT_RISK_COUNT: (ctx) => (ctx.domain_certification.goals.status !== 'UNAVAILABLE' && ctx.domain_certification.goals.status !== 'INVALID' ? { value: ctx.goals.filter((g) => g.track_status && AT_RISK_STATUSES.has(g.track_status)).length, dataAsOf: null, sourceRefs: ctx.goals.map((g) => ref('goal', g.goal_reference, g.calculation_version, null)) } : null),
  FORECAST_LATEST_RUN_DATE: (ctx) => (ctx.forecasts[0]?.calculation_date ? { value: ctx.forecasts[0].calculation_date, dataAsOf: ctx.forecasts[0].calculation_date, sourceRefs: [ref('retirement_forecast', 'base', ctx.forecasts[0].model_version, ctx.forecasts[0].calculation_date)] } : null),
  TWIN_COHORT: (ctx) => (ctx.financial_twin?.peer_cohort_description ? { value: ctx.financial_twin.peer_cohort_description, dataAsOf: null, sourceRefs: [ref('financial_twin', 'peer_cohort_description', null, null)] } : null),
  TWIN_CONFIDENCE: (ctx) => (ctx.financial_twin?.benchmark_confidence !== null && ctx.financial_twin?.benchmark_confidence !== undefined ? { value: ctx.financial_twin.benchmark_confidence, dataAsOf: null, sourceRefs: [ref('financial_twin', 'benchmark_confidence', null, null)] } : null),
  REPORT_PERIOD: (ctx) => (ctx.reports[0]?.reporting_period ? { value: ctx.reports[0].reporting_period, dataAsOf: ctx.reports[0].data_as_of, sourceRefs: [ref('report', ctx.reports[0].report_id, ctx.reports[0].template_version, ctx.reports[0].data_as_of)] } : null),
  REPORT_VERSION: (ctx) => (ctx.reports[0]?.report_version ? { value: ctx.reports[0].report_version, dataAsOf: ctx.reports[0].data_as_of, sourceRefs: [ref('report', ctx.reports[0].report_id, ctx.reports[0].template_version, ctx.reports[0].data_as_of)] } : null),
  COUNTRIES_PRESENT: (ctx) => (ctx.cross_border ? { value: ctx.cross_border.countries_present, dataAsOf: null, sourceRefs: [ref('dashboard_metric', 'countries_present', null, null)] } : null),
  CURRENCIES_PRESENT: (ctx) => (ctx.cross_border ? { value: ctx.cross_border.currencies_present, dataAsOf: null, sourceRefs: [ref('dashboard_metric', 'currencies_present', null, null)] } : null),
  REPORTING_CURRENCY: (ctx) => ({ value: ctx.meta.reporting_currency, dataAsOf: null, sourceRefs: [] }),
  SNAPSHOT_DATE: (ctx) => (ctx.meta.data_as_of ? { value: ctx.meta.data_as_of, dataAsOf: ctx.meta.data_as_of, sourceRefs: [] } : null),
  DATA_COMPLETENESS: (ctx) => ({ value: ctx.data_quality.complete_domains, dataAsOf: null, sourceRefs: [] }),
  STALE_DATA_AREAS: (ctx) => ({ value: ctx.data_quality.stale_fields, dataAsOf: null, sourceRefs: [] }),
};

/**
 * WHY-explanation intents (spec sections 34-38): answerable ONLY when the
 * relevant engine's own certified payload supplies structured drivers. Today
 * `health_score.principal_drivers` / `financial_dna.driver_metrics` /
 * `resilience.active_risks` are the only such driver sets in the certified
 * context object, and none of them constitute an actual CAUSAL explanation
 * of a specific number/movement — they name which pillar/metric is
 * currently weakest, not why it changed. Per spec section 36 ("if they do
 * not expose causal drivers... LIVE_AI_REQUIRED"), these therefore always
 * miss today rather than fabricate a causal narrative from a driver list
 * (spec section 106's "generic-fallback anti-test").
 */
const WHY_EXTRACTORS: Record<string, Extractor> = {
  SCORE_EXPLANATION: () => null,
  DNA_EXPLANATION: () => null,
  RESILIENCE_EXPLANATION: () => null,
};

function domainsUsable(ctx: FinancialContextObject, domains: ContextDomain[]): { usable: boolean; certState: string; staleDomains: ContextDomain[] } {
  if (domains.length === 0) {
    // Meta-level intents still fail closed on a whole-context DB outage.
    return { usable: ctx.meta.certification_status !== 'INVALID', certState: ctx.meta.certification_status, staleDomains: [] };
  }
  const staleDomains: ContextDomain[] = [];
  for (const d of domains) {
    const status = ctx.domain_certification[d].status;
    if (status === 'INVALID' || status === 'UNAVAILABLE') return { usable: false, certState: status, staleDomains };
    if (status === 'STALE') staleDomains.push(d);
  }
  return { usable: true, certState: 'CERTIFIED', staleDomains };
}

function envelope(
  resolution_type: 'DETERMINISTIC',
  intentCode: string,
  config: MetricTemplateConfig,
  formattedValue: string,
  dataAsOf: string | null,
  sourceRefs: SourceReference[],
  limitations: string[]
): ResolvedAnswerEnvelope {
  return {
    resolution_type,
    intent_code: intentCode,
    answer_type: 'metric_answer',
    headline: renderMetricHeadline(config, formattedValue),
    summary: config.meaning,
    key_points: [],
    source_refs: sourceRefs,
    confidence: limitations.length > 0 ? 'MEDIUM' : 'HIGH',
    data_as_of: dataAsOf,
    limitations,
    related_module: config.related_module,
    action_route: config.action_route,
    requires_live_ai: false,
    consumes_custom_quota: false,
    template_version: `${TEMPLATE_REGISTRY_VERSION}/${config.template_code}@${config.template_version}`,
  };
}

export interface DeterministicResolveInput {
  intentCode: string;
  context: FinancialContextObject;
}

export function resolveDeterministic(input: DeterministicResolveInput): ResolverAttempt {
  const def = getIntentDefinition(input.intentCode);
  if (!def || !def.allowed_resolvers.includes('DETERMINISTIC')) {
    return { resolver: 'DETERMINISTIC', hit: false, answer: null, miss_reason: 'intent_not_deterministic' };
  }

  const config = METRIC_TEMPLATES[input.intentCode];
  const extractor = EXTRACTORS[input.intentCode] ?? WHY_EXTRACTORS[input.intentCode];
  if (!config || !extractor) {
    return { resolver: 'DETERMINISTIC', hit: false, answer: null, miss_reason: 'no_deterministic_extractor_registered' };
  }

  const { usable, certState, staleDomains } = domainsUsable(input.context, def.requires_certified_domain);
  if (!usable) {
    return { resolver: 'DETERMINISTIC', hit: false, answer: null, miss_reason: `certification_${certState.toLowerCase()}` };
  }

  const extraction = extractor(input.context);
  if (!extraction || extraction.value === null || extraction.value === undefined) {
    // Genuinely missing (certified domain usable, but this specific field has
    // no value) — spec section 18: this is MISSING, never coerced to zero.
    // An empty array (e.g. zero countries recorded) is a legitimate value,
    // not a miss — only a genuinely absent extraction reaches here.
    return { resolver: 'DETERMINISTIC', hit: false, answer: null, miss_reason: 'field_missing_despite_certification' };
  }

  const limitations: string[] = [];
  if (staleDomains.length > 0) limitations.push(`This answer is based on data FHIP currently considers stale for: ${staleDomains.join(', ')}.`);

  const formatted = formatMetricValue(config.format, extraction.value, input.context.meta.reporting_currency);
  const answer = envelope('DETERMINISTIC', input.intentCode, config, formatted, extraction.dataAsOf, extraction.sourceRefs, limitations);
  return { resolver: 'DETERMINISTIC', hit: true, answer, miss_reason: null };
}
