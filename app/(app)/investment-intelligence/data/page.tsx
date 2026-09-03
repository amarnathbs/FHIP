import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { InvestmentIntelligenceClient } from '@/components/investment-intelligence/InvestmentIntelligenceClient';
import { ManualDirectPositionForm } from '@/components/investment-intelligence/ManualDirectPositionForm';

// II-PC2 — Statements & data (spec sections 9, 14).
//
// This is the R2/R3 source-document workflow that previously lived at
// /investment-intelligence, moved here BEHAVIOURALLY UNCHANGED so the root
// route can become the workspace Overview (spec section 10). Both client
// components below are the same ones that route rendered; PC2 re-homes them
// and gives them the workspace sub-navigation, it does not rewrite the
// upload/reconcile/certify/publish flow.
//
// Spec section 9 allows Data & Import to be "either root section or an
// explicit sub-route if repository architecture supports it cleanly". A
// sub-route is the clean option here: the import workflow is a substantial
// stateful client component, and nesting it under an Overview that must stay
// cheap (spec section 40) would have coupled the two.
export default async function InvestmentIntelligenceDataPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Statements &amp; data</h1>
        <p className="mt-1 text-sm text-muted">
          Upload a CAMS or KFintech consolidated account statement to reconstruct and verify your mutual fund holdings, resolve any data issues, and
          publish a certified position. Once you publish a position it is included in your FHIP net worth and Dashboard alongside your other
          investments.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <InvestmentIntelligenceClient />
      <ManualDirectPositionForm />
    </div>
  );
}
