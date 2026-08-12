import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { loadFinancialDna } from '@/lib/services/financialDnaData';
import {
  HeroCard,
  TraitBars,
  DriverList,
  StrengthsRisks,
  FocusActions,
  HistoryTimeline,
  Methodology,
  QuestionnairePlaceholder,
  MissingDataPanel,
} from '@/components/dna/sections';
import { DnaWhatIfSimulator } from '@/components/dna/WhatIfSimulator';

const HEALTH_SCORE_LINKS: Record<string, string> = {
  property_focused_investor: 'High property concentration can reduce your Net Worth & Investment Health component scores through concentration risk.',
  wealth_builder: 'Strong savings discipline directly supports your Cash Flow Health and Savings Behaviour component scores.',
  debt_constrained_builder: 'A high debt-service ratio reduces your Debt Health component score.',
  future_ready_professional: 'Regular retirement contributions support your Retirement Readiness component score.',
  cash_rich_accumulator: 'Strong liquidity supports your Emergency Fund & Liquidity component score, though low investment activity may hold back Investment Health.',
  lifestyle_optimiser: 'A lower savings rate tends to hold back your Savings Behaviour and Cash Flow Health component scores.',
  financial_stabiliser: 'Building essential cash flow and a starter emergency fund is likely to lift several Financial Health Score components at once.',
  retirement_focused_preserver: 'Low debt and stable passive income typically support your Debt Health and Retirement Readiness component scores.',
};

export default async function FinancialDnaPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', user.id).single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const payload = await loadFinancialDna(user.id);
  const primaryArchetype = payload.primaryProfileCode ? payload.archetypes[payload.primaryProfileCode] ?? null : null;
  const secondaryArchetype = payload.secondaryProfileCode ? payload.archetypes[payload.secondaryProfileCode] ?? null : null;

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Financial DNA™</h1>
          <p className="mt-1 text-muted">
            Your current financial pattern, explained — not a permanent label, and not a judgment.
          </p>
        </div>

        {payload.status === 'insufficient_data' ? (
          <MissingDataPanel status={payload.status} />
        ) : (
          <>
            <HeroCard
              archetype={primaryArchetype}
              secondaryArchetype={secondaryArchetype}
              primaryScore={payload.primaryScore}
              secondaryScore={payload.secondaryScore}
              confidence={payload.confidence}
              confidenceLabel={payload.confidenceLabel}
              profileChanged={payload.profileChanged}
              previousProfileCode={null}
              archetypes={payload.archetypes}
              currency={currency}
            />

            {payload.dataCompletenessPct < 100 && (
              <div className="rounded-card border border-dashed bg-gray-50 p-4 text-sm text-gray-600">
                Your current Financial DNA is indicative because some financial information is incomplete (
                {payload.dataCompletenessPct.toFixed(0)}% complete). Completing your profile will improve confidence.
              </div>
            )}

            <TraitBars traits={payload.traits} />
            <DriverList drivers={payload.drivers} />
            <StrengthsRisks strengths={payload.strengths} risks={payload.risks} />
            <FocusActions actions={payload.actions} />

            {primaryArchetype && HEALTH_SCORE_LINKS[primaryArchetype.profile_code] && (
              <SectionCard title="Link to Your Financial Health Score">
                <p className="text-sm text-gray-600">{HEALTH_SCORE_LINKS[primaryArchetype.profile_code]}</p>
                <p className="mt-2 text-xs text-muted">
                  Financial DNA describes your financial pattern; Financial Health Score measures your financial
                  health. A profile is not inherently good or bad — see your full breakdown on the Score page.
                </p>
              </SectionCard>
            )}

            <DnaWhatIfSimulator archetypes={payload.archetypes} />
            <HistoryTimeline history={payload.history} archetypes={payload.archetypes} />
            <Methodology modelVersion={payload.modelVersion} dataCompletenessPct={payload.dataCompletenessPct} />
            <QuestionnairePlaceholder />
          </>
        )}
      </div>
    </AppShell>
  );
}
