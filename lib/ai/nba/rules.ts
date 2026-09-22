// Module 11.6 — the deterministic rule set (brief sections 41-42, 45).
//
// EVERY trigger below consumes an ALREADY-CERTIFIED status or the SIGN of an
// already-certified metric. No rule introduces a numeric threshold of its
// own (brief section 41). The certified sources, by rule:
//
//   Resilience risk register  lib/engines/resilience.ts buildRiskRegister():
//     critical_liquidity, low_emergency_fund, income_concentration,
//     no_life_insurance, no_income_protection, variable_rate_exposure,
//     refinancing_exposure, high_credit_utilization, property_concentration
//     — each carries the engine's OWN severity, reused verbatim.
//   Resilience status band    migration 0008 scoreBands: highly_resilient,
//     resilient, moderately_vulnerable, vulnerable, fragile.
//   Score band                migration 0006 scoreBands: excellent, good,
//     fair, needs_attention, critical.
//   Score movement            health_score.score_movement (sign only).
//   Cash flow                 cash_flow.monthly_surplus_or_deficit (sign only).
//   Goal track status         goals[].track_status in {at_risk, off_track}
//     (the same set Module 11.4's SQ-AI-021 already consumes).
//   Insurance data state      insurance.data_status === 'missing'
//     (certified MISSING != confirmed none).
//   Data quality              data_quality.unavailable_modules /
//     stale_fields, domain_certification[*].status.
//   Cross-border              household.cross_border_indicator (G6 contract 10).
//
// RULES DELIBERATELY NOT IMPLEMENTED (brief section 42: "do not force
// unsupported rules") — no certified upstream status exists in the FCO for:
//   investment concentration (investments.institution_concentration is a
//     raw ratio with no certified band), retirement progress (no adequacy
//     status), forecast review (no certified staleness status on
//     forecasts[]). These are recorded in the R5 report as PO decisions.

import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { NbaActionCode, NbaCandidate, NbaEvidence, NbaSeverity } from '@/lib/ai/nba/types';

const CRITICAL_DOMAINS = ['cash_flow', 'balance_sheet'] as const;
const WEAK_SCORE_BANDS = new Set(['needs_attention', 'critical']);
const WEAK_RESILIENCE_BANDS = new Set(['vulnerable', 'fragile']);
const GOAL_RISK_STATUSES = new Set(['at_risk', 'off_track']);
const RISK_SEVERITIES: NbaSeverity[] = ['critical', 'high', 'medium', 'low'];

function severityOf(raw: string | undefined, fallback: NbaSeverity): NbaSeverity {
  return RISK_SEVERITIES.includes(raw as NbaSeverity) ? (raw as NbaSeverity) : fallback;
}

function money(ctx: FinancialContextObject, v: number | null | undefined): string {
  if (v === null || v === undefined) return 'not recorded';
  // Reporting currency only — never a conversion, never a cross-currency sum (FX integrity).
  const symbol = ctx.meta.reporting_currency === 'INR' ? '₹' : '$';
  const sign = v < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(Math.round(v)).toLocaleString('en-AU')} ${ctx.meta.reporting_currency}`;
}

function months(v: number | null | undefined): string {
  return v === null || v === undefined ? 'not recorded' : `${v.toFixed(1)} months`;
}

function risk(ctx: FinancialContextObject, code: string) {
  return ctx.resilience?.active_risks.find((r) => r.code === code) ?? null;
}

function retirementLabel(ctx: FinancialContextObject): string {
  return ctx.meta.country_of_residence === 'IN' ? 'retirement accounts (EPF / PPF / NPS)' : 'superannuation';
}

type Rule = (ctx: FinancialContextObject) => NbaCandidate | null;

const missingCriticalInformation: Rule = (ctx) => {
  const missing = CRITICAL_DOMAINS.filter((d) => ctx.data_quality.unavailable_modules.includes(d) || ctx.domain_certification[d]?.status === 'UNAVAILABLE' || ctx.domain_certification[d]?.status === 'INVALID');
  if (missing.length === 0) return null;
  return {
    action_code: 'MISSING_CRITICAL_INFORMATION', tier: 'DATA_QUALITY', severity: 'critical',
    title: 'Complete your core financial information',
    source_ref: `data_quality.unavailable_modules:${missing.join(',')}`,
    evidence: missing.map((d) => ({ label: `${d === 'cash_flow' ? 'Cash flow' : 'Balance sheet'} data`, value: 'unavailable or uncertified', source_path: `domain_certification.${d}.status` })),
    related_module: 'dashboard', action_route: '/dashboard',
    // Data-quality blocker: no financial conclusion is drawn on missing core data (brief section 45).
    suppresses: ['NEGATIVE_CASH_FLOW', 'LIQUIDITY_WEAKNESS', 'DEBT_PRESSURE', 'SCORE_WEAKNESS', 'SCORE_DETERIORATION', 'RESILIENCE_WEAKNESS', 'ASSET_CONCENTRATION'],
  };
};

const staleInformation: Rule = (ctx) => {
  const staleDomains = (Object.entries(ctx.domain_certification) as [string, { status: string } | undefined][]).filter(([, c]) => c?.status === 'STALE').map(([d]) => d);
  const staleFields = ctx.data_quality.stale_fields;
  if (staleDomains.length === 0 && staleFields.length === 0) return null;
  return {
    action_code: 'STALE_INFORMATION', tier: 'DATA_QUALITY', severity: 'medium',
    title: 'Refresh out-of-date information',
    source_ref: staleDomains.length > 0 ? `domain_certification:STALE:${staleDomains.join(',')}` : 'data_quality.stale_fields',
    evidence: [
      ...staleDomains.map((d) => ({ label: `${d} certification`, value: 'STALE', source_path: `domain_certification.${d}.status` })),
      ...staleFields.slice(0, 5).map((f) => ({ label: 'Stale field', value: f, source_path: 'data_quality.stale_fields' })),
    ],
    related_module: 'dashboard', action_route: '/dashboard', suppresses: [],
  };
};

const missingRetirementData: Rule = (ctx) => {
  const unavailable = ctx.data_quality.unavailable_modules.includes('retirement') || ctx.domain_certification.retirement?.status === 'UNAVAILABLE';
  if (!unavailable) return null;
  return {
    action_code: 'MISSING_RETIREMENT_DATA', tier: 'DATA_QUALITY', severity: 'medium',
    title: `Add your ${retirementLabel(ctx)}`,
    source_ref: 'domain_certification.retirement:UNAVAILABLE',
    evidence: [{ label: 'Retirement data', value: 'unavailable', source_path: 'domain_certification.retirement.status' }],
    related_module: 'retirement', action_route: '/retirement', suppresses: [],
  };
};

const missingInsuranceData: Rule = (ctx) => {
  if (!ctx.insurance || ctx.insurance.data_status !== 'missing') return null;
  return {
    action_code: 'MISSING_INSURANCE_DATA', tier: 'DATA_QUALITY', severity: 'medium',
    title: 'Record your insurance cover',
    source_ref: 'insurance.data_status:missing',
    evidence: [{ label: 'Insurance data', value: 'missing (not confirmed as none)', source_path: 'insurance.data_status' }],
    related_module: 'insurance', action_route: '/insurance',
    // Missing insurance data suppresses any protection-gap conclusion (missing != none).
    suppresses: ['INSURANCE_PROTECTION_GAP'],
  };
};

const negativeCashFlow: Rule = (ctx) => {
  const v = ctx.cash_flow?.monthly_surplus_or_deficit;
  if (v === null || v === undefined || !(v < 0)) return null;
  return {
    action_code: 'NEGATIVE_CASH_FLOW', tier: 'CASH_FLOW', severity: 'high',
    title: 'Address your monthly shortfall',
    source_ref: 'cash_flow.monthly_surplus_or_deficit:<0',
    evidence: [
      { label: 'Monthly surplus / deficit', value: money(ctx, v), source_path: 'cash_flow.monthly_surplus_or_deficit' },
      { label: 'Monthly net income', value: money(ctx, ctx.cash_flow?.monthly_net_income), source_path: 'cash_flow.monthly_net_income' },
      { label: 'Monthly expenses', value: money(ctx, ctx.cash_flow?.monthly_expenses), source_path: 'cash_flow.monthly_expenses' },
    ],
    related_module: 'expenses', action_route: '/expenses', suppresses: [],
  };
};

const liquidityWeakness: Rule = (ctx) => {
  const critical = risk(ctx, 'critical_liquidity');
  const low = risk(ctx, 'low_emergency_fund');
  const hit = critical ?? low;
  if (!hit) return null;
  return {
    action_code: 'LIQUIDITY_WEAKNESS', tier: 'LIQUIDITY', severity: severityOf(hit.severity, critical ? 'critical' : 'high'),
    title: critical ? 'Rebuild accessible cash urgently' : 'Build your emergency fund',
    source_ref: `resilience.active_risks:${hit.code}`,
    evidence: [
      { label: 'Resilience risk', value: hit.code, source_path: 'resilience.active_risks[].code' },
      { label: 'Emergency fund (months of essential expenses)', value: months(ctx.resilience?.emergency_fund_months), source_path: 'resilience.emergency_fund_months' },
      { label: 'Liquid assets', value: money(ctx, ctx.balance_sheet?.liquid_assets), source_path: 'balance_sheet.liquid_assets' },
    ],
    related_module: 'resilience', action_route: '/resilience', suppresses: ['RESILIENCE_WEAKNESS'],
  };
};

const debtPressure: Rule = (ctx) => {
  const hits = ['high_credit_utilization', 'refinancing_exposure', 'variable_rate_exposure'].map((c) => risk(ctx, c)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (hits.length === 0) return null;
  const top = [...hits].sort((a, b) => RISK_SEVERITIES.indexOf(severityOf(a.severity, 'low')) - RISK_SEVERITIES.indexOf(severityOf(b.severity, 'low')))[0];
  return {
    action_code: 'DEBT_PRESSURE', tier: 'DEBT', severity: severityOf(top.severity, 'medium'),
    title: 'Review your debt exposure',
    source_ref: `resilience.active_risks:${hits.map((h) => h.code).join(',')}`,
    evidence: [
      ...hits.map((h) => ({ label: 'Resilience debt risk', value: `${h.code} (${h.severity})`, source_path: 'resilience.active_risks[].code' })),
      { label: 'Debt pressure', value: ctx.resilience?.debt_pressure ?? 'not recorded', source_path: 'resilience.debt_pressure' },
      { label: 'Total liabilities', value: money(ctx, ctx.balance_sheet?.total_liabilities), source_path: 'balance_sheet.total_liabilities' },
    ],
    related_module: 'liabilities', action_route: '/liabilities', suppresses: ['RESILIENCE_WEAKNESS'],
  };
};

const insuranceProtectionGap: Rule = (ctx) => {
  const life = risk(ctx, 'no_life_insurance');
  const income = risk(ctx, 'no_income_protection');
  const hit = life ?? income;
  if (!hit) return null;
  return {
    action_code: 'INSURANCE_PROTECTION_GAP', tier: 'PROTECTION', severity: severityOf(hit.severity, life ? 'high' : 'medium'),
    title: life ? 'Review life insurance for your dependants' : 'Review income protection',
    source_ref: `resilience.active_risks:${[life, income].filter(Boolean).map((r) => r!.code).join(',')}`,
    evidence: [life, income].filter(Boolean).map((r) => ({ label: 'Resilience protection risk', value: `${r!.code} (${r!.severity})`, source_path: 'resilience.active_risks[].code' } as NbaEvidence)),
    related_module: 'insurance', action_route: '/insurance', suppresses: ['RESILIENCE_WEAKNESS'],
  };
};

const assetConcentration: Rule = (ctx) => {
  const hit = risk(ctx, 'property_concentration');
  if (!hit) return null;
  return {
    action_code: 'ASSET_CONCENTRATION', tier: 'CONCENTRATION', severity: severityOf(hit.severity, 'medium'),
    title: 'Review property concentration',
    source_ref: 'resilience.active_risks:property_concentration',
    evidence: [
      { label: 'Property concentration', value: ctx.balance_sheet?.property_concentration === null || ctx.balance_sheet?.property_concentration === undefined ? 'not recorded' : `${Math.round(ctx.balance_sheet.property_concentration * 100)}% of assets`, source_path: 'balance_sheet.property_concentration' },
    ],
    related_module: 'assets', action_route: '/assets', suppresses: ['RESILIENCE_WEAKNESS'],
  };
};

const incomeConcentration: Rule = (ctx) => {
  const hit = risk(ctx, 'income_concentration');
  if (!hit) return null;
  return {
    action_code: 'INCOME_CONCENTRATION', tier: 'CONCENTRATION', severity: severityOf(hit.severity, 'medium'),
    title: 'Review your reliance on one income source',
    source_ref: 'resilience.active_risks:income_concentration',
    evidence: [{ label: 'Income concentration', value: ctx.resilience?.income_concentration === null || ctx.resilience?.income_concentration === undefined ? 'not recorded' : `${Math.round(ctx.resilience.income_concentration * 100)}%`, source_path: 'resilience.income_concentration' }],
    related_module: 'income', action_route: '/income', suppresses: ['RESILIENCE_WEAKNESS'],
  };
};

const offTrackGoals: Rule = (ctx) => {
  const cert = ctx.domain_certification.goals?.status;
  if (cert === 'INVALID' || cert === 'UNAVAILABLE') return null;
  const hits = ctx.goals.filter((g) => g.track_status && GOAL_RISK_STATUSES.has(g.track_status));
  if (hits.length === 0) return null;
  const anyOff = hits.some((g) => g.track_status === 'off_track');
  return {
    action_code: 'OFF_TRACK_GOALS', tier: 'PROGRESS', severity: anyOff ? 'high' : 'medium',
    title: hits.length === 1 ? `Get your ${hits[0].goal_type} goal back on track` : `Review ${hits.length} goals that are not on track`,
    source_ref: `goals[].track_status:${[...new Set(hits.map((g) => g.track_status))].join(',')}`,
    evidence: hits.slice(0, 3).map((g) => ({ label: `Goal ${g.goal_type}`, value: `${g.track_status}${g.required_contribution !== null ? ` — required ${money(ctx, g.required_contribution)} vs recorded ${money(ctx, g.contribution)}` : ''}`, source_path: 'goals[].track_status' })),
    related_module: 'goals', action_route: '/goals', suppresses: [],
  };
};

const scoreWeakness: Rule = (ctx) => {
  const band = ctx.health_score?.score_band;
  if (!band || !WEAK_SCORE_BANDS.has(band)) return null;
  return {
    action_code: 'SCORE_WEAKNESS', tier: 'REVIEW', severity: band === 'critical' ? 'high' : 'medium',
    title: 'Review the drivers of your Financial Health Score',
    source_ref: `health_score.score_band:${band}`,
    evidence: [
      { label: 'Financial Health Score', value: String(ctx.health_score!.overall_score), source_path: 'health_score.overall_score' },
      { label: 'Score band', value: band, source_path: 'health_score.score_band' },
      { label: 'Principal drivers', value: ctx.health_score!.principal_drivers.join(', ') || 'none recorded', source_path: 'health_score.principal_drivers' },
    ],
    related_module: 'score', action_route: '/score', suppresses: ['SCORE_DETERIORATION'],
  };
};

const scoreDeterioration: Rule = (ctx) => {
  const hs = ctx.health_score;
  if (!hs || hs.prior_valid_score === null || hs.score_movement === null || !(hs.score_movement < 0)) return null;
  return {
    action_code: 'SCORE_DETERIORATION', tier: 'REVIEW', severity: 'low',
    title: 'Check what moved your score down',
    source_ref: 'health_score.score_movement:<0',
    evidence: [
      { label: 'Score movement', value: String(hs.score_movement), source_path: 'health_score.score_movement' },
      { label: 'Prior valid score', value: String(hs.prior_valid_score), source_path: 'health_score.prior_valid_score' },
    ],
    related_module: 'score', action_route: '/score', suppresses: [],
  };
};

const crossBorderExposure: Rule = (ctx) => {
  if (!ctx.household?.cross_border_indicator) return null;
  const cert = ctx.domain_certification.cross_border?.status;
  return {
    action_code: 'CROSS_BORDER_EXPOSURE', tier: 'REVIEW', severity: cert === 'INVALID' || cert === 'UNAVAILABLE' ? 'medium' : 'low',
    title: 'Review your cross-border position',
    source_ref: 'household.cross_border_indicator:true',
    evidence: [
      { label: 'Cross-border indicator', value: 'true', source_path: 'household.cross_border_indicator' },
      { label: 'Cross-border certification', value: cert ?? 'not recorded', source_path: 'domain_certification.cross_border.status' },
      ...(ctx.cross_border ? [{ label: 'Countries present', value: ctx.cross_border.countries_present.join(', '), source_path: 'cross_border.countries_present' }] : []),
    ],
    related_module: 'cross_border', action_route: '/dashboard', suppresses: [],
  };
};

const resilienceWeakness: Rule = (ctx) => {
  const band = ctx.resilience?.resilience_status;
  if (!band || !WEAK_RESILIENCE_BANDS.has(band)) return null;
  return {
    action_code: 'RESILIENCE_WEAKNESS', tier: 'REVIEW', severity: band === 'fragile' ? 'high' : 'medium',
    title: 'Strengthen your financial resilience',
    source_ref: `resilience.resilience_status:${band}`,
    evidence: [
      { label: 'Resilience status', value: band, source_path: 'resilience.resilience_status' },
      { label: 'Resilience score', value: String(ctx.resilience!.resilience_score), source_path: 'resilience.resilience_score' },
    ],
    related_module: 'resilience', action_route: '/resilience', suppresses: [],
  };
};

/** Fixed evaluation order (stable for determinism; ranking decides presentation). */
export const NBA_RULES: readonly { code: NbaActionCode; rule: Rule }[] = [
  { code: 'MISSING_CRITICAL_INFORMATION', rule: missingCriticalInformation },
  { code: 'STALE_INFORMATION', rule: staleInformation },
  { code: 'MISSING_RETIREMENT_DATA', rule: missingRetirementData },
  { code: 'MISSING_INSURANCE_DATA', rule: missingInsuranceData },
  { code: 'NEGATIVE_CASH_FLOW', rule: negativeCashFlow },
  { code: 'LIQUIDITY_WEAKNESS', rule: liquidityWeakness },
  { code: 'DEBT_PRESSURE', rule: debtPressure },
  { code: 'INSURANCE_PROTECTION_GAP', rule: insuranceProtectionGap },
  { code: 'ASSET_CONCENTRATION', rule: assetConcentration },
  { code: 'INCOME_CONCENTRATION', rule: incomeConcentration },
  { code: 'OFF_TRACK_GOALS', rule: offTrackGoals },
  { code: 'SCORE_WEAKNESS', rule: scoreWeakness },
  { code: 'SCORE_DETERIORATION', rule: scoreDeterioration },
  { code: 'CROSS_BORDER_EXPOSURE', rule: crossBorderExposure },
  { code: 'RESILIENCE_WEAKNESS', rule: resilienceWeakness },
];

export function evaluateRules(ctx: FinancialContextObject): NbaCandidate[] {
  const out: NbaCandidate[] = [];
  for (const { code, rule } of NBA_RULES) {
    const c = rule(ctx);
    if (c && c.action_code === code) out.push(c);
  }
  return out;
}
