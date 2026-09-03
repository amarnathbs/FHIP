import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { ReviewCentreClient } from '@/components/investment-intelligence/ReviewCentreClient';

// R9 — Investment Review Centre (spec sections 39, 53-59).
//
// Every item shown here is a deterministic OBSERVATION, EDUCATION, or
// SIMULATION produced by re-reading already-certified data from Goals,
// Forecasting, and R4/R5/R6 Investment Intelligence — never a
// PERSONALISED_ADVICE-classified item, and never a value this page or its
// client component computed itself (spec sections 40-42, 130-131).
export default async function InvestmentReviewCentrePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Investment Review Centre</h1>
        <p className="mt-1 text-sm text-muted">
          What needs review across your goals, portfolio, and investment data — and why. Every item here links back to the certified data that produced it. This is
          not advice: it never tells you to buy, sell, or switch a specific investment.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <ReviewCentreClient />
    </div>
  );
}
