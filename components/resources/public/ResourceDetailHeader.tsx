// Shared detail-page header: breadcrumb + H1 + reader-facing metadata line.
// Spec §98: "Each detail page should contain exactly one page-level H1. Body
// content starts at H2." — the H1 here is the only H1 on any detail page;
// BlockRenderer's own heading blocks are capped at H2-H4 (lib/resources/
// editor/blocks.ts's HeadingData.level type), so this invariant holds
// structurally, not just by convention.
// Spec §101-103: never renders status/compliance-classification badges —
// only the content-type label (a reader-relevant fact) and dates/author.

import { ResourceTypeLabel, JurisdictionLabel } from './ResourceTypeLabel';
import { ShareButton } from './ShareButton';
import { formatPublicDate } from '@/lib/resources/public/metadata';
import type { ResourceContentType, ResourceJurisdiction, ResourceDifficulty } from '@/lib/resources/types';
import { JURISDICTION_LABELS } from '@/lib/resources/admin/labels';

const DIFFICULTY_LABELS: Record<ResourceDifficulty, string> = {
  beginner: 'Beginner',
  beginner_intermediate: 'Beginner–Intermediate',
  intermediate: 'Intermediate',
  intermediate_advanced: 'Intermediate–Advanced',
  advanced: 'Advanced',
};

export function ResourceDetailHeader({
  contentType,
  title,
  excerpt,
  jurisdiction,
  difficulty,
  publishedAt,
  updatedAt,
  authorName,
  shareUrl,
}: {
  contentType: ResourceContentType;
  title: string;
  excerpt: string | null;
  jurisdiction: ResourceJurisdiction;
  difficulty: string | null;
  publishedAt: string | null;
  updatedAt: string;
  authorName: string | null;
  // The public canonical URL for this post (buildResourceCanonicalUrl(slug)
  // from the page component) — optional so this header still renders for
  // any caller that hasn't computed one, but every real detail page passes
  // it, since sharing a page without a working canonical URL isn't useful.
  shareUrl?: string;
}) {
  const publishedLabel = formatPublicDate(publishedAt);
  const updatedLabel = formatPublicDate(updatedAt);
  // Spec §55: "Published ... Updated ..." only when meaningfully different
  // (same-day publish/update would just say Published).
  const showUpdated = updatedLabel && publishedLabel && updatedLabel !== publishedLabel;

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeLabel contentType={contentType} />
          <JurisdictionLabel jurisdiction={jurisdiction} className="text-xs text-muted" />
          {difficulty && <span className="text-xs text-muted">{DIFFICULTY_LABELS[difficulty as ResourceDifficulty] ?? difficulty}</span>}
        </div>
        {shareUrl && <ShareButton url={shareUrl} title={title} />}
      </div>
      <h1 className="text-3xl font-bold leading-tight text-ink sm:text-4xl">{title}</h1>
      {excerpt && <p className="text-lg leading-relaxed text-muted">{excerpt}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {authorName && <span>By {authorName}</span>}
        {publishedLabel && <span>Published {publishedLabel}</span>}
        {showUpdated && <span>Updated {updatedLabel}</span>}
        <span className="sr-only">{JURISDICTION_LABELS[jurisdiction]}</span>
      </div>
    </header>
  );
}
