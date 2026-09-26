import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { categoriesRepository } from '@/lib/financial-data-hub/repositories/index';
import { ReviewWorkspace } from './ReviewWorkspace';
import { StatementCategoryReview } from './StatementCategoryReview';

/**
 * FDH-8 closure (spec Phase I) — the dedicated FDH-7 review destination
 * every "Review transactions" / "Review transaction" link across FDH-8 now
 * points to.
 *
 * THIS IS NOT A NEW REVIEW ENGINE. Every action calls FDH-7/R8's existing
 * services through their API routes (see ReviewWorkspace.tsx and
 * StatementCategoryReview.tsx).
 *
 * Deep-link params (all server-authorised — a browser-supplied id is never
 * trusted as ownership proof; every fetch is scoped to the authenticated
 * user via RLS + explicit `.eq('user_id', ...)` in the routes themselves):
 *   ?statement=<id>    — the category-totals review of one imported
 *                        statement (2026-09-26): approve category totals,
 *                        decide only the lines that need a person
 *   ?transaction=<id>  — focus one transaction
 *   ?reason=<type>     — open the general queue on one tile's list
 *   ?from=<place>      — where the "Back to ..." link returns to
 *                        (expenses | activity | hub; default expenses,
 *                        because bank statements are imported from Expenses)
 */
const RETURN_TARGETS: Record<string, { href: string; label: string }> = {
  expenses: { href: '/expenses', label: 'Back to Expenses' },
  activity: { href: '/financial-data-hub/activity', label: 'Back to Financial Activity' },
  hub: { href: '/financial-data-hub', label: 'Back to Financial Data Hub' },
};

export default async function FinancialDataHubReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ transaction?: string; statement?: string; reason?: string; account_id?: string; from?: string }>;
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
    .filter((c) => c.economic_type !== 'unknown')
    .map((c) => ({ id: c.id, label: c.display_name, economicType: c.economic_type }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const backTarget = RETURN_TARGETS[sp.from ?? ''] ?? RETURN_TARGETS.expenses;
  const fromParam = sp.from && RETURN_TARGETS[sp.from] ? sp.from : 'expenses';

  return (
    <div className="space-y-6">
      <nav aria-label="Return">
        <Link href={backTarget.href} className="text-sm font-semibold text-trust hover:underline">
          ← {backTarget.label}
        </Link>
      </nav>
      {sp.statement ? (
        <StatementCategoryReview
          statementId={sp.statement}
          categories={categoryOptions}
          backHref={backTarget.href}
          backLabel={backTarget.label}
          fromParam={fromParam}
        />
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold text-ink">Review your imported transactions</h1>
            <p className="mt-1 text-sm text-muted">
              Imported transactions wait here until you approve them. Only approved transactions count toward your
              income, spending and Monthly Surplus.
            </p>
          </div>
          <ReviewWorkspace
            initialTransactionId={sp.transaction ?? null}
            initialReason={sp.reason ?? null}
            initialAccountId={sp.account_id ?? null}
            fromParam={fromParam}
            categories={categoryOptions}
          />
        </>
      )}
    </div>
  );
}
