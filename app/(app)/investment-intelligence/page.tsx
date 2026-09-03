import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { OverviewClient } from '@/components/investment-intelligence/OverviewClient';

// II-PC2 — the Investment Intelligence workspace OVERVIEW (spec sections 10,
// 64).
//
// WHAT CHANGED AND WHY
// --------------------
// Until PC2 this route was the R2 statement-import utility. That made the
// entire analytics estate (performance, recurring investments, fund holdings,
// tax & cost, review) reachable only by typing a URL, so a user could publish
// investments successfully and still conclude "I cannot see any investment
// analysis" (spec section 0).
//
// The import workflow is NOT removed — it moved, unchanged, to
// /investment-intelligence/data, where it is the second item in the
// workspace's own persistent sub-navigation.
//
// This page renders NO analytical figure of its own (spec section 11). It
// aggregates already-persisted statuses and counts and points at the
// certified page for every actual number.
export default async function InvestmentIntelligencePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Investment Intelligence (India)</h1>
        <p className="mt-1 text-sm text-muted">
          Your Indian investment evidence, reconstructed from your statements and reconciled before any figure is used. Everything here describes what
          you already hold and what has already happened — it is not advice, and it is not a forecast.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <OverviewClient />
    </div>
  );
}
