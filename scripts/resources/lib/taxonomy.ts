// R1.7 — taxonomy (category/tag) normalization + deterministic
// resolve-or-create (spec §32-33). Normalization exists purely for
// *matching* against what already exists in DEV; the original workbook
// casing/label is always what gets written for anything newly created.

/** Case/whitespace/punctuation-insensitive key used only for matching, never for display or storage. */
export function normalizeForMatch(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s&-]/g, '');
}

export interface CategoryRef {
  id: string;
  name: string;
  slug: string;
}

export interface TagRef {
  id: string;
  name: string;
  slug: string;
}

export interface TaxonomyResolution<T> {
  ref: T | null;
  created: boolean;
  normalizedKey: string;
}

/**
 * Resolve a workbook category/tag label against an already-loaded lookup map
 * (normalizedKey -> ref). Never invents a "close enough" substitute — an
 * unmatched label is reported as needing creation, full stop.
 */
export function resolveAgainstMap<T extends { name: string }>(
  label: string,
  lookup: Map<string, T>
): TaxonomyResolution<T> {
  const key = normalizeForMatch(label);
  const existing = lookup.get(key);
  if (existing) return { ref: existing, created: false, normalizedKey: key };
  return { ref: null, created: false, normalizedKey: key };
}

function baseSlugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function categorySlugFor(label: string): string {
  return baseSlugify(label);
}

export function tagSlugFor(label: string): string {
  return baseSlugify(label);
}
