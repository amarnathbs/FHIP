// R1.4 authoritative-source URL validation — spec §51/§100.
//
// Uses the platform URL parser (spec §100: "Use URL parsing rather than
// fragile string matching"), same approach as the YouTube parser
// (lib/resources/video/youtube.ts) and for the same reason: protocol
// inspection after a real parse is robust against `javascript:alert(1)`,
// `data:text/html,...` and similar tricks that a naive `startsWith('http')`
// check could be fooled by (e.g. `httpjavascript://...` would pass a bad
// substring check but fails a real parse's protocol test here).

export function isSafeSourceUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  return url.protocol === 'https:'; // spec §51: "Require https://" — http is not accepted for a source citation
}

export function validateSourceUrl(raw: string): { valid: boolean; error?: string } {
  if (!raw.trim()) return { valid: true }; // URL itself is optional per spec §50's minimal field list
  return isSafeSourceUrl(raw) ? { valid: true } : { valid: false, error: 'Enter a valid https:// URL.' };
}
