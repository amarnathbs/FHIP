// R1.6 Public Search — query normalisation (spec §20, §106-107).
//
// This is the only place raw search input is touched before being handed to
// the database. No string concatenation into SQL happens anywhere in this
// codebase for search (see migration 0040's search_resource_posts()): every
// value below travels as a plain typed RPC parameter. Trimming/length-
// capping here is a UX/DoS-hygiene concern (spec §20's "reasonable maximum
// query length"), not the injection defence — that defence is the parameterised
// RPC itself.

export const MAX_SEARCH_QUERY_LENGTH = 200; // spec §20 example

/**
 * spec §20: "Trim whitespace. Handle: empty query; punctuation; multi-word
 * query; apostrophes; Unicode." No character stripping beyond whitespace
 * collapse/trim/length-cap — punctuation, apostrophes and Unicode all pass
 * through unchanged and are handled safely downstream by
 * websearch_to_tsquery()/ILIKE, which is exactly what spec §106 ("' OR 1=1
 * --' ... treated as search text or safely rejected. Never changes query
 * semantics") and §107 ("<script>alert(1)</script> ... safe visible/query
 * text. No execution") require — this function does not need to detect or
 * block those patterns itself, it just normalises whitespace/length.
 */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
}

export const VALID_SEARCH_CONTENT_TYPES = ['all', 'article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update'] as const;
export type SearchContentTypeFilter = (typeof VALID_SEARCH_CONTENT_TYPES)[number];

export const VALID_SEARCH_JURISDICTIONS = ['all', 'global', 'australia', 'india', 'australia_india_cross_border'] as const;
export type SearchJurisdictionFilter = (typeof VALID_SEARCH_JURISDICTIONS)[number];

export function normalizeContentTypeFilter(raw: string | null | undefined): SearchContentTypeFilter {
  return (VALID_SEARCH_CONTENT_TYPES as readonly string[]).includes(raw ?? '') ? (raw as SearchContentTypeFilter) : 'all';
}

export function normalizeJurisdictionFilter(raw: string | null | undefined): SearchJurisdictionFilter {
  return (VALID_SEARCH_JURISDICTIONS as readonly string[]).includes(raw ?? '') ? (raw as SearchJurisdictionFilter) : 'all';
}
