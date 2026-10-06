// Shared sidebar accessibility (components/ui/AppShell.tsx): the three axe findings recorded by the NAV2 Stage 3 certification
// (docs/nav2/NAV2_STAGE3_CERTIFICATION_REPORT.md, journey 8b / row 25) and reproduced with scripts/a11y/sidebarAxe.mjs:
//
//   aria-required-children  a role="menu" list whose children are bare <li>
//   aria-required-parent    a role="menuitem" link whose parent is that bare <li>
//   listitem                a <li> inside a list that has role="menu"
//   color-contrast          the Admin group labels set 10 px in white at 40 % over the #0F2747 sidebar = 3.58:1 (needs 4.5:1)
//
// There is no DOM in this repository's unit environment, so the real component is rendered to static markup with the Next router
// and the Supabase client mocked, and the contrast of every text colour class it uses is computed from the Tailwind palette.
// The browser proof (real Chromium + axe-core 4.13, WCAG 2.0/2.1 A and AA) is `node scripts/a11y/sidebarAxe.mjs`.
// NEGATIVE CONTROLS re-run the same checks on the old markup / old colour and require them to FAIL.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pathname: '/forecast' }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
// Capability decisions arrive from a fetch that never runs in a static render; show every mapped item so the menus have content.
vi.mock('@/lib/nav/appNavCapability', async (orig) => ({ ...(await orig<typeof import('@/lib/nav/appNavCapability')>()), isNavHrefVisible: () => true }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: async () => undefined } }) }));

import { AppShell } from '@/components/ui/AppShell';

const ROOT = path.resolve(__dirname, '..', '..');
const SHELL_SOURCE = readFileSync(path.join(ROOT, 'components/ui/AppShell.tsx'), 'utf8');

function render(pathname: string): string {
  state.pathname = pathname;
  return renderToStaticMarkup(React.createElement(AppShell, null, React.createElement('p', null, 'page')));
}

/** A menuitem link whose direct parent <li> does NOT carry role="none" (the invalid shape axe reports). */
function bareListItemMenuItems(html: string): string[] {
  return html.match(/<li(?![^>]*role="none")[^>]*><a[^>]*role="menuitem"/g) ?? [];
}

describe('sidebar menu ARIA (axe: aria-required-children, aria-required-parent, listitem)', () => {
  for (const [name, pathname] of [
    ['Forecasting', '/forecast'],
    ['Reports', '/reports'],
  ] as const) {
    it(`${name} menu: every menuitem sits in a role="none" list item inside the role="menu" list`, () => {
      const html = render(pathname);
      expect(html).toContain('role="menu"');
      const items = html.match(/role="menuitem"/g) ?? [];
      expect(items.length).toBeGreaterThan(0);
      expect(bareListItemMenuItems(html), 'a menuitem link whose <li> lacks role="none"').toEqual([]);
      // one role="none" <li> per menuitem
      const wrapped = html.match(/<li role="none"[^>]*><a[^>]*role="menuitem"/g) ?? [];
      expect(wrapped.length).toBe(items.length);
    });
  }

  it('the desktop and the mobile copy of the menu never share an id', () => {
    const html = render('/forecast');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('NEGATIVE CONTROL: the old markup (a bare <li> around a menuitem) is caught by the same check', () => {
    const old = '<ul role="menu" aria-label="Reports"><li><a href="/reports" role="menuitem">Monthly Report</a></li></ul>';
    expect(bareListItemMenuItems(old).length).toBe(1);
    const fixed = '<ul role="menu" aria-label="Reports"><li role="none"><a href="/reports" role="menuitem">Monthly Report</a></li></ul>';
    expect(bareListItemMenuItems(fixed)).toEqual([]);
  });
});

// -- colour contrast ---------------------------------------------------------

const NAV_BG = [0x0f, 0x27, 0x47]; // tailwind.config.ts: nav
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (c: number[]) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const over = (bg: number[], fg: number[], alpha: number) => bg.map((b, i) => Math.round(alpha * fg[i] + (1 - alpha) * b));
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** White text at `alpha` over the sidebar, optionally on a lighter `bg-white/<n>` panel. */
function whiteTextContrast(alpha: number, panelAlpha = 0): number {
  const bg = panelAlpha > 0 ? over(NAV_BG, [255, 255, 255], panelAlpha) : NAV_BG;
  return contrast(over(bg, [255, 255, 255], alpha), bg);
}

/** Every `text-white/NN` (and hover:/bg pairing) the shell uses. */
function textAlphas(source: string): { alpha: number; hover: boolean; onActivePanel: boolean }[] {
  const out: { alpha: number; hover: boolean; onActivePanel: boolean }[] = [];
  for (const m of source.matchAll(/(?<![\w:-])(hover:)?text-white\/(\d+)/g)) out.push({ alpha: Number(m[2]) / 100, hover: Boolean(m[1]), onActivePanel: false });
  return out;
}

describe('sidebar colour contrast (axe: color-contrast, WCAG 1.4.3 needs 4.5:1)', () => {
  it('the contrast helper reproduces the 3.58:1 axe measured for white at 40 % on #0F2747', () => {
    expect(whiteTextContrast(0.4)).toBeCloseTo(3.58, 1);
    expect(whiteTextContrast(0.4)).toBeLessThan(4.5);
  });

  it('every resting text colour class in the shell is at least 4.5:1 on the sidebar', () => {
    const resting = textAlphas(SHELL_SOURCE).filter((t) => !t.hover);
    expect(resting.length).toBeGreaterThan(5);
    for (const t of resting) expect(whiteTextContrast(t.alpha), `text-white/${t.alpha * 100}`).toBeGreaterThanOrEqual(4.5);
  });

  it('the 10 px Admin group labels are gone: no text smaller than 12 px in the sidebar', () => {
    expect(SHELL_SOURCE).not.toMatch(/text-\[(?:9|10|11)px\]/);
  });

  it('the active link (white on the white/10 panel) is at least 4.5:1', () => {
    expect(whiteTextContrast(1, 0.1)).toBeGreaterThanOrEqual(4.5);
  });

  it('NEGATIVE CONTROL: white at 40 % (the old Admin group label) and at 50 % on the active panel are caught', () => {
    expect(whiteTextContrast(0.4)).toBeLessThan(4.5);
    expect(whiteTextContrast(0.5, 0.1)).toBeLessThan(4.5);
    const oldLabel = textAlphas('<p className="text-[10px] font-semibold uppercase tracking-wide text-white/40">General</p>').filter((t) => !t.hover);
    expect(oldLabel.some((t) => whiteTextContrast(t.alpha) < 4.5)).toBe(true);
  });
});
