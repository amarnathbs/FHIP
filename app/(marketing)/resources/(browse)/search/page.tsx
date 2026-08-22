import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { searchPublicResources } from '@/lib/resources/search/queries';
import { normalizeSearchQuery, normalizeContentTypeFilter, normalizeJurisdictionFilter } from '@/lib/resources/search/validation';
import { getPublicCategories } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { SearchBox } from '@/components/resources/public/SearchBox';
import { SearchFilterBar } from '@/components/resources/public/SearchFilterBar';
import { ResourcePublicCard } from '@/components/resources/public/ResourcePublicCard';
import { Pagination } from '@/components/resources/public/Pagination';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

type Search = { q?: string; type?: string; jurisdiction?: string; category?: string; page?: string };

// spec §69's search entry points all resolve to this one canonical route
// (spec §11: "Search query must live in the URL"). Never indexed under a
// query-string variant — every /resources/search URL points back at the
// same canonical, unparameterised page for SEO purposes (spec doesn't
// require search results to be indexable; noindex keeps them out of
// crawl/duplicate-content concerns entirely).
export const metadata: Metadata = {
  title: 'Search | FHIP Resources',
  description: 'Search FHIP’s Financial Knowledge & Insights library — articles, guides, FHIP explainers, videos, glossary terms and money updates.',
  alternates: { canonical: `${getPublicSiteBaseUrl()}/resources/search` },
  robots: { index: false, follow: true },
};

export default async function ResourcesSearchPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const supabase = await createClient();

  const q = normalizeSearchQuery(params.q);
  const contentType = normalizeContentTypeFilter(params.type);
  const jurisdiction = normalizeJurisdictionFilter(params.jurisdiction);
  const categoryId = params.category && params.category.trim() ? params.category.trim() : 'all';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const topics = await getPublicCategories(supabase);

  // spec §21: an empty query never reaches the DB at all.
  const result = q ? await searchPublicResources(supabase, { q, contentType, jurisdiction, categoryId: categoryId === 'all' ? null : categoryId, page }) : null;

  function buildHref(targetPage: number) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (contentType !== 'all') p.set('type', contentType);
    if (jurisdiction !== 'all') p.set('jurisdiction', jurisdiction);
    if (categoryId !== 'all') p.set('category', categoryId);
    if (targetPage > 1) p.set('page', String(targetPage));
    const qs = p.toString();
    return qs ? `/resources/search?${qs}` : '/resources/search';
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Resources', href: '/resources' }, { label: 'Search' }]} />

      <div>
        <h1 className="text-3xl font-bold text-ink">Search Financial Knowledge &amp; Insights</h1>
        <div className="mt-4">
          <SearchBox defaultValue={q} variant="full" placeholder="Search financial topics, terms and guides" />
        </div>
      </div>

      <SearchFilterBar contentType={contentType} jurisdiction={jurisdiction} categoryId={categoryId} topics={topics.map((t) => ({ id: t.id, name: t.name }))} />

      {!q && <PublicEmptyState title="Search our financial knowledge library." message="Try a term like &ldquo;emergency fund&rdquo;, &ldquo;savings rate&rdquo; or &ldquo;net worth&rdquo;." />}

      {q && result && result.items.length === 0 && (
        <div className="rounded-card border border-dashed border-line bg-white p-10 text-center">
          <p className="font-semibold text-ink">We couldn&rsquo;t find anything matching your search.</p>
          <p className="mt-1 text-sm text-muted">Try different words, or:</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm">
            <Link href="/resources/search" className="rounded-compact border border-line px-3 py-1.5 font-semibold text-ink hover:border-trust hover:text-trust">
              Clear search
            </Link>
            <Link href="/resources" className="rounded-compact border border-line px-3 py-1.5 font-semibold text-ink hover:border-trust hover:text-trust">
              Browse topics
            </Link>
            <Link href="/resources/glossary" className="rounded-compact border border-line px-3 py-1.5 font-semibold text-ink hover:border-trust hover:text-trust">
              Browse the Glossary
            </Link>
          </div>
        </div>
      )}

      {q && result && result.items.length > 0 && (
        <>
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {result.total} {result.total === 1 ? 'result' : 'results'} for &ldquo;{q}&rdquo;
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((r) => (
              <ResourcePublicCard key={r.id} resource={r} />
            ))}
          </div>
          <Pagination page={result.page} totalPages={result.totalPages} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
