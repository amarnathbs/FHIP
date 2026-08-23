import { createHash } from 'crypto';
import type { IiReviewComplianceClassification, IiReviewSeverity, IiReviewSourceModule, IiReviewType } from '@/lib/services/investment-intelligence/types';
import type { PerInvestmentAttribution } from '@/lib/services/investment-intelligence/portfolioAttribution';

// Investment Intelligence R9 — Review Centre deterministic rule engine.
//
// PURE FUNCTIONS ONLY (spec section 40: "R9 must operate fully without an
// LLM"; engines/ vs services/ split convention used throughout this
// project — see lib/engines/forecast/*, lib/engines/investment-intelligence/
// PerformanceEngine.ts). Every rule here re-reads data ALREADY computed and
// certified by another module (Goals' goal_forecasts.track_status, R4's
// ii_analytics_results, R5's ii_sip_series, R6's
// ii_capital_gains_computations) and applies a deterministic threshold from
// the versioned ii_review_rule_registry. No rule here derives new financial
// truth, recalculates tax, performance, or forecasts (spec sections
// 129-131), and no rule ever produces a PERSONALISED_ADVICE-classified item
// (spec sections 40-42) — the type system enforces this (see
// IiReviewComplianceClassification's Exclude<..., 'personalised_advice'>).

export const REVIEW_ENGINE_VERSION = 'review-1.0.0';

export interface RuleConfig {
  ruleKey: string;
  ruleVersion: string;
  reviewType: IiReviewType;
  category: string;
  defaultSeverity: IiReviewSeverity;
  complianceClassification: IiReviewComplianceClassification;
  thresholdConfig: Record<string, unknown>;
}

export interface ReviewItemCandidate {
  reviewType: IiReviewType;
  category: string;
  severity: IiReviewSeverity;
  complianceClassification: IiReviewComplianceClassification;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  sourceModule: IiReviewSourceModule;
  sourceRecordId: string | null;
  sourceRecordVersion: string | null;
  ruleKey: string;
  ruleVersion: string;
  asOfDate: string;
  identityKey: string;
}

// Deterministic dedup identity (spec section 50): a rule re-run over
// UNCHANGED evidence must resolve to the exact same key, so
// reviewCentreData.ts's upsert can update-in-place rather than spamming a
// duplicate. Components are stable identifiers, never free-text.
export function computeIdentityKey(userId: string, reviewType: string, category: string, sourceRecordId: string | null, extra?: string): string {
  const payload = JSON.stringify([userId, reviewType, category, sourceRecordId, extra ?? null]);
  return createHash('sha256').update(payload).digest('hex');
}

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  return typeof v === 'number' ? v : fallback;
}

// ---------------------------------------------------------------------------
// 1. Unallocated investments (spec section 17, category 'unallocated_investment')
// ---------------------------------------------------------------------------
export function detectUnallocatedInvestments(userId: string, perInvestment: PerInvestmentAttribution[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  const minValue = num(rule.thresholdConfig, 'minUnallocatedValue', 0);
  return perInvestment
    .filter((i) => i.unallocatedValue > minValue)
    .map((i) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Investment not linked to a financial goal',
      description: `A portion of your investment portfolio is not currently linked to a financial goal (${i.unallocatedValue.toFixed(2)} ${i.currencyCode} unallocated of ${i.currentValue.toFixed(2)} ${i.currencyCode}).`,
      evidence: { investmentId: i.investmentId, currentValue: i.currentValue, allocatedValue: i.allocatedValue, unallocatedValue: i.unallocatedValue, allocatedPct: i.allocatedPct, currencyCode: i.currencyCode },
      sourceModule: 'ii_publishing' as IiReviewSourceModule,
      sourceRecordId: i.investmentId,
      sourceRecordVersion: null,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, i.investmentId),
    }));
}

// ---------------------------------------------------------------------------
// 2. Over-allocation (defence-in-depth read-side detector; spec sections 16,
//    89 negative-control-2, critical fail condition 2). The PRIMARY control
//    is the write-time <=100% cap in checkFundingAllocation(), enforced by
//    every R9 write path (goalAllocations.ts). This rule exists so a
//    violation would still surface even if a future code path forgot to
//    call the write-time check — it must never itself be the only line of
//    defence.
// ---------------------------------------------------------------------------
export function detectOverAllocation(userId: string, perInvestment: PerInvestmentAttribution[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  return perInvestment
    .filter((i) => i.allocatedPct > 100)
    .map((i) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: 'high' as IiReviewSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Investment allocated beyond 100% across goals',
      description: `This investment is allocated ${i.allocatedPct.toFixed(1)}% across its linked goals, which exceeds 100%. This should not be possible under the enforced allocation cap and indicates a data-integrity issue requiring review.`,
      evidence: { investmentId: i.investmentId, allocatedPct: i.allocatedPct, goalIds: i.goalIds },
      sourceModule: 'ii_publishing' as IiReviewSourceModule,
      sourceRecordId: i.investmentId,
      sourceRecordVersion: null,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, 'goal_allocation_conflict', i.investmentId),
    }));
}

// ---------------------------------------------------------------------------
// 3. Goal forecast gap (spec sections 34-36, category 'goal_forecast_gap').
//    Consumes the CANONICAL Goals forecast (goal_forecasts.track_status /
//    funding_gap_at_target_date) — never recomputed here (spec section 27).
// ---------------------------------------------------------------------------
export interface GoalForecastInput {
  goalId: string;
  goalName: string;
  trackStatus: string;
  fundingGapAtTargetDate: number | null;
  targetAmountFuture: number;
  projectedTargetDateValue: number | null;
  currencyCode: string;
  modelVersion: string;
  forecastId: string;
  hasActiveFundingSource: boolean;
}
export function detectGoalForecastGap(userId: string, goals: GoalForecastInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  const flaggedStatuses = new Set((rule.thresholdConfig.trackStatuses as string[] | undefined) ?? ['off_track', 'at_risk']);
  return goals
    .filter((g) => g.hasActiveFundingSource && flaggedStatuses.has(g.trackStatus))
    .map((g) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: `"${g.goalName}" forecast is ${g.trackStatus.replace('_', ' ')}`,
      description:
        g.fundingGapAtTargetDate !== null
          ? `This goal's current forecast is below its target by ${Math.abs(g.fundingGapAtTargetDate).toFixed(2)} ${g.currencyCode}.`
          : `This goal's current forecast status is ${g.trackStatus.replace('_', ' ')}.`,
      evidence: {
        goalId: g.goalId,
        trackStatus: g.trackStatus,
        targetAmountFuture: g.targetAmountFuture,
        projectedTargetDateValue: g.projectedTargetDateValue,
        fundingGapAtTargetDate: g.fundingGapAtTargetDate,
        currencyCode: g.currencyCode,
        forecastModelVersion: g.modelVersion,
      },
      sourceModule: 'goals' as IiReviewSourceModule,
      sourceRecordId: g.forecastId,
      sourceRecordVersion: g.modelVersion,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, g.goalId, g.trackStatus),
    }));
}

// ---------------------------------------------------------------------------
// 4. Stale valuation (spec section 43, category 'stale_valuation').
// ---------------------------------------------------------------------------
export interface StaleValuationInput {
  investmentId: string;
  iiLastRefreshedAt: string | null;
  sourceType: string;
}
export function detectStaleValuation(userId: string, investments: StaleValuationInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  const staleDays = num(rule.thresholdConfig, 'staleDays', 90);
  const asOf = new Date(asOfDate).getTime();
  return investments
    .filter((i) => i.sourceType === 'investment_intelligence_published' && i.iiLastRefreshedAt)
    .map((i) => ({ ...i, ageDays: Math.floor((asOf - new Date(i.iiLastRefreshedAt as string).getTime()) / 86_400_000) }))
    .filter((i) => i.ageDays > staleDays)
    .map((i) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Investment valuation has not been refreshed recently',
      description: `This investment was last refreshed ${i.ageDays} days ago, beyond the ${staleDays}-day threshold.`,
      evidence: { investmentId: i.investmentId, ageDays: i.ageDays, staleDaysThreshold: staleDays, lastRefreshedAt: i.iiLastRefreshedAt },
      sourceModule: 'ii_publishing' as IiReviewSourceModule,
      sourceRecordId: i.investmentId,
      sourceRecordVersion: null,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, i.investmentId),
    }));
}

// ---------------------------------------------------------------------------
// 5. Open reconciliation cases (spec section 43, category 'unresolved_instrument').
// ---------------------------------------------------------------------------
export interface ReconciliationCaseInput {
  id: string;
  subjectType: string;
  subjectId: string;
  discrepancyType: string;
  openedAt: string;
}
export function detectOpenReconciliationCases(userId: string, cases: ReconciliationCaseInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  return cases.map((c) => ({
    reviewType: rule.reviewType,
    category: rule.category,
    severity: rule.defaultSeverity,
    complianceClassification: rule.complianceClassification,
    title: 'Unresolved portfolio reconciliation case',
    description: `A ${c.discrepancyType.replace(/_/g, ' ')} reconciliation case on this ${c.subjectType.replace('_', ' ')} is still open.`,
    evidence: { caseId: c.id, subjectType: c.subjectType, subjectId: c.subjectId, discrepancyType: c.discrepancyType, openedAt: c.openedAt },
    sourceModule: 'ii_data_quality' as IiReviewSourceModule,
    sourceRecordId: c.id,
    sourceRecordVersion: null,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.ruleVersion,
    asOfDate,
    identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, c.id),
  }));
}

// ---------------------------------------------------------------------------
// 6. Benchmark underperformance (spec section 43, consumes R4 output only —
//    spec section 130, "must not independently implement XIRR/TWRR").
//
// Reads the REAL R4 ii_analytics_results row shape (migration 0043 — the
// table R4 rebuilt from the R1-era placeholder, not the placeholder
// schema): metric_key='scheme_active_return' at scope_type='scheme',
// result_value = { status, value: { activeReturn, family, benchmarkKey } | null, ... },
// where activeReturn is a CAGR-fraction difference (scheme CAGR minus
// benchmark CAGR since inception — see analyticsOrchestrator.ts's
// computeSchemeActive()), never a recomputation of it (spec section 130).
// Only quality_status='ok' rows are eligible — an 'unavailable'/'stale'
// result carries no comparable number to threshold against.
// ---------------------------------------------------------------------------
export interface PerformanceMetricInput {
  scopeId: string;
  metricKey: string;
  activeReturn: number | null; // result_value.value.activeReturn, a CAGR-fraction difference (e.g. -0.02 = -2%)
  qualityStatus: string;
  engineVersion: string;
}
export function detectBenchmarkUnderperformance(userId: string, metrics: PerformanceMetricInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  const thresholdFraction = num(rule.thresholdConfig, 'underperformanceFraction', 0.02); // default: 2 percentage points of CAGR
  return metrics
    .filter((m) => m.metricKey === 'scheme_active_return' && m.qualityStatus === 'ok' && m.activeReturn !== null && m.activeReturn < -thresholdFraction)
    .map((m) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Position trailing its benchmark',
      description: `This position's since-inception return trails its benchmark by ${Math.abs((m.activeReturn as number) * 100).toFixed(2)} percentage points, based on certified R4 performance analytics.`,
      evidence: { instrumentId: m.scopeId, activeReturn: m.activeReturn, thresholdFraction, engineVersion: m.engineVersion },
      sourceModule: 'ii_r4_performance' as IiReviewSourceModule,
      sourceRecordId: m.scopeId,
      sourceRecordVersion: m.engineVersion,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, m.scopeId, m.engineVersion),
    }));
}

// ---------------------------------------------------------------------------
// 7. SIP interruption (spec section 43, consumes R5 output only — spec
//    section 131). Only regular, confidently-detected series are eligible —
//    an IRREGULAR/UNKNOWN/NOT_SIP series or a LOW-confidence detection
//    cannot support an "interrupted" claim without fabricating certainty
//    (spec section 40's "no unsupported evidence" principle).
// ---------------------------------------------------------------------------
const CADENCE_INTERVAL_DAYS: Record<string, number> = { WEEKLY: 7, FORTNIGHTLY: 14, MONTHLY: 30, QUARTERLY: 91, ANNUAL: 365 };
export interface SipSeriesInput {
  id: string;
  instrumentId: string;
  cadence: string;
  detectionConfidence: string;
  latestContributionDate: string | null;
  detectionMethodVersion: string;
}
export function detectSipInterruption(userId: string, series: SipSeriesInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  const missedThreshold = num(rule.thresholdConfig, 'missedInstalments', 2);
  const asOf = new Date(asOfDate).getTime();
  const out: ReviewItemCandidate[] = [];
  for (const s of series) {
    const interval = CADENCE_INTERVAL_DAYS[s.cadence];
    if (!interval) continue; // IRREGULAR/OTHER_RECURRING/UNKNOWN — no defined cadence to compare against
    if (s.detectionConfidence !== 'CONFIRMED_SOURCE' && s.detectionConfidence !== 'HIGH_CONFIDENCE') continue;
    if (!s.latestContributionDate) continue;
    const daysSince = Math.floor((asOf - new Date(s.latestContributionDate).getTime()) / 86_400_000);
    const missed = Math.max(Math.floor(daysSince / interval) - 1, 0);
    if (missed < missedThreshold) continue;
    out.push({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'SIP contribution pattern interrupted',
      description: `This recurring investment series has missed approximately ${missed} expected ${s.cadence.toLowerCase()} instalment(s) since its last detected contribution.`,
      evidence: { sipSeriesId: s.id, instrumentId: s.instrumentId, cadence: s.cadence, missedInstalments: missed, latestContributionDate: s.latestContributionDate, detectionConfidence: s.detectionConfidence },
      sourceModule: 'ii_r5_sip_xray' as IiReviewSourceModule,
      sourceRecordId: s.id,
      sourceRecordVersion: s.detectionMethodVersion,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, s.id),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Exit-load exposure (spec section 43, consumes R6 output only — spec
//    section 129, "must not recalculate capital gains tax itself").
// ---------------------------------------------------------------------------
export interface ExitLoadExposureInput {
  lotId: string;
  instrumentId: string;
  exitLoadPct: number | null;
  engineVersion: string;
}
export function detectExitLoadExposure(userId: string, rows: ExitLoadExposureInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  return rows
    .filter((r) => (r.exitLoadPct ?? 0) > 0)
    .map((r) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Potential exit-load exposure',
      description: `A lot in this holding would incur an exit load of ${(r.exitLoadPct as number).toFixed(2)}% if disposed today, based on certified R6 exit-load schedules.`,
      evidence: { lotId: r.lotId, instrumentId: r.instrumentId, exitLoadPct: r.exitLoadPct, engineVersion: r.engineVersion },
      sourceModule: 'ii_r6_tax' as IiReviewSourceModule,
      sourceRecordId: r.lotId,
      sourceRecordVersion: r.engineVersion,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, r.lotId),
    }));
}

// ---------------------------------------------------------------------------
// 9. Tax-lot / disposal classification incomplete (spec section 43,
//    category 'tax_lot_incomplete'). Consumes R6's own
//    classification/gain_type 'unresolved' flags — never recomputes tax
//    (spec section 129).
// ---------------------------------------------------------------------------
export interface TaxLotIncompleteInput {
  computationId: string;
  instrumentId: string;
  classification: string;
  gainType: string;
  engineVersion: string;
}
export function detectTaxLotIncomplete(userId: string, rows: TaxLotIncompleteInput[], asOfDate: string, rule: RuleConfig): ReviewItemCandidate[] {
  return rows
    .filter((r) => r.classification === 'unresolved' || r.gainType === 'unresolved')
    .map((r) => ({
      reviewType: rule.reviewType,
      category: rule.category,
      severity: rule.defaultSeverity,
      complianceClassification: rule.complianceClassification,
      title: 'Tax classification data incomplete',
      description: 'A disposal computation has an unresolved scheme classification or gain-type, so its certified tax figures are incomplete.',
      evidence: { computationId: r.computationId, instrumentId: r.instrumentId, classification: r.classification, gainType: r.gainType, engineVersion: r.engineVersion },
      sourceModule: 'ii_r6_tax' as IiReviewSourceModule,
      sourceRecordId: r.computationId,
      sourceRecordVersion: r.engineVersion,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      asOfDate,
      identityKey: computeIdentityKey(userId, rule.reviewType, rule.category, r.computationId),
    }));
}
