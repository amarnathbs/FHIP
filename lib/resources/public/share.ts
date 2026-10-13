// Resources — pure share-journey logic behind components/resources/public/
// ShareButton.tsx. Kept free of React/DOM so every rule (what is shared, when
// the native sheet is used, what counts as a cancellation, what may be
// shared at all) is unit-tested directly.

export interface ResourceShareData {
  title: string;
  text: string;
  url: string;
}

// Web Share `text` is a concise description, never the full article. A cut
// text ends on a word boundary with an ellipsis so it never reads as a
// truncated sentence fragment.
const SHARE_TEXT_MAX = 200;

export function buildShareData(input: { title: string; excerpt?: string | null; url: string }): ResourceShareData {
  const excerpt = (input.excerpt ?? '').replace(/\s+/g, ' ').trim();
  let text: string;
  if (!excerpt) {
    text = `${input.title} - FHIP Financial Knowledge & Insights`;
  } else if (excerpt.length <= SHARE_TEXT_MAX) {
    text = excerpt;
  } else {
    const cut = excerpt.slice(0, SHARE_TEXT_MAX - 1);
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
  }
  return { title: input.title, text, url: input.url };
}

// A user dismissing the OS share sheet rejects navigator.share() with a
// DOMException named AbortError (Chromium and WebKit). That is a normal
// outcome, never an error to show.
export function isShareAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export interface ShareEnvironment {
  nav?: { share?: unknown; canShare?: unknown } | null;
  matchMedia?: ((query: string) => { matches: boolean }) | null;
}

export function canUseNativeShare(nav: { share?: unknown } | undefined | null): boolean {
  return !!nav && typeof nav.share === 'function';
}

// The share button hands straight to the OS sheet ONLY on touch-primary
// devices (phones/tablets), where the sheet is the platform's own, familiar
// share UI. Desktop browsers that merely expose navigator.share (Edge/Chrome
// on Windows) keep the in-page menu: 2026-10-01 their OS sheet listed dead
// targets and hid the reliable web links. The native sheet stays available
// there as a "More options" entry.
export function prefersNativeShare(env: ShareEnvironment): boolean {
  if (!canUseNativeShare(env.nav)) return false;
  try {
    return !!env.matchMedia && env.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export type NativeShareOutcome = 'shared' | 'cancelled' | 'failed';

// Calls navigator.share with the exact payload. 'cancelled' (the user closed
// the sheet) is a normal outcome and must produce no message; only 'failed'
// (the browser refused) sends the UI to its in-page fallback panel. Must be
// invoked synchronously from the tap so user activation is still valid.
export async function shareViaNavigator(
  nav: { share: (data: ResourceShareData) => Promise<void> },
  data: ResourceShareData,
): Promise<NativeShareOutcome> {
  try {
    await nav.share(data);
    return 'shared';
  } catch (err) {
    return isShareAbort(err) ? 'cancelled' : 'failed';
  }
}

// navigator.canShare, where present, can veto a payload; absent means "try".
export function isSharePayloadSupported(nav: { canShare?: unknown } | undefined | null, data: ResourceShareData): boolean {
  if (!nav || typeof nav.canShare !== 'function') return true;
  try {
    return !!(nav.canShare as (d: ResourceShareData) => boolean).call(nav, data);
  } catch {
    return false;
  }
}

export type ClipboardEnvironment = {
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  // Synchronous legacy path (hidden textarea + execCommand) for contexts
  // without the async Clipboard API (older WebViews, insecure origins).
  legacyCopy?: ((text: string) => boolean) | null;
};

export async function copyTextToClipboard(text: string, env: ClipboardEnvironment): Promise<boolean> {
  if (env.clipboard && typeof env.clipboard.writeText === 'function') {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied / not focused: try the legacy path below
    }
  }
  if (env.legacyCopy) {
    try {
      return !!env.legacyCopy(text);
    } catch {
      return false;
    }
  }
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|.*\.localhost|.*\.local)$/i;

export type ShareUrlProblem =
  | 'not-a-url'
  | 'not-https'
  | 'private-host'
  | 'supabase-host'
  | 'not-a-resource-route'
  | 'admin-route'
  | 'uuid-only-route'
  | 'query-or-fragment';

// What may be put in front of a recipient: an absolute https URL on a public
// host, shaped exactly /resources/<slug>. Returns null when shareable.
export function findShareUrlProblem(url: string): ShareUrlProblem | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-a-url';
  }
  if (parsed.protocol !== 'https:') return 'not-https';
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return 'private-host';
  if (/\.supabase\.(co|in)$/i.test(parsed.hostname)) return 'supabase-host';
  if (parsed.search || parsed.hash) return 'query-or-fragment';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] === 'admin' || (segments[0] === 'resources' && segments[1] === 'admin')) return 'admin-route';
  if (segments.length !== 2 || segments[0] !== 'resources') return 'not-a-resource-route';
  if (UUID_RE.test(segments[1])) return 'uuid-only-route';
  return null;
}
