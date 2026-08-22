// Reusable public Resource card — spec §27/§28. Deliberately does not show
// internal metadata (no status/compliance badge — spec §101-103).

import Link from 'next/link';
import { ResourceTypeLabel, JurisdictionLabel } from './ResourceTypeLabel';
import { formatPublicDate } from '@/lib/resources/public/metadata';
import type { PublicResourceCard } from '@/lib/resources/public/queries';
import type { ResourceContentType, ResourceJurisdiction } from '@/lib/resources/types';

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ResourcePublicCard({ resource }: { resource: PublicResourceCard }) {
  if (!resource.slug) return null; // unpublished/unslugged rows are never handed to this component by a public query, but stay defensive rather than link to "/resources/null"

  const dateLabel = formatPublicDate(resource.event_date ?? resource.published_at);
  const duration = formatDuration(resource.video?.duration_seconds ?? null);

  return (
    <Link
      href={`/resources/${resource.slug}`}
      className="group flex flex-col overflow-hidden rounded-card border border-line bg-white transition hover:border-trust/40 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust"
    >
      {resource.content_type === 'video' && resource.video?.thumbnail_url && (
        <div className="relative aspect-video w-full overflow-hidden bg-gray-100">
          {/* eslint-disable-next-line @next/next/no-img-element -- external YouTube-hosted thumbnail URL, not a local/optimizable asset */}
          <img src={resource.video.thumbnail_url} alt="" className="h-full w-full object-cover" loading="lazy" />
          {duration && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">{duration}</span>}
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeLabel contentType={resource.content_type as ResourceContentType} />
          {resource.primary_category && <span className="text-xs text-muted">{resource.primary_category.name}</span>}
        </div>
        <h3 className="text-base font-semibold leading-snug text-ink group-hover:text-trust">{resource.title}</h3>
        {resource.excerpt && <p className="line-clamp-3 text-sm leading-relaxed text-muted">{resource.excerpt}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted">
          <JurisdictionLabel jurisdiction={resource.jurisdiction as ResourceJurisdiction} />
          {dateLabel && <span>{dateLabel}</span>}
        </div>
      </div>
    </Link>
  );
}
