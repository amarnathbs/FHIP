import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { loadDashboard } from '@/lib/services/dashboardData';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { HealthScoreGauge } from '@/components/score/HealthScoreGauge';
import { FutureModulesSection } from '@/components/dashboard/placeholders';
import { DashboardGoalsCard } from '@/components/goals/DashboardGoalsCard';
import {
  ExecutiveSummary,
  CashFlowSection,
  NetWorthSection,
  SavingsAnalyticsSection,
  DebtAnalyticsSection,
  AssetAllocationSection,
  InvestmentSection,
  RetirementSection,
  InsuranceSection,
  FinancialRatiosSection,
  FinancialTimelineSection,
} from '@/components/dashboard/sections';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('full_name, profile_completion_percentage, preferred_currency, country_of_residence')
    .eq('user_id', user.id)
    .single();

  const summary = await loadDashboard(user.id);
  const healthScore = await loadHealthScore(user.id);
  const { payload: goalsPayload } = await computeGoalsPagePayload(user.id);

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-trust">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
          </h1>
          <p className="mt-1 text-gray-500">
            {profile?.country_of_residence ?? '—'} · {profile?.preferred_currency ?? '—'}
          </p>
        </div>

        <div className="relative">
          <HealthScoreGauge
            score={healthScore.overallScore}
            statusLabel={healthScore.statusLabel}
            statusBand={healthScore.statusBand}
          />
          <Link
            href="/score"
            className="mt-3 block text-center text-sm font-medium text-trust hover:underline"
          >
            View full breakdown →
          </Link>
        </div>

        <ExecutiveSummary summary={summary} />
        <CashFlowSection summary={summary} />
        <NetWorthSection summary={summary} />
        <SavingsAnalyticsSection summary={summary} />
        <DebtAnalyticsSection summary={summary} />
        <AssetAllocationSection summary={summary} />
        <InvestmentSection summary={summary} />
        <RetirementSection summary={summary} />
        <InsuranceSection summary={summary} />
        <FinancialRatiosSection summary={summary} />
        <DashboardGoalsCard summary={goalsPayload.summary} currency={summary.currency} />
        <FinancialTimelineSection summary={summary} />

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Coming up next</h2>
          <FutureModulesSection />
        </div>
      </div>
    </AppShell>
  );
}
