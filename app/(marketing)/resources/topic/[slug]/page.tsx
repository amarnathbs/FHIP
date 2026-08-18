import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getPublicCategoryBySlug, getPublicResourcesByTopic, type PublicJurisdictionFilter, type PublicTypeFilter } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { ResourcePublicCard } from '@/components/resources/public/ResourcePublicCard';
import { TopicFilterBar } from '@/components/resources/public/TopicFilterBar';
import { Pagination } from '@/components/resources/public/Pagination';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

type Params = { slug: string };
type Search = { jurisdiction?: string; type?: string; page?: string };

const VALID_JURISDICTIONS = ['all', 'global', 'australia', 'india', 'australia_india_cross_border'];
const VALID_TYPES = ['all', 'article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update'];

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const category = await getPublicCategoryBySlug(supabase, slug);
  if (!category) return {};
  const canonical = `${getPublicSiteBaseUrl()}/resources/topic/${slug}`;
  return {
    title: `${category.name} | FHIP Resources`,
    description: category.description || `Financial education resources on ${category.name}.`,
    alternates: { canonical },
  };
}

// Spec §72: an unknown topic slug returns proper not-found behaviour.
export default async function TopicPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  const category = await getPublicCategoryBySlug(supabase, slug);
  if (!category) notFound();

  const jurisdiction = (VALID_JURISDICTIONS.includes(search.jurisdiction ?? '') ? search.jurisdiction : 'all') as PublicJurisdictionFilter;
  const type = (VALID_TYPES.includes(search.type ?? '') ? search.type : 'all') as PublicTypeFilter;
  const page = Math.max(1, Number.parseInt(search.page ?? '1', 10) || 1);

  const result = await getPublicResourcesByTopic(supabase, category.id, { jurisdiction, type, page });

  function buildHref(targetPage: number) {
    const params = new URLSearchParams();
    if (jurisdiction !== 'all') params.set('jurisdiction', jurisdiction);
    if (type !== 'all') params.set('type', type);
    if (targetPage > 1) params.set('page', String(targetPage));
    const qs = params.toString();
    return qs ? `/resources/topic/${slug}?${qs}` : `/resources/topic/${slug}`;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Resources', href: '/resources' }, { label: category.name }]} />

      <div>
        <h1 className="text-3xl font-bold text-ink">{category.name}</h1>
        {category.description && <p className="mt-2 max-w-2xl text-muted">{category.description}</p>}
      </div>

      <TopicFilterBar jurisdiction={jurisdiction} type={type} />

      {result.items.length === 0 ? (
        <PublicEmptyState title="No Resources match these filters yet." message="Try a different jurisdiction or content type, or check back soon." />
      ) : (
        <>
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
