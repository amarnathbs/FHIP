import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { TrendLineChart } from '@/components/dashboard/charts';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { HealthScoreStateCard } from '@/components/score/HealthScoreStateCard';
import { ComponentGrid } from '@/components/score/ComponentGrid';
import { ExplanationPanel } from '@/components/score/ExplanationPanel';
import { WhatIfSimulator } from '@/components/score/WhatIfSimulator';
import { CheckInsPanel } from '@/components/score/CheckInsPanel';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';
import { formatDateShort } from '@/lib/engines/date';

export default async function ScorePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('preferred_currency')
    .eq('user_id', user.id)
    .single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const { data: checkIns } = await supabase.from('health_check_ins').select('*').eq('user_id', user.id).maybeSingle();

  const payload = await loadHealthScore(user.id);
  const historySeries = payload.history.map((h) => ({
    month: new Date(h.score_month).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
    value: h.rounded_score,
  }));

  return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Financial Health Score</h1>
          <p className="mt-1 text-muted">
            One clear measure of your overall financial position, explained component by component.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <HealthScoreStateCard
              score={payload.overallScore}
              statusLabel={payload.statusLabel}
              statusBand={payload.statusBand}
              eligibility={payload.eligibility}
            />
          </div>
          <div className="lg:col-span-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Change vs last month</p>
              <p className="text-lg font-semibold text-ink">
                {payload.scoreChange !== null ? `${payload.scoreChange >= 0 ? '+' : ''}${payload.scoreChange.toFixed(1)}` : '—'}
              </p>
            </div>
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Financial data confidence</p>
              <p className="text-lg font-semibold capitalize text-ink">
                {payload.eligibility.confidenceTier} ({payload.eligibility.confidencePercent}%)
              </p>
              <p className="text-xs text-muted">
                {payload.eligibility.reviewedSections} of {payload.eligibility.totalRelevantSections} sections reviewed
              </p>
            </div>
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Last calculated</p>
              <p className="text-lg font-semibold text-ink">{formatDateShort(new Date(), currency)}</p>
            </div>
            {payload.riskOverrideApplied && (
              <div className="col-span-2 rounded-card border border-risk bg-red-50 p-4 text-sm text-risk sm:col-span-3">
                {payload.riskOverrideReason}
              </div>
            )}
          </div>
        </div>

        <SectionCard title="Score History">
          <TrendLineChart data={historySeries} currency={currency} />
        </SectionCard>

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Component Breakdown</h2>
          <ComponentGrid components={payload.components} />
        </div>

        <ExplanationPanel
          positives={payload.positiveContributors}
          reductions={payload.reductions}
          recommendations={payload.recommendations}
        />

        <WhatIfSimulator currency={currency} />

        <CheckInsPanel initial={checkIns} currency={currency} />

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Coming up next</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LockedFeatureCard
              title="Score Benchmark Comparison"
              description="See how your overall Financial Health Score compares to households like yours. Your Financial Twin already benchmarks individual metrics (savings rate, net worth, debt, retirement) — this adds the composite score itself."
            />
            <LockedFeatureCard
              title="AI Commentary"
              description="A plain-English summary of your results, generated from the calculated score — never calculated by AI itself. Arrives with a future AI Coach update."
            />
          </div>
        </div>
      </div>
  );
}
