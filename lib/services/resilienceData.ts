import { createClient } from '@/lib/supabase/server';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadSectionStatus } from '@/lib/services/financialSectionStatusData';
import {
  computeResilience,
  MODEL_VERSION,
  type ResilienceConfig,
  type ResilienceInput,
  type ResilienceResult,
  type CommitmentRow,
} from '@/lib/engines/resilience';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export interface ResilienceHistoryPoint {
  score_month: string;
  rounded_score: number;
}

export interface ResiliencePayload extends ResilienceResult {
  previousScore: number | null;
  scoreChange: number | null;
  history: ResilienceHistoryPoint[];
}

// Builds the full ResilienceInput without persisting anything — used by the
// real GET route (which persists afterwards), the stress-test simulator
// (which never persists), and by Module 4's Health Score engine (which
// absorbs this engine's overall score as its own resilience component,
// rather than recomputing resilience logic itself).
export async function buildResilienceInput(userId: string, client?: SupabaseServerClient): Promise<ResilienceInput> {
  const supabase = client ?? (await createClient());

  const [householdRes, profileRes, configRes, commitmentsRes, snapshotRes, priorScoreRes] = await Promise.all([
    supabase.from('households').select('dependants_count').eq('user_id', userId).maybeSingle(),
    supabase.from('user_profiles').select('employment_status').eq('user_id', userId).single(),
    supabase.from('resilience_config').select('config').eq('is_active', true).single(),
    supabase
      .from('future_financial_commitments')
      .select('amount, due_date, is_mandatory')
      .eq('user_id', userId)
      .eq('is_active', true),
    supabase
      .from('financial_snapshots')
      .select('snapshot_month')
      .eq('user_id', userId)
      .order('snapshot_month', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('resilience_scores')
      .select('id')
      .eq('user_id', userId)
      .neq('score_month', monthStart())
      .limit(1)
      .maybeSingle(),
  ]);

  const dashboard = await loadDashboard(userId, supabase);
  const sectionStatus = await loadSectionStatus(userId, dashboard, supabase);
  const employmentStatus = profileRes.data?.employment_status ?? '';
  const isSelfEmployed = /self.?employed/i.test(employmentStatus);
  const isCurrentSnapshotRecent = snapshotRes.data?.snapshot_month === monthStart();

  return {
    dashboard,
    dependantsCount: householdRes.data?.dependants_count ?? 0,
    isSelfEmployed,
    commitments: (commitmentsRes.data as CommitmentRow[]) ?? [],
    isCurrentSnapshotRecent,
    hasPriorMonthHistory: Boolean(priorScoreRes.data),
    config: configRes.data?.config as ResilienceConfig,
    sectionStatus,
  };
}

export async function loadResilience(userId: string, client?: SupabaseServerClient): Promise<ResiliencePayload> {
  const supabase = client ?? (await createClient());

  const [input, historyRes] = await Promise.all([
    buildResilienceInput(userId, supabase),
    supabase
      .from('resilience_scores')
      .select('score_month, rounded_score')
      .eq('user_id', userId)
      .order('score_month', { ascending: true })
      .limit(12),
  ]);

  const result = computeResilience(input);

  const { data: previousRow } = await supabase
    .from('resilience_scores')
    .select('overall_score')
    .eq('user_id', userId)
    .neq('score_month', monthStart())
    .order('score_month', { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousScore = previousRow?.overall_score ?? null;
  const scoreChange = previousScore !== null ? result.overallScore - previousScore : null;

  const { data: scoreRow } = await supabase
    .from('resilience_scores')
    .upsert(
      {
        user_id: userId,
        score_month: monthStart(),
        overall_score: result.overallScore,
        rounded_score: result.roundedScore,
        status_band: result.statusBand,
        confidence_score: result.confidence,
        model_version: MODEL_VERSION,
        previous_score: previousScore,
        score_change: scoreChange,
        risk_override_applied: result.riskOverrideApplied,
        risk_override_reason: result.riskOverrideReason,
      },
      { onConflict: 'user_id,score_month' }
    )
    .select('id')
    .single();

  if (scoreRow) {
    await supabase.from('resilience_component_scores').delete().eq('score_id', scoreRow.id);
    await supabase.from('resilience_component_scores').insert(
      result.components.map((c) => ({
        score_id: scoreRow.id,
        user_id: userId,
        component_code: c.code,
        raw_score: c.rawScore,
        component_weight: c.weight,
        weighted_contribution: c.weightedContribution,
        status_band: c.statusBand,
        data_completeness: c.dataCompleteness,
        treatment: c.treatment,
        explanation: c.explanation,
        current_value: c.currentValue,
        benchmark_value: c.benchmarkValue,
      }))
    );

    await supabase.from('resilience_risks').delete().eq('score_id', scoreRow.id);
    if (result.risks.length > 0) {
      await supabase.from('resilience_risks').insert(
        result.risks.map((r) => ({
          score_id: scoreRow.id,
          user_id: userId,
          risk_code: r.code,
          category: r.category,
          severity: r.severity,
          title: r.title,
          explanation: r.explanation,
          metric_value: r.metricValue,
          threshold_value: r.thresholdValue,
        }))
      );
    }

    await supabase.from('resilience_actions').delete().eq('score_id', scoreRow.id);
    if (result.actions.length > 0) {
      await supabase.from('resilience_actions').insert(
        result.actions.map((a) => ({
          score_id: scoreRow.id,
          user_id: userId,
          action_code: a.code,
          title: a.title,
          explanation: a.explanation,
          priority: a.priority,
          related_module: a.relatedModule,
          related_metric: a.relatedMetric,
        }))
      );
    }
  }

  const history = (historyRes.data ?? []) as ResilienceHistoryPoint[];

  return { ...result, previousScore, scoreChange, history };
}
