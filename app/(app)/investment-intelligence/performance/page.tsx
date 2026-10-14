import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { PerformanceClient } from '@/components/investment-intelligence/PerformanceClient';
import { PriceHistoryGate } from '@/components/investment-intelligence/PriceHistoryGate';

// R4 — Performance & Benchmark UX (spec sections 60-65).
//
// Purely derived, read-only analytics. Nothing on this page writes to, or
// is read back into, any FHIP financial register or net worth figure.
// Every narrative string is an OBSERVATION or EDUCATION item; this page
// contains no recommendation, and no buy/sell/switch/rebalance guidance.
async function InvestmentPerformancePageContent() {
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
      {/* PO 2026-10-03: no partial figures while the price history of the user's funds is still loading. */}
      <PriceHistoryGate>
        <PerformanceClient />
      </PriceHistoryGate>
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Investment Intelligence).
export default function InvestmentPerformancePage() {
  return (
    <>
      <PageBackLink href="/investment-intelligence" label="Investment Intelligence" />
      <InvestmentPerformancePageContent />
    </>
  );
}
