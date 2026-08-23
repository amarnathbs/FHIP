// R1.6 — spec §38: reusable "Continue learning" / "Related Resources"
// section. Reuses ResourcePublicCard unmodified (spec §73's reuse principle
// applies here too, not just to search).

import { ResourcePublicCard } from './ResourcePublicCard';
import type { RelatedResourceCard } from '@/lib/resources/discovery/related';
import type { PublicResourceCard } from '@/lib/resources/public/queries';

function toPublicCard(r: RelatedResourceCard): PublicResourceCard {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    content_type: r.content_type as PublicResourceCard['content_type'],
    jurisdiction: r.jurisdiction,
    difficulty: null,
    published_at: null,
    updated_at: '',
    event_date: null,
    is_featured: false,
    featured_priority: null,
    primary_category: null,
    video: null,
  };
}

export function RelatedResources({ items, title = 'Continue learning' }: { items: RelatedResourceCard[]; title?: string }) {
  if (items.length === 0) return null; // spec §62-style principle applied here too: render nothing rather than an empty section
  return (
    <section aria-labelledby="related-resources-heading" className="border-t border-line pt-6">
      <h2 id="related-resources-heading" className="text-xl font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((r) => (
          <ResourcePublicCard key={r.id} resource={toPublicCard(r)} />
        ))}
      </div>
    </section>
  );
}
