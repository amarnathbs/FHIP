import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { getPublicVideos } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { ResourcePublicCard } from '@/components/resources/public/ResourcePublicCard';
import { Pagination } from '@/components/resources/public/Pagination';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

export const metadata: Metadata = {
  title: '@GKTC Videos | FHIP Resources',
  description: 'Financial education videos, part of FHIP’s Resources and hosted on @GKTC YouTube.',
  alternates: { canonical: `${getPublicSiteBaseUrl()}/resources/videos` },
};

export default async function VideosIndexPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const supabase = await createClient();
  const result = await getPublicVideos(supabase, { page });

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Resources', href: '/resources' }, { label: '@GKTC Videos' }]} />
      <div>
        <h1 className="text-3xl font-bold text-ink">@GKTC Videos</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Financial education videos, part of FHIP&rsquo;s Resources and hosted on <span className="font-semibold">@GKTC</span> YouTube.
        </p>
      </div>

      {result.items.length === 0 ? (
        <PublicEmptyState title="No videos published yet." message="Check back soon for new @GKTC videos." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((r) => (
              <ResourcePublicCard key={r.id} resource={r} />
            ))}
          </div>
          <Pagination page={result.page} totalPages={result.totalPages} buildHref={(p) => (p > 1 ? `/resources/videos?page=${p}` : '/resources/videos')} />
        </>
      )}
    </div>
  );
}
