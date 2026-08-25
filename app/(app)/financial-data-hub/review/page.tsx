import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { categoriesRepository } from '@/lib/financial-data-hub/repositories/index';
import { ReviewWorkspace } from './ReviewWorkspace';

/**
 * FDH-8 closure (spec Phase I) — the dedicated FDH-7 review destination
 * every "Review transactions" / "Review transaction" link across FDH-8 now
 * points to, replacing the disclosed fallback to the generic
 * `/financial-data-hub` upload screen.
 *
 * THIS IS NOT A NEW REVIEW ENGINE. Every action below (approve, correct
 * classification, confirm/reject transfer, confirm duplicate/keep both,
 * split, approve statement) calls the SAME, UNCHANGED FDH-7 API routes that
 * already existed before this closure pass
 * (`app/api/financial-data-hub/bank-transactions/**`,
 * `transaction-links/[linkId]/review`,
 * `recurring-transactions/[recurringId]/review`,
 * `documents/[documentId]/approve`) — this page is a thin UI wrapper around
 * FDH-7's own, already-certified services, exactly as the closure spec's
 * Phase I requires. Two small READ-ONLY lookup routes were added
 * (`transaction-links` and `duplicate-candidates`, both GET-only, both
 * filtered by `transaction_id`) so this page can discover which link/
 * candidate row applies to a focused transaction before calling the
 * existing action endpoint — no new mutation, no new approval semantics.
 *
 * Deep-link params (all server-authorised — a browser-supplied id is never
 * trusted as ownership proof; every fetch below is scoped to the
 * authenticated user via RLS + explicit `.eq('user_id', ...)` in the routes
 * themselves):
 *   ?transaction=<id>  — focus one transaction (from Overview/Transaction
 *                        Explorer/Pending disclosure)
 *   ?statement=<id>    — focus one statement's approval readiness
 *   ?reason=<type>     — hint which section of the general queue to open
 *                        first (transfers | duplicates | uncategorised |
 *                        recurring | needs_attention)
 */
export default async function FinancialDataHubReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ transaction?: string; statement?: string; reason?: string; account_id?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: categories, error: categoriesError } = await categoriesRepository.listActiveAll();
  if (categoriesError) throw new Error(categoriesError.message);
  const categoryOptions = (categories ?? [])
    .map((c) => ({ id: c.id, label: c.display_name, economicType: c.economic_type }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Review financial activity</h1>
        <p className="mt-1 text-sm text-muted">
          Machine-processed transactions wait here until you approve, correct or confirm them. Nothing below counts
          toward your approved income/expense totals until you act on it.
        </p>
      </div>
      <ReviewWorkspace
        initialTransactionId={sp.transaction ?? null}
        initialStatementId={sp.statement ?? null}
        initialReason={sp.reason ?? null}
        initialAccountId={sp.account_id ?? null}
        categories={categoryOptions}
      />
    </div>
  );
}
