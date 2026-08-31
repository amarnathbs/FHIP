import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceClient } from '@/components/investment-intelligence/InvestmentIntelligenceClient';
import { ManualDirectPositionForm } from '@/components/investment-intelligence/ManualDirectPositionForm';

// R2 — minimal UI to prove the R2 workflow (spec section 31). NOT an R4+
// analytics dashboard: no performance/XIRR/benchmark content anywhere on
// this page, by design (spec section 32/48 — the performance-calculation
// firewall).
export default async function InvestmentIntelligencePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Investment Intelligence (India)</h1>
        <p className="mt-1 text-sm text-gray-600">
          Upload a CAMS or KFintech consolidated account statement to reconstruct and verify your mutual fund holdings. Once
          you publish a position from here, it is included in your FHIP net worth and Dashboard alongside your other
          Investments.
        </p>
      </div>
      <InvestmentIntelligenceClient />
      <ManualDirectPositionForm />
    </div>
  );
}
