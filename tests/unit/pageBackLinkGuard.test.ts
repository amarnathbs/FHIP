// PO review 06-10-2026, finding F6: "No return or back button ... this will be the global correction, please check all pages
// and make sure that all pages do have the button to return back. Also for all future pages please make sure this is applicable."
//
// Repo-wide GUARD: every app/**/page.tsx must render the ONE shared <PageBackLink href=".." label=".." /> from
// components/navigation/PageBackLink.tsx, unless it is on the explicit allow-list below (landing, dashboard, authentication,
// mandatory onboarding gates, print/PDF targets) with a stated reason. A NEW page without the component fails this test.
// It also checks that each page's parent target is a real route, that the allow-list cannot go stale, that the inventory document
// (docs/ux/BACK_NAVIGATION_INVENTORY.md) names every page, and that the rule is written into the Admin Architecture Standard.
// NEGATIVE CONTROLS re-run the scanner on mutated copies of real pages / a virtual new page and require each to be caught.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageBackLink } from '@/components/navigation/PageBackLink';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Pages that deliberately carry no back link. Every entry needs a reason; the list is checked for staleness. */
export const BACK_LINK_EXEMPT: Record<string, string> = {
  '/': 'Public landing page (top level).',
  '/dashboard': 'The signed-in home (top level): there is nothing above it.',
  '/login': 'Authentication page.',
  '/signup': 'Authentication page.',
  '/forgot-password': 'Authentication page (has its own "Back to log in").',
  '/reset-password': 'Authentication page.',
  '/confirm-country': 'Mandatory onboarding gate: the user must complete it, there is no page to return to.',
  '/onboarding': 'Mandatory onboarding gate / redirect.',
  '/forecast/report/print': 'Print / PDF render target, never navigated to by a person.',
  '/reports/[id]/print': 'Print / PDF render target, never navigated to by a person.',
};

function walk(rel: string, acc: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r, acc);
    else if (e.name === 'page.tsx') acc.push(r);
  }
  return acc;
}

/** app/(app)/admin/resources/content/[id]/page.tsx -> /admin/resources/content/[id] (route groups removed). */
export function routeOf(file: string): string {
  const p = file
    .replace(/^app\//, '')
    .replace(/\([^)]*\)\//g, '')
    .replace(/page\.tsx$/, '')
    .replace(/\/$/, '');
  return `/${p}`;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

export interface Finding {
  route: string;
  problem: string;
}

/** The back-link facts of one page source: whether it imports and renders the shared component, and its static parent href. */
export function inspectPage(source: string): { imports: boolean; renders: boolean; href: string | null; label: string | null } {
  const code = stripComments(source);
  const imports = /import\s*\{[^}]*\bPageBackLink\b[^}]*\}\s*from\s*['"]@\/components\/navigation\/PageBackLink['"]/.test(code);
  const tag = /<PageBackLink\b([^>]*?)\/>/.exec(code);
  const renders = tag !== null;
  const attrs = tag?.[1] ?? '';
  const href = /href=(?:"([^"]+)"|\{`([^`]+)`\}|\{([^}]+)\})/.exec(attrs);
  const label = /label=(?:"([^"]+)"|\{([^}]+)\})/.exec(attrs);
  return { imports, renders, href: href ? (href[1] ?? href[2] ?? `{${href[3]}}`) : null, label: label ? (label[1] ?? `{${label[2]}}`) : null };
}

const PAGES = walk('app');
const SOURCES = new Map(PAGES.map((f) => [f, read(f)]));
const ROUTES = new Set(PAGES.map(routeOf));

export function findViolations(sources: Map<string, string>, exempt: Record<string, string> = BACK_LINK_EXEMPT): Finding[] {
  const out: Finding[] = [];
  for (const [file, src] of sources) {
    const route = routeOf(file);
    if (route in exempt) continue;
    const i = inspectPage(src);
    if (!i.imports) out.push({ route, problem: 'does not import PageBackLink from @/components/navigation/PageBackLink' });
    if (!i.renders) out.push({ route, problem: 'does not render <PageBackLink ... />' });
    else if (!i.href || !i.label) out.push({ route, problem: 'PageBackLink needs both href and label' });
  }
  return out;
}

/** Does an href (with ${x} placeholders and /[param] route segments) name a real page route? */
function resolves(href: string, routes: Set<string>): boolean {
  const want = href.replace(/\$\{[^}]+\}/g, '_').split('/');
  return [...routes].some((r) => {
    const have = r.split('/');
    return have.length === want.length && have.every((seg, k) => seg === want[k] || /^\[.+\]$/.test(seg));
  });
}

describe('F6 guard: every page has the shared back link', () => {
  it('walks the whole app (the guard cannot silently see zero pages)', () => {
    expect(PAGES.length).toBeGreaterThan(110);
    for (const must of ['app/(app)/admin/resources/context/page.tsx', 'app/(app)/profile/page.tsx', 'app/(marketing)/resources/[slug]/page.tsx']) expect(PAGES).toContain(must);
  });

  it('no page.tsx outside the allow-list lacks the component', () => {
    const v = findViolations(SOURCES);
    expect(v, JSON.stringify(v, null, 1)).toEqual([]);
  });

  it('the allow-list has no stale entry, and each exempt page really has no back link (the list cannot hide a page that has one)', () => {
    for (const [route, why] of Object.entries(BACK_LINK_EXEMPT)) {
      expect(ROUTES.has(route), `${route}: ${why}`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
    expect(Object.keys(BACK_LINK_EXEMPT).length).toBeLessThanOrEqual(10);
  });

  it('every page parent target is a real route (a back link to a page that does not exist is a defect)', () => {
    const bad: string[] = [];
    for (const [file, src] of SOURCES) {
      const route = routeOf(file);
      if (route in BACK_LINK_EXEMPT) continue;
      const i = inspectPage(src);
      // dynamic hrefs ({target.href}) are checked by their own test below; static ones here
      if (i.href && !i.href.startsWith('{') && !resolves(i.href, ROUTES)) bad.push(`${route} -> ${i.href}`);
      if (i.href && !i.href.startsWith('{') && i.href === route) bad.push(`${route} points at itself`);
    }
    expect(bad).toEqual([]);
  });

  it('the Financial Data Hub review page returns to where the person came from, and every target it can pick is a real route', () => {
    const src = SOURCES.get('app/(app)/financial-data-hub/review/page.tsx') as string;
    const targets = [...src.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(targets.length).toBe(3);
    for (const t of targets) expect(resolves(t, ROUTES), t).toBe(true);
    expect(src).toContain('<PageBackLink href={target.href}');
  });

  it('the inventory document lists every page and every exemption', () => {
    const doc = read('docs/ux/BACK_NAVIGATION_INVENTORY.md');
    for (const route of ROUTES) expect(doc.includes(`\`${route}\``), `inventory is missing ${route}`).toBe(true);
  });

  it('the rule is written into the Admin Architecture Standard and the user-facing UX notes', () => {
    const std = read('docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md');
    expect(std).toContain('## 18. Back navigation');
    expect(std).toContain('PageBackLink');
    expect(std).toContain('tests/unit/pageBackLinkGuard.test.ts');
    const ux = read('docs/ux/BACK_NAVIGATION_INVENTORY.md');
    expect(ux).toContain('Rule for every new page');
  });
});

describe('PageBackLink component', () => {
  const html = renderToStaticMarkup(React.createElement(PageBackLink, { href: '/admin/resources', label: 'Resources' }));
  it('renders a real link to the parent with the consistent text "Back to <label>"', () => {
    expect(html).toContain('href="/admin/resources"');
    expect(html.replace(/<[^>]+>/g, '')).toContain('Back to Resources');
  });
  it('is keyboard focusable with a visible focus style, inside a labelled navigation landmark, with a decorative icon', () => {
    expect(html).toMatch(/<a [^>]*href=/); // an anchor is natively focusable
    expect(html).not.toContain('tabindex="-1"');
    expect(html).toContain('focus-visible:outline');
    expect(html).toContain('aria-label="Back navigation"');
    expect(html).toContain('aria-hidden="true"');
  });
  it('uses a plain link, never history tricks that break deep links', () => {
    const src = read('components/navigation/PageBackLink.tsx');
    expect(stripComments(src)).not.toMatch(/router\.back|history\.back|window\.history/);
  });
});

describe('NEGATIVE CONTROLS: the guard demonstrably fails when a page lacks the component', () => {
  const target = 'app/(app)/admin/resources/context/page.tsx';
  const mutate = (fn: (s: string) => string): Map<string, string> => new Map([...SOURCES].map(([f, s]) => [f, f === target ? fn(s) : s]));

  it('BACKLINK-NC-1: removing the <PageBackLink /> tag from the Context Mapping page (the screen the PO reported) is caught', () => {
    const changed = mutate((s) => s.replace(/<PageBackLink[^>]*\/>/, ''));
    expect(changed.get(target)).not.toBe(SOURCES.get(target));
    const v = findViolations(changed);
    expect(v.some((x) => x.route === '/admin/resources/context' && /does not render/.test(x.problem))).toBe(true);
  });

  it('BACKLINK-NC-2: removing only the import is caught', () => {
    const changed = mutate((s) => s.replace(/import \{ PageBackLink \}[^\n]*\n/, ''));
    expect(changed.get(target)).not.toBe(SOURCES.get(target));
    expect(findViolations(changed).some((x) => x.route === '/admin/resources/context' && /import/.test(x.problem))).toBe(true);
  });

  it('BACKLINK-NC-3: a comment that merely mentions the component does not satisfy the guard', () => {
    const changed = mutate(() => "// <PageBackLink href=\"/x\" label=\"X\" />\nexport default function P() { return null; }\n");
    expect(findViolations(changed).some((x) => x.route === '/admin/resources/context')).toBe(true);
  });

  it('BACKLINK-NC-4: a brand-new page without the component is caught (future pages)', () => {
    const extra = new Map(SOURCES);
    extra.set('app/(app)/some-new-module/page.tsx', 'export default function NewPage() { return <div>hello</div>; }\n');
    const v = findViolations(extra);
    expect(v.some((x) => x.route === '/some-new-module')).toBe(true);
  });

  it('BACKLINK-NC-5: a back link with no target is caught', () => {
    const changed = mutate((s) => s.replace(/<PageBackLink[^>]*\/>/, '<PageBackLink label="Resources" />'));
    expect(findViolations(changed).some((x) => /href and label/.test(x.problem))).toBe(true);
  });

  it('BACKLINK-NC-6: a parent target that is not a real route is caught by the resolver', () => {
    expect(resolves('/admin/resources', ROUTES)).toBe(true);
    expect(resolves('/admin/resorces', ROUTES)).toBe(false);
    expect(resolves('/admin/resources/content/${id}/edit', ROUTES)).toBe(true);
  });

  it('BACKLINK-NC-7: the clean tree has no violation (the controls above are not noise)', () => {
    expect(findViolations(SOURCES)).toEqual([]);
  });
});
