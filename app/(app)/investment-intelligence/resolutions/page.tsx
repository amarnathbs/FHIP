import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { ResolutionCentreClient } from '@/components/pc5/ResolutionCentreClient';

/**
 * PC5 (M4) — the guided resolution surface (K.2, K.13, K.16).
 *
 * SEPARATE FROM `/investment-intelligence/review` ON PURPOSE. That page is
 * the R9 Review Centre: deterministic ADVISORY observations over
 * already-certified data, none of which blocks anything, all of which may
 * legitimately be acknowledged or dismissed. This page is the opposite kind
 * of thing — BLOCKING questions about statements that cannot be imported
 * until they are answered, where dismissal is not permitted at all.
 * Merging them would let a user dismiss their way through a mixed queue and
 * then wonder why a statement still refused to import.
 */
export default async function InvestmentResolutionsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { run } = await searchParams;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Statement questions</h1>
        <p className="mt-1 text-sm text-muted">
          Some statements need a decision from you before their holdings can be added to your portfolio — usually because we could not be certain whose account a
          statement is for, or because two readings of it disagree. Nothing here is guesswork on our part: we ask rather than assume.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <ResolutionCentreClient runId={run} />
    </div>
  );
}
