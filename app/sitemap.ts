import type { MetadataRoute } from 'next';
import { createClient } from '@/lib/supabase/server';
import { getPublicResourceSitemapEntries } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl, buildResourceCanonicalUrl } from '@/lib/resources/public/metadata';

// Next.js App Router sitemap convention (app/sitemap.ts) — this project has
// no pre-existing sitemap.ts anywhere (checked during the R1.5 pre-
// implementation audit), so this is a first instance, not a duplicate
// sitemap system (spec §69: "Reuse existing sitemap architecture rather
// than creating duplicate sitemap systems" — there was none to reuse).
//
// Spec §69/§107: only published+indexable Resources are included —
// getPublicResourceSitemapEntries() already routes through the same
// applyPublicPostVisibility() predicate every other public query uses, plus
// its own is_indexable=true filter, so drafts/review/scheduled/archived/
// templates/non-indexable content can never appear here.
//
// Spec §108: metadata-only query (slug + updated_at), no content_blocks.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getPublicSiteBaseUrl();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/resources`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${baseUrl}/resources/videos`, changeFrequency: 'daily', priority: 0.6 },
    { url: `${baseUrl}/resources/glossary`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${baseUrl}/resources/money-updates`, changeFrequency: 'daily', priority: 0.6 },
  ];

  try {
    const supabase = await createClient();
    const entries = await getPublicResourceSitemapEntries(supabase);
    const resourceEntries: MetadataRoute.Sitemap = entries.map((e) => ({
      url: buildResourceCanonicalUrl(e.slug),
      lastModified: e.updated_at,
      changeFrequency: 'weekly',
      priority: 0.5,
    }));
    return [...staticEntries, ...resourceEntries];
  } catch {
    // A sitemap failure must never break the whole build/route — fall back
    // to the static section entries rather than throwing.
    return staticEntries;
  }
}
