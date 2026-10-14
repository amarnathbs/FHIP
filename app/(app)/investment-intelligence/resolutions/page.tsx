import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { ResolutionHistoryClient } from '@/components/investment-intelligence/ResolutionHistoryClient';

/**
 * 2026-09-28 owner-exception unification — this page is REPOINTED, not
 * deleted. It used to render PC5's `ResolutionCentreClient`
 * (`components/pc5/ResolutionCentreClient.tsx`), which reads
 * `aie_unresolved_item` via `/api/pc5/resolutions`. That table is only
 * populated by `lib/aie/adapters/investment-intelligence/dispatch.ts`,
 * which zero frontend components call — the REAL upload flow
 * (`/investment-intelligence/data`) exclusively runs
 * `documentProcessing.ts`, which writes to `ii_reconciliation_cases`
 * instead. So this page was permanently empty in production even with real
 * exceptions sitting in the database (found live, 2026-09-28).
 *
 * The Product Owner's decision: do not switch the live pipeline to the AIE
 * one; instead make `/investment-intelligence/review` (ReviewCentreClient)
 * the one place OPEN exceptions of every kind are decided, and repoint
 * THIS url — kept stable so no existing link breaks — to a HISTORY +
 * AMENDMENT view over the same `ii_reconciliation_cases` table: what has
 * already been decided, and a way to correct a past decision without ever
 * erasing it (see ResolutionHistoryClient.tsx and the `/amend` route for the
 * supersession discipline this reuses from PC5's own K.18).
 *
 * `components/pc5/ResolutionCentreClient.tsx`, `app/api/pc5/*` and
 * `AIE_REVIEW_PC5_PROJECTION_ENABLED` are left in place, untouched and now
 * unreferenced by any page — see this mission's closure report for why they
 * were not deleted in this pass (no production authority to also verify
 * nothing else depends on them; safe to remove in a later, dedicated pass).
 */
async function InvestmentResolutionsPageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Resolutions</h1>
        <p className="mt-1 text-sm text-muted">
          A history of decisions made on statement/owner exceptions — who a statement was assigned to, and when. Open questions are decided on the Review tab; a
          past decision here can be amended if it turns out to be wrong.
        </p>
      </header>
      <InvestmentIntelligenceSubNav />
      <ResolutionHistoryClient />
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Investment Intelligence).
export default function InvestmentResolutionsPage() {
  return (
    <>
      <PageBackLink href="/investment-intelligence" label="Investment Intelligence" />
      <InvestmentResolutionsPageContent />
    </>
  );
}
