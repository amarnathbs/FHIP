import { createClient } from '@/lib/supabase/server';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import {
  classifyFinancialDna,
  MODEL_VERSION,
  type DnaConfig,
  type DnaProfileInput,
  type DnaResult,
} from '@/lib/engines/financialDna';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export interface DnaHistoryPoint {
  profile_month: string;
  primary_profile_code: string;
  secondary_profile_code: string | null;
  confidence_score: number;
}

export interface Archetype {
  profile_code: string;
  profile_name: string;
  short_description: string;
  long_description: string;
  icon: string | null;
}

export interface FinancialDnaPayload extends DnaResult {
  archetypes: Record<string, Archetype>;
  history: DnaHistoryPoint[];
}

// Builds the classification input without persisting — used by the real GET
// route (which persists afterwards) and the what-if scenario endpoint (which
// never persists).
export async function buildDnaInput(userId: string, client?: SupabaseServerClient): Promise<DnaProfileInput> {
  const supabase = client ?? (await createClient());

  const [profileRes, householdRes, configRes, previousRes] = await Promise.all([
    supabase.from('user_profiles').select('date_of_birth, employment_status').eq('user_id', userId).single(),
    supabase.from('households').select('dependants_count').eq('user_id', userId).maybeSingle(),
    supabase.from('financial_dna_config').select('config').eq('is_active', true).single(),
    supabase
      .from('financial_dna_profiles')
      .select('primary_profile_code')
      .eq('user_id', userId)
      .order('profile_month', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const dashboard = await loadDashboard(userId, supabase);
  const employmentStatus = profileRes.data?.employment_status ?? '';
  const isSelfEmployed = /self.?employed/i.test(employmentStatus);
  const isRetired = /retired/i.test(employmentStatus);

  return {
    dashboard,
    age: ageFromDob(profileRes.data?.date_of_birth ?? null),
    dependantsCount: householdRes.data?.dependants_count ?? 0,
    isSelfEmployed,
    isRetired,
    config: configRes.data?.config as DnaConfig,
    previousProfileCode: previousRes.data?.primary_profile_code ?? null,
  };
}

export async function loadArchetypes(client?: SupabaseServerClient): Promise<Record<string, Archetype>> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('financial_dna_archetypes')
    .select('profile_code, profile_name, short_description, long_description, icon')
    .eq('is_active', true);
  const map: Record<string, Archetype> = {};
  for (const row of data ?? []) map[row.profile_code] = row as Archetype;
  return map;
}

export async function loadFinancialDna(userId: string, client?: SupabaseServerClient): Promise<FinancialDnaPayload> {
  const supabase = client ?? (await createClient());

  const [input, archetypes, historyRes] = await Promise.all([
    buildDnaInput(userId, supabase),
    loadArchetypes(supabase),
    supabase
      .from('financial_dna_profiles')
      .select('profile_month, primary_profile_code, secondary_profile_code, confidence_score')
      .eq('user_id', userId)
      .order('profile_month', { ascending: true })
      .limit(12),
  ]);

  const result = classifyFinancialDna(input);

  if (result.primaryProfileCode) {
    const { data: profileRow } = await supabase
      .from('financial_dna_profiles')
      .upsert(
        {
          user_id: userId,
          profile_month: monthStart(),
          primary_profile_code: result.primaryProfileCode,
          primary_compatibility_score: result.primaryScore,
          secondary_profile_code: result.secondaryProfileCode,
          secondary_compatibility_score: result.secondaryScore,
          confidence_score: result.confidence,
          confidence_band: result.confidenceBand,
          status: result.status,
          profile_changed: result.profileChanged,
          previous_profile_code: input.previousProfileCode,
          model_version: MODEL_VERSION,
          data_completeness_pct: result.dataCompletenessPct,
        },
        { onConflict: 'user_id,profile_month' }
      )
      .select('id')
      .single();

    if (profileRow) {
      await supabase.from('financial_dna_profile_scores').delete().eq('dna_profile_id', profileRow.id);
      await supabase.from('financial_dna_profile_scores').insert(
        result.candidates.map((c, i) => ({
          dna_profile_id: profileRow.id,
          user_id: userId,
          candidate_profile_code: c.code,
          raw_score: c.score,
          adjusted_score: c.score,
          rank: i + 1,
          eligible: c.eligible,
          exclusion_reason: c.exclusionReason,
          dimension_scores: c.dimensionScores,
        }))
      );

      await supabase.from('financial_dna_drivers').delete().eq('dna_profile_id', profileRow.id);
      const allDrivers = [
        ...result.drivers.map((d, i) => ({ ...d, display_rank: i })),
        ...result.strengths.map((d, i) => ({ ...d, display_rank: i })),
        ...result.risks.map((d, i) => ({ ...d, display_rank: i })),
      ];
      if (allDrivers.length > 0) {
        await supabase.from('financial_dna_drivers').insert(
          allDrivers.map((d) => ({
            dna_profile_id: profileRow.id,
            user_id: userId,
            driver_type: d.type,
            metric_code: d.metricCode,
            metric_value: d.metricValue,
            threshold_value: d.thresholdValue,
            contribution: d.contribution,
            display_rank: d.display_rank,
            explanation: d.explanation,
          }))
        );
      }

      await supabase.from('financial_dna_actions').delete().eq('dna_profile_id', profileRow.id);
      if (result.actions.length > 0) {
        await supabase.from('financial_dna_actions').insert(
          result.actions.map((a) => ({
            dna_profile_id: profileRow.id,
            user_id: userId,
            action_code: a.code,
            title: a.title,
            explanation: a.explanation,
            priority: a.priority,
            related_module: a.relatedModule,
            related_metric: a.relatedMetric,
            estimated_effect: a.estimatedEffect,
          }))
        );
      }
    }
  }

  return { ...result, archetypes, history: (historyRes.data ?? []) as DnaHistoryPoint[] };
}
