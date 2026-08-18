import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { getPublicMoneyUpdates } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { ResourcePublicCard } from '@/components/resources/public/ResourcePublicCard';
import { Pagination } from '@/components/resources/public/Pagination';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

// Spec §44: "Do not position it as breaking news."
export const metadata: Metadata = {
  title: 'Money Updates | FHIP Resources',
  description: 'Important financial developments, explained in plain English and connected to financial health.',
  alternates: { canonical: `${getPublicSiteBaseUrl()}/resources/money-updates` },
};

export default async function MoneyUpdatesIndexPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const supabase = await createClient();
  const result = await getPublicMoneyUpdates(supabase, { page });

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Resources', href: '/resources' }, { label: 'Money Updates' }]} />
      <div>
        <h1 className="text-3xl font-bold text-ink">Money Updates</h1>
        <p className="mt-2 max-w-2xl text-muted">Important financial developments, explained in plain English and connected to financial health.</p>
      </div>

      {result.items.length === 0 ? (
        <PublicEmptyState title="No Money Updates published yet." message="Check back soon for the latest developments." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((r) => (
              <ResourcePublicCard key={r.id} resource={r} />
            ))}
          </div>
          <Pagination page={result.page} totalPages={result.totalPages} buildHref={(p) => (p > 1 ? `/resources/money-updates?page=${p}` : '/resources/money-updates')} />
        </>
      )}
    </div>
  );
}
