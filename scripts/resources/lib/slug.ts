// R1.7 slug resolution — reuses the R1.3 slug utility (spec §19: "do not
// build a second slug algorithm"). Contains only the R1.7-specific
// candidate-selection policy (URL segment -> title fallback -> content-id
// fallback), all normalization goes through slugify()/isValidSlugFormat().

import { slugify, isValidSlugFormat } from '@/lib/resources/editor/slug';

export type SlugSource = 'proposed_url' | 'title_fallback' | 'title_contentid_fallback';

export interface SlugResolution {
  slug: string;
  source: SlugSource;
}

/**
 * Deterministic, idempotent slug resolution for one Content_Master row.
 * `claimed` is the set of slugs already assigned earlier in this same run
 * (workbook-internal collisions) union existing DEV slugs (cross-DB
 * collisions) — the caller owns adding the returned slug to it.
 */
export function resolveSlug(params: {
  proposedUrl: string;
  title: string;
  contentId: string;
  claimed: ReadonlySet<string>;
}): SlugResolution {
  const { proposedUrl, title, contentId, claimed } = params;

  const hasPlaceholder = proposedUrl.includes('[') || proposedUrl.includes(']');
  if (!hasPlaceholder && proposedUrl) {
    const lastSegment = proposedUrl.replace(/\/+$/, '').split('/').pop() ?? '';
    const candidate = slugify(lastSegment);
    if (isValidSlugFormat(candidate) && !claimed.has(candidate)) {
      return { slug: candidate, source: 'proposed_url' };
    }
  }

  const titleSlug = slugify(title);
  if (isValidSlugFormat(titleSlug) && !claimed.has(titleSlug)) {
    return { slug: titleSlug, source: 'title_fallback' };
  }

  // Final, always-unique fallback: title + the globally-unique Content_ID.
  // Deterministic and reproducible (idempotent across repeated runs) —
  // never a silently-appended "-2" counter (spec §21).
  const withId = slugify(`${title}-${contentId}`);
  return { slug: withId, source: 'title_contentid_fallback' };
}
