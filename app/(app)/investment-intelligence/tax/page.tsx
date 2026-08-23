import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { TaxIntelligenceClient } from '@/components/investment-intelligence/TaxIntelligenceClient';

// R6-FINAL — minimal live UX for India Tax & Cost Intelligence (spec
// Section 27), mirroring the R4/R5 page shape exactly (server component
// gates auth, delegates all data/interaction to a 'use client' component).
//
// SIMULATION ONLY — every figure below carries the engine's own disclaimer.
// This page never recommends selling, switching, or timing a redemption; it
// only observes, estimates, and simulates hypothetical scenarios the user
// explicitly asks for.
export default async function TaxIntelligencePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">India tax &amp; cost intelligence</h1>
        <p className="mt-1 text-sm text-muted">
          Estimated capital-gains figures for your recorded mutual-fund redemptions and switches, plus a redemption simulator for hypothetical scenarios. This is
          a planning estimate only, not tax advice and not a filed-return figure — verify every number with a Chartered Accountant before relying on it.
        </p>
      </header>
      <TaxIntelligenceClient />
    </div>
  );
}
