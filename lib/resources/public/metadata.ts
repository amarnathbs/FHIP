// Resources / Financial Knowledge & Insights — R1.5 public SEO/metadata
// helpers (spec §63-68).

import type { Metadata } from 'next';
import type { ResourcePost } from '@/lib/resources/types';
import { CONTENT_TYPE_LABELS } from '@/lib/resources/admin/labels';

// Same convention already used by the report/forecast PDF renderers
// (lib/services/reportPdfRenderer.ts) — a server-only env var, not
// NEXT_PUBLIC_*, with a localhost dev default; production sets
// APP_BASE_URL to the real domain. Reused here rather than invented fresh,
// and satisfies spec §66 ("do not generate canonical URLs using localhost")
// for any deployed environment, which already sets this var.
export function getPublicSiteBaseUrl(): string {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function buildResourceCanonicalUrl(slug: string): string {
  return `${getPublicSiteBaseUrl()}/resources/${slug}`;
}

export function buildTopicCanonicalUrl(slug: string): string {
  return `${getPublicSiteBaseUrl()}/resources/topic/${slug}`;
}

// Spec §57: single fallback constant, read by exactly one function
// (getCentralDisclaimer in queries.ts) rather than copy/pasted into every
// rendering component. Kept identical to the seeded resource_settings row
// (migration 0034's `default_disclaimer`) so the DB-sourced value and this
// fallback never visibly disagree if the live read fails for any reason
// (RLS policy not yet applied — see migration 0039's header comment — or a
// transient error).
export const DEFAULT_RESOURCE_DISCLAIMER =
  'This content is general financial education, not personal financial advice. It does not take into account your individual objectives, financial situation or needs.';

/**
 * Spec §64: seo_title -> title fallback, seo_description -> excerpt
 * fallback, never an empty tag. Spec §65: is_indexable=false gets a
 * noindex directive, not a 404 — the caller decides indexability from the
 * fetched post, this function only encodes the tag-building rule.
 */
export function buildResourceMetadata(post: Pick<ResourcePost, 'title' | 'seo_title' | 'excerpt' | 'seo_description' | 'slug' | 'is_indexable' | 'content_type'>): Metadata {
  const title = post.seo_title?.trim() || post.title;
  const description = post.seo_description?.trim() || post.excerpt?.trim() || undefined;
  const canonical = post.slug ? buildResourceCanonicalUrl(post.slug) : undefined;
  const typeLabel = CONTENT_TYPE_LABELS[post.content_type];

  return {
    title: `${title} | FHIP Financial Knowledge & Insights`,
    description,
    alternates: canonical ? { canonical } : undefined,
    robots: post.is_indexable ? undefined : { index: false, follow: true },
    openGraph: {
      title,
      description,
      type: 'article',
      url: canonical,
    },
    other: { 'resource-content-type': typeLabel },
  };
}

// --- Structured data (spec §67/§68) ----------------------------------------
// Built only from real stored fields; a missing required field means the
// whole structured-data object is omitted for that page, never fabricated
// (spec §67: "If the content does not contain enough trustworthy fields,
// omit that structured-data type").

export function buildBreadcrumbJsonLd(items: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function buildArticleJsonLd(post: {
  title: string;
  excerpt: string | null;
  slug: string | null;
  published_at: string | null;
  updated_at: string;
  authorName: string | null;
}) {
  if (!post.slug || !post.published_at) return null; // required fields absent — omit rather than fabricate
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt || undefined,
    datePublished: post.published_at,
    dateModified: post.updated_at,
    author: post.authorName ? { '@type': 'Person', name: post.authorName } : undefined,
    mainEntityOfPage: buildResourceCanonicalUrl(post.slug),
  };
}

export function buildVideoJsonLd(video: {
  title: string;
  excerpt: string | null;
  slug: string | null;
  published_at: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  embedUrl: string | null;
}) {
  if (!video.slug || !video.published_at || !video.thumbnailUrl) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description: video.excerpt || video.title,
    thumbnailUrl: [video.thumbnailUrl],
    uploadDate: video.published_at,
    embedUrl: video.embedUrl || undefined,
    duration: video.durationSeconds ? `PT${video.durationSeconds}S` : undefined,
  };
}

// Spec §55: "Article-style pages should display reasonable reader-facing
// metadata such as 'Published 18 Aug 2026'... Avoid raw timestamps." A
// small, public-facing date formatter, kept in this module (not imported
// from lib/resources/admin/labels.ts) so nothing in the public rendering
// path depends on an "admin" module for something readers see directly.
export function formatPublicDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function buildFaqJsonLd(faqs: { question: string; shortAnswer: string }[]) {
  if (faqs.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    // Spec §68: "Do not emit hidden FAQ structured data that users cannot
    // see" — this is built from the exact same question/short-answer text
    // rendered visibly in the on-page accordion, never a separate copy.
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.shortAnswer },
    })),
  };
}
