import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { PerformanceClient } from '@/components/investment-intelligence/PerformanceClient';

// R4 — Performance & Benchmark UX (spec sections 60-65).
//
// Purely derived, read-only analytics. Nothing on this page writes to, or
// is read back into, any FHIP financial register or net worth figure.
// Every narrative string is an OBSERVATION or EDUCATION item; this page
// contains no recommendation, and no buy/sell/switch/rebalance guidance.
export default async function InvestmentPerformancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Investment performance</h1>
        <p className="mt-1 text-sm text-muted">
          How your investments have performed, how that compares with their benchmarks, and how much variability came with it. These figures describe
          what has already happened. They are not advice, and they are not a forecast.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <PerformanceClient />
    </div>
  );
}
