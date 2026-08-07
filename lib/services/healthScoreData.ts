import { createClient } from '@/lib/supabase/server';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { buildResilienceInput } from '@/lib/services/resilienceData';
import { computeResilience } from '@/lib/engines/resilience';
import { ageFromDob } from '@/lib/engines/age';
import {
  computeHealthScore,
  MODEL_VERSION,
  type HealthScoreConfig,
  type HealthScoreInput,
  type HealthScoreResult,
  type CheckIns,
} from '@/lib/engines/healthScore';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export interface HealthScoreHistoryPoint {
  score_month: string;
  rounded_score: number;
}

export interface HealthScorePayload extends HealthScoreResult {
  previousScore: number | null;
  scoreChange: number | null;
  history: HealthScoreHistoryPoint[];
}

// Builds the full HealthScoreInput without persisting anything — used by the
// real GET route (which persists afterwards) and by the what-if simulator
// (which never persists).
export async function buildHealthScoreInput(userId: string, client?: SupabaseServerClient): Promise<HealthScoreInput> {
  const supabase = client ?? (await createClient());

  const [profileRes, householdRes, checkInsRes, configRes] = await Promise.all([
    supabase.from('user_profiles').select('date_of_birth, employment_status').eq('user_id', userId).single(),
    supabase.from('households').select('dependants_count').eq('user_id', userId).maybeSingle(),
    supabase.from('health_check_ins').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('health_score_config').select('config').eq('is_active', true).single(),
  ]);

  const dashboard = await loadDashboard(userId, supabase);
  const config = configRes.data?.config as HealthScoreConfig;
  const employmentStatus = profileRes.data?.employment_status ?? '';
  const isSelfEmployed = /self.?employed/i.test(employmentStatus);

  const resilienceInput = await buildResilienceInput(userId, supabase);
  const resilienceResult = resilienceInput.config ? computeResilience(resilienceInput) : null;

  return {
    dashboard,
    age: ageFromDob(profileRes.data?.date_of_birth ?? null),
    dependantsCount: householdRes.data?.dependants_count ?? 0,
    isSelfEmployed,
    checkIns: (checkInsRes.data as CheckIns | null) ?? null,
    resilienceResult,
    config,
  };
}

export async function loadHealthScore(userId: string, client?: SupabaseServerClient): Promise<HealthScorePayload> {
  const supabase = client ?? (await createClient());

  const [input, historyRes] = await Promise.all([
    buildHealthScoreInput(userId, supabase),
    supabase
      .from('financial_health_scores')
      .select('score_month, rounded_score')
      .eq('user_id', userId)
      .order('score_month', { ascending: true })
      .limit(12),
  ]);

  const result = computeHealthScore(input);

  const { data: previousRow } = await supabase
    .from('financial_health_scores')
    .select('overall_score')
    .eq('user_id', userId)
    .neq('score_month', monthStart())
    .order('score_month', { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousScore = previousRow?.overall_score ?? null;
  const scoreChange = previousScore !== null ? result.overallScore - previousScore : null;

  const { data: scoreRow } = await supabase
    .from('financial_health_scores')
    .upsert(
      {
        user_id: userId,
        score_month: monthStart(),
        overall_score: result.overallScore,
        rounded_score: result.roundedScore,
        status_band: result.statusBand,
        data_confidence: result.dataConfidence,
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
    await supabase.from('financial_health_component_scores').delete().eq('score_id', scoreRow.id);
    await supabase.from('financial_health_component_scores').insert(
      result.components.map((c) => ({
        score_id: scoreRow.id,
        user_id: userId,
        component_code: c.code,
        raw_score: c.rawScore,
        adjusted_score: c.rawScore,
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

    await supabase.from('financial_health_recommendations').delete().eq('score_id', scoreRow.id);
    if (result.recommendations.length > 0) {
      await supabase.from('financial_health_recommendations').insert(
        result.recommendations.map((r) => ({
          score_id: scoreRow.id,
          user_id: userId,
          component_code: r.componentCode,
          priority: r.priority,
          title: r.title,
          explanation: r.explanation,
          estimated_score_improvement: r.estimatedScoreImprovement,
          estimated_financial_benefit: r.estimatedFinancialBenefit,
        }))
      );
    }
  }

  const history = (historyRes.data ?? []) as HealthScoreHistoryPoint[];

  return { ...result, previousScore, scoreChange, history };
}
