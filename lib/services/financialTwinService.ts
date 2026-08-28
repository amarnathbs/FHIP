import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from './dashboardData';
import { loadTwinSourceData } from './twinData';
import { matchCohort } from './twinCohortMatching';
import { computeTwinMetricValues, computeFutureSelfValues } from '@/lib/engines/twin/metricDerivation';
import { METRIC_CATALOGUE } from '@/lib/engines/twin/metricCatalogue';
import { loadPeerBenchmark, loadHealthyRange, healthyBandFor, type PeerBenchmark, type HealthyRangeBand } from './twinBenchmarkRetrieval';
import { computeGap, type GapResult } from '@/lib/engines/twin/gapAnalysis';
import { computePercentile, hasValidDistribution, type PercentileResult } from '@/lib/engines/twin/percentile';
import { computeConfidenceScore, recencyScoreFromYear, sampleSizeScore, cohortRelevanceScoreFromTier } from '@/lib/engines/twin/confidence';
import { comparisonStatusFromTargetRange, type ComparisonStatus, type EvidenceLevel } from '@/lib/engines/twin/taxonomy';

export interface TwinMetricOutcome {
  metricCode: string;
  category: string;
  label: string;
  unit: string;
  userValue: number | null;
  notComparableReason: string | null;
  similarTwin: {
    value: number;
    statisticType: string;
    benchmarkClass: string;
    isIndicative: boolean;
    isDerived: boolean;
    derivationMethod: string | null;
    sourceCitation: string;
    sourceYear: number | null;
  } | null;
  healthyPath: {
    min: number | null;
    max: number | null;
    bandLabel: string;
    explanation: string | null;
    evidenceLevel: EvidenceLevel;
    modelVersion: string;
    sourceCitation: string | null;
  } | null;
  futureSelf: number | null;
  gapVsSimilarTwin: GapResult | null;
  percentileVsSimilarTwin: PercentileResult | null;
  status: ComparisonStatus;
  confidence: number;
}

export interface GenerateTwinResult {
  runId: string;
  cohortTier: number;
  cohortTierLabel: string;
  cohortDescription: string | null;
  matchExplanation: string;
  overallConfidence: number;
  metricsCompared: number;
  aheadCount: number;
  alignedCount: number;
  behindCount: number;
  notComparableCount: number;
  dataCompletenessPct: number;
  metrics: TwinMetricOutcome[];
  isFirstTwin: boolean;
}

const EVIDENCE_AUTHORITY_SCORE: Record<EvidenceLevel, number> = {
  official_statistical: 90,
  regulatory: 95,
  research_informed: 60,
  platform_derived: 50,
};

// G0-JA-1 Wave 1 (JA-D1): the distinguishable "comparison unavailable"
// contract for a caller whose home country cannot be resolved — surfaced
// through this exact same shape from both the API route and, in future, any
// other caller (spec's "API behaviour" requirement: not just suppressed in
// one UI component). Never an AU-cohort result, never a fabricated zero.
export type GenerateTwinOutcome = { status: 'ok'; result: GenerateTwinResult } | { status: 'country_unresolved' };

export async function generateFinancialTwin(userId: string, client?: SupabaseServerClient): Promise<GenerateTwinOutcome> {
  const supabase = client ?? (await createClient());
  const sourceOutcome = await loadTwinSourceData(userId, supabase);
  if (sourceOutcome.status === 'country_unresolved') {
    // Fail closed before any cohort match, metric computation, or DB write —
    // no financial_twin_runs/metric_results/insights row is ever created for
    // an unresolved-country attempt, so there is nothing here for the
    // historical-output protection rule to have to guard retroactively.
    return { status: 'country_unresolved' };
  }
  const source = sourceOutcome.data;
  const cohortMatch = await matchCohort(source.household, supabase);
  const metricValues = computeTwinMetricValues(source);
  const futureSelf = computeFutureSelfValues(source);

  const { data: metricDefRows } = await supabase.from('benchmark_metric_definitions').select('id, metric_code');
  const metricDefIdByCode = new Map((metricDefRows ?? []).map((r) => [r.metric_code as string, r.id as string]));

  // Every metric's benchmark lookups are independent of every other
  // metric's, so all 67 run concurrently rather than one at a time — a
  // sequential loop here previously took long enough to time out a request.
  async function processMetric(def: (typeof METRIC_CATALOGUE)[number]): Promise<TwinMetricOutcome> {
    const mv = metricValues[def.code] ?? { value: null, notComparableReason: 'Metric not computed.' };
    const metricDefId = metricDefIdByCode.get(def.code);

    let peer: PeerBenchmark | null = null;
    let healthyBands: HealthyRangeBand[] | null = null;
    if (metricDefId) {
      [peer, healthyBands] = await Promise.all([
        loadPeerBenchmark(supabase, metricDefId, cohortMatch.cohort?.id ?? null, source.household.countryOfResidence),
        loadHealthyRange(supabase, metricDefId, source.household.countryOfResidence, source.household.lifeStage, source.household.householdTypeCode),
      ]);
    }

    let gapVsSimilarTwin: GapResult | null = null;
    let percentileVsSimilarTwin: PercentileResult | null = null;
    let healthy: { min: number | null; max: number | null; band: HealthyRangeBand } | null = null;
    if (healthyBands && healthyBands.length > 0) healthy = healthyBandFor(healthyBands);

    let status: ComparisonStatus = 'not_comparable';
    if (mv.value !== null) {
      if (def.direction === 'target_range' && healthy) {
        status = comparisonStatusFromTargetRange(mv.value, healthy.min, healthy.max, 'target_range');
      } else if ((def.direction === 'higher_better' || def.direction === 'lower_better') && peer) {
        gapVsSimilarTwin = computeGap(mv.value, peer.value, def.direction);
        status = gapVsSimilarTwin.status;
        if (hasValidDistribution(peer.distribution)) {
          percentileVsSimilarTwin = computePercentile(mv.value, peer.distribution, def.direction);
        }
      } else if (def.direction === 'context_only') {
        status = 'context_required';
      } else if (healthy) {
        status = comparisonStatusFromTargetRange(mv.value, healthy.min, healthy.max, def.direction === 'lower_better' ? 'lower_better' : 'higher_better');
      }
    }

    const confidence = computeConfidenceScore({
      sourceAuthority: peer ? EVIDENCE_AUTHORITY_SCORE[peer.evidenceLevel] : healthy ? EVIDENCE_AUTHORITY_SCORE[healthy.band.evidenceLevel] : 30,
      cohortRelevance: cohortRelevanceScoreFromTier(cohortMatch.tier),
      dataRecency: peer?.sourceYear ? recencyScoreFromYear(peer.sourceYear) : 70,
      sampleSizeCoverage: sampleSizeScore(peer?.sampleSize ?? null),
      metricComparability: peer?.isDerived ? 70 : 90,
      methodTransparency: peer || healthy ? 85 : 60,
    });

    return {
      metricCode: def.code,
      category: def.category,
      label: def.label,
      unit: def.unit,
      userValue: mv.value,
      notComparableReason: mv.notComparableReason,
      similarTwin: peer
        ? {
            value: peer.value,
            statisticType: peer.statisticType,
            benchmarkClass: peer.benchmarkClass,
            isIndicative: peer.isIndicative,
            isDerived: peer.isDerived,
            derivationMethod: peer.derivationMethod,
            sourceCitation: peer.sourceCitation,
            sourceYear: peer.sourceYear,
          }
        : null,
      healthyPath: healthy
        ? {
            min: healthy.min,
            max: healthy.max,
            bandLabel: healthy.band.bandLabel,
            explanation: healthy.band.explanation,
            evidenceLevel: healthy.band.evidenceLevel,
            modelVersion: healthy.band.modelVersion,
            sourceCitation: healthy.band.sourceCitation,
          }
        : null,
      futureSelf: futureSelfValueFor(def.code, futureSelf),
      gapVsSimilarTwin,
      percentileVsSimilarTwin,
      status,
      confidence,
    };
  }

  const outcomes = await Promise.all(METRIC_CATALOGUE.map(processMetric));

  const aheadCount = outcomes.filter((o) => o.status === 'materially_ahead' || o.status === 'ahead' || o.status === 'target_range_met').length;
  const alignedCount = outcomes.filter((o) => o.status === 'broadly_aligned').length;
  const behindCount = outcomes.filter((o) => o.status === 'slightly_behind' || o.status === 'materially_behind').length;
  const notComparableCount = outcomes.filter((o) => o.status === 'not_comparable' || o.status === 'context_required').length;
  const comparableConfidences = outcomes.filter((o) => o.userValue !== null).map((o) => o.confidence);
  const overallConfidence = comparableConfidences.length > 0 ? Math.round((comparableConfidences.reduce((s, c) => s + c, 0) / comparableConfidences.length) * 10) / 10 : 0;
  const dataCompletenessPct = Math.round((outcomes.filter((o) => o.userValue !== null).length / outcomes.length) * 1000) / 10;

  const { count: priorCount } = await supabase.from('financial_twin_runs').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  const isFirstTwin = (priorCount ?? 0) === 0;

  const { data: run, error: runError } = await supabase
    .from('financial_twin_runs')
    .insert({
      user_id: userId,
      household_id: null,
      primary_cohort_id: cohortMatch.cohort?.id ?? null,
      cohort_tier: cohortMatch.tier,
      cohort_confidence: cohortRelevanceScoreFromTier(cohortMatch.tier),
      model_version: 'twin-1.0.0',
      benchmark_version: 'fhip-planning-1.0.0',
      overall_confidence: overallConfidence,
      metrics_compared: outcomes.filter((o) => o.userValue !== null).length,
      ahead_count: aheadCount,
      aligned_count: alignedCount,
      behind_count: behindCount,
      not_comparable_count: notComparableCount,
      status: 'indicative',
      data_completeness_pct: dataCompletenessPct,
    })
    .select('id')
    .single();
  if (runError || !run) throw new Error(runError?.message ?? 'Could not create Financial Twin run');

  await supabase.from('financial_twin_metric_results').insert(
    outcomes.map((o) => ({
      financial_twin_run_id: run.id,
      metric_code: o.metricCode,
      category_code: o.category,
      user_value: o.userValue,
      peer_value: o.similarTwin?.value ?? null,
      healthy_min: o.healthyPath?.min ?? null,
      healthy_max: o.healthyPath?.max ?? null,
      future_self_value: o.futureSelf,
      statistic_type: o.similarTwin?.statisticType ?? null,
      absolute_gap: o.gapVsSimilarTwin?.absoluteGap ?? null,
      percentage_gap: o.gapVsSimilarTwin?.percentageGap ?? null,
      percentile_rank: o.percentileVsSimilarTwin?.percentile ?? null,
      comparison_status: o.status,
      comparison_direction: null,
      benchmark_class: o.similarTwin?.benchmarkClass ?? null,
      confidence_score: o.confidence,
      not_comparable_reason: o.notComparableReason,
    }))
  );

  const insights = buildInsights(outcomes);
  if (insights.length > 0) {
    await supabase.from('financial_twin_insights').insert(insights.map((i) => ({ ...i, financial_twin_run_id: run.id })));
  }

  return {
    status: 'ok',
    result: {
      runId: run.id,
      cohortTier: cohortMatch.tier,
      cohortTierLabel: cohortMatch.tierLabel,
      cohortDescription: cohortMatch.cohort?.cohort_description ?? null,
      matchExplanation: cohortMatch.matchExplanation,
      overallConfidence,
      metricsCompared: outcomes.filter((o) => o.userValue !== null).length,
      aheadCount,
      alignedCount,
      behindCount,
      notComparableCount,
      dataCompletenessPct,
      metrics: outcomes,
      isFirstTwin,
    },
  };
}

export interface StoredTwinRun {
  id: string;
  runDate: string;
  cohortTier: number | null;
  overallConfidence: number | null;
  metricsCompared: number;
  aheadCount: number;
  alignedCount: number;
  behindCount: number;
  notComparableCount: number;
  dataCompletenessPct: number | null;
  status: string;
  createdAt: string;
}

export async function listTwinRuns(userId: string, client?: SupabaseServerClient): Promise<StoredTwinRun[]> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('financial_twin_runs')
    .select('id, run_date, cohort_tier, overall_confidence, metrics_compared, ahead_count, aligned_count, behind_count, not_comparable_count, data_completeness_pct, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  return (data ?? []).map((r) => ({
    id: r.id,
    runDate: r.run_date,
    cohortTier: r.cohort_tier,
    overallConfidence: r.overall_confidence !== null ? Number(r.overall_confidence) : null,
    metricsCompared: r.metrics_compared,
    aheadCount: r.ahead_count,
    alignedCount: r.aligned_count,
    behindCount: r.behind_count,
    notComparableCount: r.not_comparable_count,
    dataCompletenessPct: r.data_completeness_pct !== null ? Number(r.data_completeness_pct) : null,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export interface StoredTwinDetail extends StoredTwinRun {
  cohortDescription: string | null;
  metrics: {
    metricCode: string;
    categoryCode: string;
    userValue: number | null;
    peerValue: number | null;
    healthyMin: number | null;
    healthyMax: number | null;
    futureSelfValue: number | null;
    statisticType: string | null;
    absoluteGap: number | null;
    percentageGap: number | null;
    percentileRank: number | null;
    comparisonStatus: string | null;
    benchmarkClass: string | null;
    confidenceScore: number | null;
    notComparableReason: string | null;
  }[];
  insights: {
    insightType: string;
    priority: string | null;
    metricCode: string | null;
    title: string;
    explanation: string;
  }[];
}

export async function getTwinRunDetail(userId: string, runId: string, client?: SupabaseServerClient): Promise<StoredTwinDetail | null> {
  const supabase = client ?? (await createClient());
  const { data: run } = await supabase
    .from('financial_twin_runs')
    .select('id, run_date, cohort_tier, overall_confidence, metrics_compared, ahead_count, aligned_count, behind_count, not_comparable_count, data_completeness_pct, status, created_at, primary_cohort_id, benchmark_cohorts(cohort_description)')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!run) return null;

  const [{ data: metrics }, { data: insights }] = await Promise.all([
    supabase
      .from('financial_twin_metric_results')
      .select('metric_code, category_code, user_value, peer_value, healthy_min, healthy_max, future_self_value, statistic_type, absolute_gap, percentage_gap, percentile_rank, comparison_status, benchmark_class, confidence_score, not_comparable_reason')
      .eq('financial_twin_run_id', runId),
    supabase.from('financial_twin_insights').select('insight_type, priority, metric_code, title, explanation').eq('financial_twin_run_id', runId).order('display_rank'),
  ]);

  return {
    id: run.id,
    runDate: run.run_date,
    cohortTier: run.cohort_tier,
    cohortDescription: (run as unknown as { benchmark_cohorts: { cohort_description: string } | null }).benchmark_cohorts?.cohort_description ?? null,
    overallConfidence: run.overall_confidence !== null ? Number(run.overall_confidence) : null,
    metricsCompared: run.metrics_compared,
    aheadCount: run.ahead_count,
    alignedCount: run.aligned_count,
    behindCount: run.behind_count,
    notComparableCount: run.not_comparable_count,
    dataCompletenessPct: run.data_completeness_pct !== null ? Number(run.data_completeness_pct) : null,
    status: run.status,
    createdAt: run.created_at,
    metrics: (metrics ?? []).map((m) => ({
      metricCode: m.metric_code,
      categoryCode: m.category_code,
      userValue: m.user_value !== null ? Number(m.user_value) : null,
      peerValue: m.peer_value !== null ? Number(m.peer_value) : null,
      healthyMin: m.healthy_min !== null ? Number(m.healthy_min) : null,
      healthyMax: m.healthy_max !== null ? Number(m.healthy_max) : null,
      futureSelfValue: m.future_self_value !== null ? Number(m.future_self_value) : null,
      statisticType: m.statistic_type,
      absoluteGap: m.absolute_gap !== null ? Number(m.absolute_gap) : null,
      percentageGap: m.percentage_gap !== null ? Number(m.percentage_gap) : null,
      percentileRank: m.percentile_rank !== null ? Number(m.percentile_rank) : null,
      comparisonStatus: m.comparison_status,
      benchmarkClass: m.benchmark_class,
      confidenceScore: m.confidence_score !== null ? Number(m.confidence_score) : null,
      notComparableReason: m.not_comparable_reason,
    })),
    insights: (insights ?? []).map((i) => ({
      insightType: i.insight_type,
      priority: i.priority,
      metricCode: i.metric_code,
      title: i.title,
      explanation: i.explanation,
    })),
  };
}

function futureSelfValueFor(metricCode: string, futureSelf: ReturnType<typeof computeFutureSelfValues>): number | null {
  switch (metricCode) {
    case 'net_worth':
      return futureSelf.netWorthIn5Years;
    case 'retirement_balance':
      return futureSelf.retirementBalanceAtTarget;
    case 'projected_retirement_readiness':
      return futureSelf.retirementReadinessAtTarget;
    case 'goal_progress':
      return futureSelf.goalProgressAtTargetDates;
    default:
      return null;
  }
}

const STATUS_RANK: Record<ComparisonStatus, number> = {
  materially_ahead: 5,
  ahead: 4,
  target_range_met: 4,
  broadly_aligned: 3,
  context_required: 2,
  slightly_behind: 2,
  materially_behind: 1,
  not_comparable: 0,
};

// Deterministic top-3 strengths / top-3 gaps, drawn only from metrics that
// were actually comparable — never invents a strength or gap from missing
// data (spec: no fabricated peer values, no invented insights).
function buildInsights(outcomes: TwinMetricOutcome[]) {
  const comparable = outcomes.filter((o) => o.userValue !== null && o.status !== 'not_comparable');
  const strengths = [...comparable]
    .filter((o) => STATUS_RANK[o.status] >= 4)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])
    .slice(0, 3);
  const gaps = [...comparable]
    .filter((o) => STATUS_RANK[o.status] <= 2 && o.status !== 'context_required')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .slice(0, 3);

  const rows: {
    insight_type: 'strength' | 'gap';
    priority: 'high' | 'medium' | 'low';
    metric_code: string;
    user_value: number | null;
    peer_value: number | null;
    target_value: number | null;
    title: string;
    explanation: string;
    display_rank: number;
  }[] = [];

  strengths.forEach((o, i) => {
    rows.push({
      insight_type: 'strength',
      priority: i === 0 ? 'high' : 'medium',
      metric_code: o.metricCode,
      user_value: o.userValue,
      peer_value: o.similarTwin?.value ?? null,
      target_value: o.healthyPath?.min ?? null,
      title: `Strong ${o.label.toLowerCase()}`,
      explanation: `Your ${o.label.toLowerCase()} is ${o.status === 'materially_ahead' ? 'materially ahead of' : 'ahead of or within'} the available comparison.`,
      display_rank: i,
    });
  });
  gaps.forEach((o, i) => {
    rows.push({
      insight_type: 'gap',
      priority: o.status === 'materially_behind' ? 'high' : 'medium',
      metric_code: o.metricCode,
      user_value: o.userValue,
      peer_value: o.similarTwin?.value ?? null,
      target_value: o.healthyPath?.min ?? null,
      title: `Opportunity: ${o.label.toLowerCase()}`,
      explanation: `Your ${o.label.toLowerCase()} is currently ${o.status === 'materially_behind' ? 'materially behind' : 'behind'} the available comparison.`,
      display_rank: i,
    });
  });
  return rows;
}
