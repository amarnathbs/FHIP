import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import { dateFormatKeyForCountry } from '@/lib/engines/date';
import { ReviewCentreClient } from '@/components/investment-intelligence/ReviewCentreClient';

// R9 — Investment Review Centre (spec sections 39, 53-59).
//
// Every item shown here is a deterministic OBSERVATION, EDUCATION, or
// SIMULATION produced by re-reading already-certified data from Goals,
// Forecasting, and R4/R5/R6 Investment Intelligence — never a
// PERSONALISED_ADVICE-classified item, and never a value this page or its
// client component computed itself (spec sections 40-42, 130-131).
async function InvestmentReviewCentrePageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  // Dates on this page follow the user's own country (dd/mm/yyyy AU, dd-mm-yyyy India).
  const dateCurrency = dateFormatKeyForCountry(await getUserHomeCountry(user.id, supabase));

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
      <ReviewCentreClient dateCurrency={dateCurrency} />
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Investment Intelligence).
export default function InvestmentReviewCentrePage() {
  return (
    <>
      <PageBackLink href="/investment-intelligence" label="Investment Intelligence" />
      <InvestmentReviewCentrePageContent />
    </>
  );
}
