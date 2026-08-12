import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { loadResilience } from '@/lib/services/resilienceData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { getLatestRecommendations } from '@/lib/services/recommendationsData';
import { loadDataFreshness } from '@/lib/services/reportSnapshotResolver';
import { buildDataQuality } from '@/lib/engines/reportSections';
import { HealthScoreGauge } from '@/components/score/HealthScoreGauge';
import { ResilienceGauge } from '@/components/resilience/ResilienceGauge';
import { RiskRegister } from '@/components/resilience/RiskRegister';
import { VitalSignsStrip } from '@/components/dashboard/VitalSignsStrip';
import { PriorityActionsPanel } from '@/components/dashboard/PriorityActionsPanel';
import { DataQualityPanel } from '@/components/dashboard/DataQualityPanel';
import { FutureModulesSection } from '@/components/dashboard/placeholders';
import { DashboardGoalsCard } from '@/components/goals/DashboardGoalsCard';
import {
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

function BlockHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold text-ink">{children}</h2>;
}

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

  const { data: household } = await supabase
    .from('households')
    .select('household_name')
    .eq('user_id', user.id)
    .maybeSingle();

  const summary = await loadDashboard(user.id);
  const healthScore = await loadHealthScore(user.id);
  const resilience = await loadResilience(user.id, supabase);
  const { payload: goalsPayload } = await computeGoalsPagePayload(user.id);
  const recommendationMatches = await getLatestRecommendations(user.id, supabase);
  const dataFreshness = await loadDataFreshness(user.id, supabase);
  const dataQuality = buildDataQuality({ dashboard: summary, dataFreshness });

  return (
      <div className="space-y-10">
        {/* Context bar */}
        <div>
          <h1 className="text-2xl font-semibold text-ink">
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted">
            {household?.household_name && <span className="font-medium text-ink">{household.household_name}</span>}
            <span>{profile?.country_of_residence ?? '—'}</span>
            <span>{summary.currency}</span>
          </p>
        </div>

        {/* Health hero + four vital signs */}
        <section>
          <div className="relative">
            <HealthScoreGauge score={healthScore.overallScore} statusLabel={healthScore.statusLabel} statusBand={healthScore.statusBand} />
            <Link href="/score" className="mt-3 block text-center text-sm font-medium text-primary hover:underline">
              View full breakdown →
            </Link>
          </div>
          <div className="mt-6">
            <VitalSignsStrip summary={summary} />
          </div>
        </section>

        {/* Priority actions */}
        <section>
          <PriorityActionsPanel matches={recommendationMatches} />
        </section>

        {/* Trends */}
        <section>
          <BlockHeading>Trends</BlockHeading>
          <div className="space-y-6">
            <CashFlowSection summary={summary} />
            <NetWorthSection summary={summary} />
            <AssetAllocationSection summary={summary} />
            <InvestmentSection summary={summary} />
          </div>
        </section>

        {/* Plans */}
        <section>
          <BlockHeading>Plans</BlockHeading>
          <div className="space-y-6">
            <DashboardGoalsCard summary={goalsPayload.summary} currency={summary.currency} />
            <SavingsAnalyticsSection summary={summary} />
            <RetirementSection summary={summary} />
            <DebtAnalyticsSection summary={summary} />
          </div>
        </section>

        {/* Risks & protection */}
        <section>
          <BlockHeading>Risks &amp; Protection</BlockHeading>
          <div className="space-y-6">
            <div className="relative">
              <ResilienceGauge score={resilience.overallScore} statusLabel={resilience.statusLabel} statusBand={resilience.statusBand} />
              <Link href="/resilience" className="mt-3 block text-center text-sm font-medium text-primary hover:underline">
                View full resilience breakdown →
              </Link>
            </div>
            <RiskRegister risks={resilience.risks.slice(0, 3)} />
            <InsuranceSection summary={summary} />
            <FinancialTimelineSection summary={summary} />
            <FinancialRatiosSection summary={summary} />
          </div>
        </section>

        {/* Data quality */}
        <section>
          <DataQualityPanel dataQuality={dataQuality} dataConfidencePct={healthScore.dataConfidence} />
        </section>

        <div>
          <BlockHeading>Coming up next</BlockHeading>
          <FutureModulesSection />
        </div>
      </div>
  );
}
