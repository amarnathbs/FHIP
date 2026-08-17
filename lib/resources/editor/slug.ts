// R1.3 slug generation/validation — spec §19-20.

// Lowercase, URL-safe, collapses whitespace/punctuation to single hyphens,
// strips leading/trailing hyphens. Unicode is normalised (NFKD) and
// combining marks stripped so e.g. "café" -> "cafe" rather than producing a
// slug with a raw accented codepoint or dropping the word entirely.
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const SLUG_FORMAT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlugFormat(slug: string): boolean {
  return slug.length > 0 && slug.length <= 200 && SLUG_FORMAT_RE.test(slug);
}
