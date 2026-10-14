// Resource Share journey: canonical URL, native Web Share, cancellation,
// fallback, Copy link, public routing and the "never share a bad URL" guard.
// Layout/bounds are proven in a real browser by tests/e2e/resource-share-mobile.spec.ts
// (this repo has no React render harness, so component rules are asserted on
// the pure module plus the component source).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildShareData,
  canUseNativeShare,
  copyTextToClipboard,
  findShareUrlProblem,
  isShareAbort,
  isSharePayloadSupported,
  prefersNativeShare,
  shareViaNavigator,
} from '@/lib/resources/public/share';
import { buildResourceCanonicalUrl, buildResourceMetadata } from '@/lib/resources/public/metadata';
import { buildEmailShareHref, buildShareLinks } from '@/components/resources/public/ShareButton';

const read = (p: string) => readFileSync(p, 'utf8').split('\r\n').join('\n');
const PROD = 'https://app.financialhealthplatform.com';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('canonical share URL', () => {
  it('a published Resource maps to the exact canonical public URL', () => {
    vi.stubEnv('APP_BASE_URL', PROD);
    expect(buildResourceCanonicalUrl('gross-income-vs-take-home-income')).toBe(`${PROD}/resources/gross-income-vs-take-home-income`);
  });

  it('a trailing slash on the configured origin does not double the slash', () => {
    vi.stubEnv('APP_BASE_URL', `${PROD}/`);
    expect(buildResourceCanonicalUrl('a-b')).toBe(`${PROD}/resources/a-b`);
  });

  it('encodes the slug exactly once (no raw spaces, no double encoding, & cannot start a query string)', () => {
    vi.stubEnv('APP_BASE_URL', PROD);
    const url = buildResourceCanonicalUrl('tax & super: it\'s [new] café');
    expect(url).toBe(`${PROD}/resources/tax%20%26%20super%3A%20it's%20%5Bnew%5D%20caf%C3%A9`);
    expect(url).not.toMatch(/%25/);
    expect(url).not.toContain(' ');
    expect(new URL(url).search).toBe('');
    // An already-stored (decoded) slug round-trips through URL parsing.
    expect(decodeURIComponent(new URL(url).pathname.split('/')[2])).toBe('tax & super: it\'s [new] café');
  });

  it('canonical, og:url and the Share URL are produced by the same function for the same slug', () => {
    vi.stubEnv('APP_BASE_URL', PROD);
    const meta = buildResourceMetadata({ title: 'T', seo_title: null, excerpt: 'e', seo_description: null, slug: 'my-slug', is_indexable: true, content_type: 'article' } as never);
    const shareUrl = buildResourceCanonicalUrl('my-slug');
    expect(meta.alternates?.canonical).toBe(shareUrl);
    expect((meta.openGraph as { url?: string }).url).toBe(shareUrl);
    const page = read('app/(marketing)/resources/[slug]/page.tsx');
    expect(page).toContain('const canonicalUrl = buildResourceCanonicalUrl(post.slug ?? slug);');
    expect(page).toContain('shareUrl={canonicalUrl}');
  });

  it('the Share button shares exactly its url prop and never reads window.location', () => {
    const src = read('components/resources/public/ShareButton.tsx').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/location\.(href|origin|pathname)/);
    expect(src).not.toContain('window.location');
  });
});

describe('guard: never share a localhost / internal / admin / UUID / relative URL', () => {
  it('accepts the production canonical Resource URL', () => {
    expect(findShareUrlProblem(`${PROD}/resources/gross-income-vs-take-home-income`)).toBeNull();
  });

  it.each([
    ['http://localhost:3000/resources/x', 'not-https'],
    ['https://localhost:3000/resources/x', 'private-host'],
    ['https://127.0.0.1/resources/x', 'private-host'],
    ['https://vqycarelcoijzwlpkpcz.supabase.co/resources/x', 'supabase-host'],
    ['/resources/x', 'not-a-url'],
    ['resources/x', 'not-a-url'],
    [`${PROD}/admin/resources/x`, 'admin-route'],
    [`${PROD}/resources/admin/x`, 'admin-route'],
    [`${PROD}/resources/3f2504e0-4f89-41d3-9a0c-0305e82c3301`, 'uuid-only-route'],
    [`${PROD}/resources`, 'not-a-resource-route'],
    [`${PROD}/resources/topic/budgeting`, 'not-a-resource-route'],
    [`${PROD}/resources/x?utm_source=admin`, 'query-or-fragment'],
    [`${PROD}/resources/x#edit`, 'query-or-fragment'],
  ])('rejects %s as %s', (url, problem) => {
    expect(findShareUrlProblem(url)).toBe(problem);
  });

  it('with APP_BASE_URL unset the builder yields a localhost URL that the guard flags (so a misconfigured deploy is detectable)', () => {
    vi.stubEnv('APP_BASE_URL', '');
    expect(findShareUrlProblem(buildResourceCanonicalUrl('x'))).not.toBeNull();
  });
});

describe('Web Share payload', () => {
  const url = `${PROD}/resources/gross-income-vs-take-home-income`;

  it('carries the exact article title, a concise description and the canonical URL', () => {
    const data = buildShareData({ title: 'Gross Income vs Take-Home Income', excerpt: 'Gross income is what you earn before tax.', url });
    expect(data).toEqual({ title: 'Gross Income vs Take-Home Income', text: 'Gross income is what you earn before tax.', url });
  });

  it('shortens a long excerpt on a word boundary to at most 200 characters', () => {
    const long = 'word '.repeat(100);
    const { text } = buildShareData({ title: 'T', excerpt: long, url });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/wor…$/);
  });

  it('falls back to a title-based description when there is no excerpt', () => {
    expect(buildShareData({ title: 'My Title', excerpt: null, url }).text).toContain('My Title');
    expect(buildShareData({ title: 'My Title', excerpt: '   ', url }).text).toContain('My Title');
  });

  it('navigator.share receives exactly that payload', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const data = buildShareData({ title: 'Gross Income vs Take-Home Income', excerpt: 'Short.', url });
    expect(await shareViaNavigator({ share }, data)).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: 'Gross Income vs Take-Home Income', text: 'Short.', url });
  });
});

describe('user cancellation is not an error', () => {
  const data = { title: 't', text: 'x', url: `${PROD}/resources/a` };

  it('AbortError -> cancelled (no failure, no fallback, no message)', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Share canceled', 'AbortError'));
    expect(await shareViaNavigator({ share }, data)).toBe('cancelled');
    expect(isShareAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isShareAbort({ name: 'AbortError' })).toBe(true);
  });

  it('any other rejection -> failed, which the UI turns into the in-page fallback panel', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    expect(await shareViaNavigator({ share }, data)).toBe('failed');
    expect(isShareAbort(new Error('boom'))).toBe(false);
    expect(isShareAbort(null)).toBe(false);
  });

  it('the component never renders a failure message', () => {
    const src = read('components/resources/public/ShareButton.tsx');
    expect(src).not.toMatch(/Share failed/i);
    const click = src.slice(src.indexOf('function handleShareClick'), src.indexOf('async function handleMoreOptions'));
    expect(click).toContain("outcome === 'failed'");
  });
});

describe('native vs fallback selection', () => {
  const nav = { share: () => Promise.resolve() };
  const mm = (coarse: boolean) => (q: string) => ({ matches: q === '(pointer: coarse)' && coarse });

  it('touch device with Web Share API -> native sheet directly', () => {
    expect(prefersNativeShare({ nav, matchMedia: mm(true) })).toBe(true);
  });
  it('desktop (fine pointer) with Web Share API -> in-page menu (2026-10-01 decision kept)', () => {
    expect(prefersNativeShare({ nav, matchMedia: mm(false) })).toBe(false);
  });
  it('no Web Share API -> fallback panel, on touch and desktop alike', () => {
    expect(prefersNativeShare({ nav: {}, matchMedia: mm(true) })).toBe(false);
    expect(prefersNativeShare({ nav: undefined, matchMedia: mm(true) })).toBe(false);
    expect(prefersNativeShare({ nav: null, matchMedia: null })).toBe(false);
    expect(canUseNativeShare({})).toBe(false);
  });
  it('no matchMedia, or one that throws -> fallback panel', () => {
    expect(prefersNativeShare({ nav })).toBe(false);
    expect(prefersNativeShare({ nav, matchMedia: () => { throw new Error('x'); } })).toBe(false);
  });
  it('canShare can veto a payload; its absence means "try"', () => {
    const data = { title: 't', text: 'x', url: `${PROD}/resources/a` };
    expect(isSharePayloadSupported({}, data)).toBe(true);
    expect(isSharePayloadSupported({ canShare: () => false }, data)).toBe(false);
    expect(isSharePayloadSupported({ canShare: () => true }, data)).toBe(true);
    expect(isSharePayloadSupported({ canShare: () => { throw new Error('x'); } }, data)).toBe(false);
  });
  it('the tap handler calls the native sheet synchronously (user activation) before any await', () => {
    const src = read('components/resources/public/ShareButton.tsx');
    const click = src.slice(src.indexOf('function handleShareClick'), src.indexOf('async function handleMoreOptions'));
    expect(click).not.toContain('await ');
  });
});

describe('Copy link', () => {
  const url = `${PROD}/resources/gross-income-vs-take-home-income`;

  it('copies the exact canonical URL via the Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyTextToClipboard(url, { clipboard: { writeText } })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('falls back to the legacy copy when the Clipboard API rejects or is absent', async () => {
    const legacy = vi.fn().mockReturnValue(true);
    expect(await copyTextToClipboard(url, { clipboard: { writeText: () => Promise.reject(new Error('denied')) }, legacyCopy: legacy })).toBe(true);
    expect(await copyTextToClipboard(url, { clipboard: null, legacyCopy: legacy })).toBe(true);
    expect(legacy).toHaveBeenCalledWith(url);
  });

  it('reports failure (so the UI shows a select-and-copy field) when nothing works', async () => {
    expect(await copyTextToClipboard(url, { clipboard: null, legacyCopy: () => false })).toBe(false);
    expect(await copyTextToClipboard(url, {})).toBe(false);
    expect(await copyTextToClipboard(url, { clipboard: { writeText: () => Promise.reject(new Error('x')) }, legacyCopy: () => { throw new Error('y'); } })).toBe(false);
  });

  it('gives "Link copied" feedback', () => {
    expect(read('components/resources/public/ShareButton.tsx')).toContain("'Link copied'");
  });
});

describe('fallback link encoding', () => {
  it('every target encodes the URL once and a tricky title cannot break the query', () => {
    const url = `${PROD}/resources/tax-and-super`;
    const title = `Tax & Super: what's "new"? #2026`;
    for (const l of buildShareLinks(url, title)) {
      expect(l.href).toContain(encodeURIComponent(url));
      expect(l.href).not.toContain(encodeURIComponent(encodeURIComponent(url)));
    }
    const mail = buildEmailShareHref(url, title);
    expect(mail).toBe(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`);
    expect(mail.split('&body=')).toHaveLength(2);
  });
});

describe('mobile layout rules (source-level; real geometry is in the Playwright spec)', () => {
  const src = read('components/resources/public/ShareButton.tsx');
  const panelClass = src.slice(src.indexOf('role="dialog"'), src.indexOf('<div className="flex items-center justify-between px-4 pb-1 pt-2 sm:hidden">'));

  it('below sm the panel is a bottom sheet pinned inside the viewport with safe-area-aware side/bottom margins and a viewport-bounded width', () => {
    expect(panelClass).toContain('fixed');
    expect(panelClass).toContain('left-[max(0.5rem,env(safe-area-inset-left))]');
    expect(panelClass).toContain('right-[max(0.5rem,env(safe-area-inset-right))]');
    expect(panelClass).toContain('bottom-[max(0.5rem,env(safe-area-inset-bottom))]');
    expect(panelClass).toContain('max-w-sm');
  });

  it('the old defect is gone: no unconditional absolute right-0 fixed-width menu (the popover is sm-and-up only)', () => {
    expect(panelClass).not.toMatch(/(^|\s)absolute(\s|$)/);
    expect(panelClass).not.toMatch(/(^|\s)right-0(\s|$)/);
    expect(panelClass).not.toMatch(/(^|\s)w-48(\s|$)/);
    expect(panelClass).toContain('sm:absolute');
    expect(panelClass).toContain('sm:max-w-[calc(100vw-2rem)]');
  });

  it('the Share control stays right-aligned even when the header row wraps (ml-auto), so the sm popover never anchors on the left', () => {
    expect(src).toContain('className="relative ml-auto"');
  });
});

describe('accessibility contract (source-level; no screen-reader test was run)', () => {
  const src = read('components/resources/public/ShareButton.tsx');
  it('real <button> named Share with expanded state, controls id and a labelled dialog', () => {
    expect(src).toMatch(/<button\s+ref=\{triggerRef\}\s+type="button"/);
    expect(src).toContain('aria-expanded={open}');
    expect(src).toContain('aria-controls={open ? panelId : undefined}');
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-label="Share this article"');
    expect(src).toContain('aria-label="Close share options"');
  });
  it('Escape closes, outside tap closes, focus moves in on open and returns to Share', () => {
    expect(src).toContain("event.key === 'Escape'");
    expect(src).toContain("addEventListener('pointerdown'");
    expect(src).toContain('triggerRef.current?.focus()');
    expect(src).toContain('[data-share-initial]');
  });
  it('the fake-menu roles (menu/menuitem without arrow-key support) are gone', () => {
    expect(src).not.toContain('role="menu"');
    expect(src).not.toContain('role="menuitem"');
  });
  it('visible keyboard focus and 44px touch targets on touch', () => {
    expect(src).toContain('focus-visible:ring-2');
    expect(src).toContain('min-h-11');
  });
});

describe('public routing: a logged-out recipient is never sent to login', () => {
  it('proxy.ts treats /resources/** as a non-app (public) route', () => {
    const proxy = read('proxy.ts');
    const m = proxy.match(/const isAppRoute = pathname\.match\(\s*(\/\^[^\n]+\/)\s*\)/);
    expect(m).not.toBeNull();
    const re = (0, eval)(m![1]) as RegExp;
    expect(re.test('/resources/gross-income-vs-take-home-income')).toBe(false);
    expect(re.test('/resources')).toBe(false);
    // control: the regex really does protect app routes
    expect(re.test('/dashboard')).toBe(true);
    expect(re.test('/admin/resources')).toBe(true);
  });
  it('the public detail route is under (marketing), not (app), and reads only the public view', () => {
    const page = read('app/(marketing)/resources/[slug]/page.tsx');
    expect(page).toContain('getPublicResourceBySlug');
    expect(page).not.toMatch(/redirect\(/);
  });
});

describe('open-in-app / deep link: NOT CURRENTLY SUPPORTED (documented, not invented)', () => {
  it('the repo ships no universal-link / app-link / PWA configuration', () => {
    expect(existsSync('public/.well-known/apple-app-site-association')).toBe(false);
    expect(existsSync('public/.well-known/assetlinks.json')).toBe(false);
    expect(existsSync('public/manifest.json')).toBe(false);
    expect(existsSync('public/manifest.webmanifest')).toBe(false);
    expect(existsSync('app/manifest.ts')).toBe(false);
  });
});
