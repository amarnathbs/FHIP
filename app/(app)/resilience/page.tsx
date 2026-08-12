import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { TrendLineChart } from '@/components/dashboard/charts';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';
import { loadResilience } from '@/lib/services/resilienceData';
import { ResilienceGauge } from '@/components/resilience/ResilienceGauge';
import { ComponentGrid } from '@/components/resilience/ComponentGrid';
import { EmergencyFundDetail } from '@/components/resilience/EmergencyFundDetail';
import { RiskRegister } from '@/components/resilience/RiskRegister';
import { ActionPlan } from '@/components/resilience/ActionPlan';
import { CommitmentsManager, type Commitment } from '@/components/resilience/CommitmentsManager';
import { StressTestPanel } from '@/components/resilience/StressTestPanel';
import { Methodology } from '@/components/resilience/Methodology';
import { formatDateShort } from '@/lib/engines/date';

export default async function ResiliencePage() {
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

  const { data: commitments } = await supabase
    .from('future_financial_commitments')
    .select('id, commitment_name, category, amount, due_date, is_mandatory, notes')
    .eq('user_id', user.id)
    .eq('is_active', true);

  const payload = await loadResilience(user.id);
  const historySeries = payload.history.map((h) => ({
    month: new Date(h.score_month).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
    value: h.rounded_score,
  }));
  const emergencyFundComponent = payload.components.find((c) => c.code === 'emergency_fund');

  return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Financial Resilience™</h1>
          <p className="mt-1 text-muted">
            How well your household could absorb a financial shock — job loss, an unexpected bill, or a market
            downturn — today.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <ResilienceGauge score={payload.overallScore} statusLabel={payload.statusLabel} statusBand={payload.statusBand} />
          </div>
          <div className="lg:col-span-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Change vs last month</p>
              <p className="text-lg font-semibold text-ink">
                {payload.scoreChange !== null ? `${payload.scoreChange >= 0 ? '+' : ''}${payload.scoreChange.toFixed(1)}` : '—'}
              </p>
            </div>
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Confidence</p>
              <p className="text-lg font-semibold text-ink">{payload.confidence.toFixed(0)}%</p>
            </div>
            <div className="rounded-card border bg-white p-4">
              <p className="text-xs text-muted">Last calculated</p>
              <p className="text-lg font-semibold text-ink">{formatDateShort(new Date(), currency)}</p>
            </div>
            {payload.confidence < 70 && (
              <div className="col-span-2 rounded-card border border-dashed bg-gray-50 p-4 text-sm text-gray-600 sm:col-span-3">
                This score is provisional because important financial information is missing. Complete more of your
                data (Income, Expenses, Assets, Liabilities, Insurance) for a more reliable result.
              </div>
            )}
            {payload.riskOverrideApplied && (
              <div className="col-span-2 rounded-card border border-risk bg-red-50 p-4 text-sm text-risk sm:col-span-3">
                {payload.riskOverrideReason}
              </div>
            )}
          </div>
        </div>

        <SectionCard title="Resilience History">
          <TrendLineChart data={historySeries} currency={currency} />
        </SectionCard>

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Component Breakdown</h2>
          <ComponentGrid components={payload.components} />
        </div>

        <EmergencyFundDetail component={emergencyFundComponent} currency={currency} />

        <RiskRegister risks={payload.risks} />

        <ActionPlan actions={payload.actions} />

        <CommitmentsManager initial={(commitments as Commitment[]) ?? []} currency={currency} />

        <StressTestPanel currency={currency} />

        <Methodology confidence={payload.confidence} />

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Coming up next</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LockedFeatureCard
              title="Household vs Individual View"
              description="Toggle resilience calculations between the whole household and a single member. Arrives with Module 11 (Personalization)."
            />
            <LockedFeatureCard
              title="Resilience Questionnaire"
              description="A short optional questionnaire about your financial safety-net attitudes and history, to sharpen confidence further. Kept as a placeholder for a fast-follow so it isn't forgotten."
            />
          </div>
        </div>
      </div>
  );
}
