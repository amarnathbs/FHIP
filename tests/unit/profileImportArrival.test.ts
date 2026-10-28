/**
 * PO defect 28-10-2026 (production, Free account): "Import bank statement [Premium]" on Expenses landed on the TOP of the
 * Profile page with no explanation and no move to the plan section; nothing read the `from` query parameter.
 *
 * Rendered with react-dom/server (the repository's component-test technique). The page is rendered with and without the
 * parameter, for Free and Premium, for every domain in the contract, and for unknown values. The scroll / focus move and
 * the "View plans" control are proved by calling the real handlers with a stand-in browser.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINANCIAL_IMPORT_DOMAINS,
  FINANCIAL_IMPORT_PLAN_SECTION_ID,
  financialImportUpgradeHref,
  parseImportArrivalDomain,
  type FinancialImportDomain,
} from '@/lib/entitlements/financialDataImportContract';
import { focusPlanSection, prefersReducedMotion } from '@/lib/entitlements/importArrival';

type View = { state: 'allowed' } | { state: 'premium_required' } | { state: 'unavailable' } | null;
const h = vi.hoisted(() => ({ access: null as View, from: null as string | null }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (k: string) => (k === 'from' ? h.from : null) }),
}));
vi.mock('@/lib/entitlements/useFinancialImportAccess', () => ({
  useFinancialImportAccess: () => ({ access: h.access, noteResponse: () => false }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock('@/components/navigation/PageBackLink', () => ({ PageBackLink: () => null }));
vi.mock('@/components/profile/BillingPanel', () => ({ BillingPanel: () => createElement('div', { 'data-testid': 'billing-panel' }, 'Plan: Free') }));

import ProfilePage from '@/app/(app)/profile/page';
import { ImportArrivalNotice, IMPORT_ARRIVAL_BODY_ID, IMPORT_ARRIVAL_HEADING_ID, importArrivalCopy } from '@/components/profile/ImportArrivalNotice';
import { ProfilePlanSection } from '@/components/profile/ProfilePlanSection';

const renderPage = () => renderToStaticMarkup(createElement(ProfilePage));

beforeEach(() => {
  h.access = null;
  h.from = null;
});

describe('the locked Import control still links with the domain only', () => {
  it('builds /profile?from=import-<domain> for every domain and carries nothing else', () => {
    for (const d of FINANCIAL_IMPORT_DOMAINS) {
      const href = financialImportUpgradeHref(d);
      expect(href).toBe(`/profile?from=import-${d}`);
      expect(new URL(href, 'https://x.invalid').searchParams.size).toBe(1);
    }
  });
});

describe('parseImportArrivalDomain: strict allow-list', () => {
  it('round-trips every domain the contract builds', () => {
    for (const d of FINANCIAL_IMPORT_DOMAINS) {
      expect(parseImportArrivalDomain(new URL(financialImportUpgradeHref(d), 'https://x.invalid').searchParams.get('from'))).toBe(d);
    }
  });
  it('ignores missing, empty, other-prefix, unknown, wrong-case, padded and hostile values', () => {
    const bad = [null, undefined, '', 'import-', 'import-bogus', 'import-Expenses', 'IMPORT-expenses', 'import-expenses ', ' import-expenses', 'export-expenses', 'expenses',
      'import-expenses&x=1', 'import-__proto__', 'import-constructor', 'import-<script>alert(1)</script>', 'import-expenses,income'];
    for (const v of bad) expect(parseImportArrivalDomain(v as string | null | undefined)).toBeNull();
  });
});

describe('Profile page: the arrival notice (Free person)', () => {
  it('without the parameter there is no notice', () => {
    h.access = { state: 'premium_required' };
    expect(renderPage()).not.toContain('import-arrival-notice');
  });

  it('with an unknown parameter value there is no notice and nothing from the URL is echoed', () => {
    h.access = { state: 'premium_required' };
    h.from = 'import-<script>alert(1)</script>';
    const out = renderPage();
    expect(out).not.toContain('import-arrival-notice');
    expect(out).not.toContain('alert(1)');
  });

  it.each(FINANCIAL_IMPORT_DOMAINS.map((d) => [d]))('%s: names what was tried, why, the fix, and the manual alternative', (domain) => {
    h.access = { state: 'premium_required' };
    h.from = `import-${domain}`;
    const out = renderPage();
    const copy = importArrivalCopy(domain as FinancialImportDomain);
    expect(out).toContain('data-testid="import-arrival-notice"');
    expect(out).toContain(`data-domain="${domain}"`);
    // what happened
    expect(out).toContain(`${copy.attempt} is part of Premium`);
    expect(out).toContain(copy.control);
    // why
    expect(out).toContain('Uploading a statement and reading it automatically is a Premium feature');
    // how to fix, with a working control
    expect(out).toContain('choose a plan in the Billing section below');
    expect(out).toContain('View plans and upgrade');
    expect(out).toContain(`href="#${FINANCIAL_IMPORT_PLAN_SECTION_ID}"`);
    // the manual alternative is named, and linked when the module has a page
    expect(out).toContain(`${copy.manual} stays free on every plan`);
    if (copy.manualHref) expect(out).toContain(`href="${copy.manualHref}"`);
  });

  it('is at the top of the page, before any other content', () => {
    h.access = { state: 'premium_required' };
    h.from = 'import-expenses';
    const out = renderPage();
    // Page is in its loading state during server render: the heading and the notice are the first things, and the notice is present.
    expect(out.indexOf('<h1')).toBeLessThan(out.indexOf('import-arrival-notice'));
    expect(out).toContain('Importing a bank statement is part of Premium');
  });
});

describe('Profile page: Premium and not-yet-known plans never see the notice', () => {
  it('Premium (allowed) with a valid parameter: no notice', () => {
    h.access = { state: 'allowed' };
    for (const d of FINANCIAL_IMPORT_DOMAINS) {
      h.from = `import-${d}`;
      expect(renderPage()).not.toContain('import-arrival-notice');
    }
  });
  it('plan still resolving (null): no notice flashes up', () => {
    h.access = null;
    h.from = 'import-expenses';
    expect(renderPage()).not.toContain('import-arrival-notice');
  });
  it('plan could not be confirmed (unavailable): no false "you are on Free" claim', () => {
    h.access = { state: 'unavailable' };
    h.from = 'import-expenses';
    expect(renderPage()).not.toContain('import-arrival-notice');
  });
});

describe('accessibility of the notice', () => {
  const out = renderToStaticMarkup(createElement(ImportArrivalNotice, { domain: 'expenses' }));

  it('is a named region whose name is its own heading, and the heading is a level-2 heading below the page h1', () => {
    expect(out).toMatch(new RegExp(`<section[^>]*aria-labelledby="${IMPORT_ARRIVAL_HEADING_ID}"`));
    expect(out).toMatch(new RegExp(`<h2 id="${IMPORT_ARRIVAL_HEADING_ID}"`));
    expect(out.match(/<h[1-6]/g)).toHaveLength(1);
  });
  it('the View plans control is a real link with visible text and a visible focus style (not a div or an empty icon)', () => {
    const m = out.match(/<a [^>]*data-testid="import-arrival-view-plans"[^>]*>([^<]*)<\/a>/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('View plans and upgrade');
    expect(m![0]).toContain('focus-visible:ring-2');
  });
  it('the notice does not steal focus (no autofocus / tabindex); focus is moved to the plan section instead', () => {
    expect(out).not.toMatch(/autofocus|tabindex/i);
  });
  it('the plan section is a focusable-by-script, named group at the anchor id, described by the notice body when present', () => {
    const withNotice = renderToStaticMarkup(createElement(ProfilePlanSection, { describedBy: IMPORT_ARRIVAL_BODY_ID }));
    expect(withNotice).toContain(`id="${FINANCIAL_IMPORT_PLAN_SECTION_ID}"`);
    expect(withNotice).toContain('role="group"');
    expect(withNotice).toContain('aria-label="Billing and plan"');
    expect(withNotice).toContain('tabindex="-1"');
    expect(withNotice).toContain(`aria-describedby="${IMPORT_ARRIVAL_BODY_ID}"`);
    expect(out).toContain(`id="${IMPORT_ARRIVAL_BODY_ID}"`);
    expect(withNotice).toContain('Billing');
    expect(withNotice).toContain('billing-panel');
    const without = renderToStaticMarkup(createElement(ProfilePlanSection, {}));
    expect(without).not.toContain('aria-describedby');
    expect(without).toContain(`id="${FINANCIAL_IMPORT_PLAN_SECTION_ID}"`);
  });
});

describe('moving the person to the plan section', () => {
  function stand(opts: { present?: boolean; reduced?: boolean | 'unsupported' | 'throws' }) {
    const calls: { scroll?: unknown; focus?: unknown; asked?: string } = {};
    const el = { scrollIntoView: (o?: unknown) => { calls.scroll = o; }, focus: (o?: unknown) => { calls.focus = o; } };
    const env = {
      getElementById: (id: string) => { calls.asked = id; return opts.present === false ? null : el; },
      matchMedia: opts.reduced === 'unsupported' ? undefined : (q: string) => {
        if (opts.reduced === 'throws') throw new Error('nope');
        expect(q).toBe('(prefers-reduced-motion: reduce)');
        return { matches: opts.reduced === true };
      },
    };
    return { env, calls };
  }

  it('scrolls smoothly and focuses without a second scroll when motion is allowed', () => {
    const { env, calls } = stand({ reduced: false });
    expect(focusPlanSection(env)).toBe(true);
    expect(calls.asked).toBe(FINANCIAL_IMPORT_PLAN_SECTION_ID);
    expect(calls.scroll).toEqual({ behavior: 'smooth', block: 'start' });
    expect(calls.focus).toEqual({ preventScroll: true });
  });
  it('respects prefers-reduced-motion: jumps, does not animate', () => {
    const { env, calls } = stand({ reduced: true });
    expect(focusPlanSection(env)).toBe(true);
    expect(calls.scroll).toEqual({ behavior: 'auto', block: 'start' });
  });
  it('unknown motion preference is treated as reduced', () => {
    expect(prefersReducedMotion({ matchMedia: undefined })).toBe(true);
    expect(stand({ reduced: 'unsupported' }).env.matchMedia).toBeUndefined();
    const { env, calls } = stand({ reduced: 'throws' });
    expect(focusPlanSection(env)).toBe(true);
    expect(calls.scroll).toEqual({ behavior: 'auto', block: 'start' });
  });
  it('returns false (so the page retries) when the section is not drawn yet, and never throws', () => {
    const { env, calls } = stand({ present: false });
    expect(focusPlanSection(env)).toBe(false);
    expect(calls.scroll).toBeUndefined();
    expect(calls.focus).toBeUndefined();
  });

  it('the "View plans and upgrade" control, when clicked, prevents the jump to a bare hash and runs the move', () => {
    const found: { onClick?: (e: { preventDefault(): void }) => void; href?: string } = {};
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!isValidElement(n)) return;
      const el = n as ReactElement<{ children?: ReactNode; onClick?: (e: { preventDefault(): void }) => void; href?: string; 'data-testid'?: string }>;
      if (el.props['data-testid'] === 'import-arrival-view-plans') { found.onClick = el.props.onClick; found.href = el.props.href; }
      walk(el.props.children);
    };
    walk(ImportArrivalNotice({ domain: 'income' }));
    expect(found.href).toBe(`#${FINANCIAL_IMPORT_PLAN_SECTION_ID}`);
    expect(found.onClick).toBeTypeOf('function');

    const calls: string[] = [];
    const el = { scrollIntoView: () => calls.push('scroll'), focus: () => calls.push('focus') };
    vi.stubGlobal('document', { getElementById: (id: string) => (id === FINANCIAL_IMPORT_PLAN_SECTION_ID ? el : null) });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    try {
      let prevented = false;
      found.onClick!({ preventDefault: () => { prevented = true; } });
      expect(prevented).toBe(true);
      expect(calls).toEqual(['scroll', 'focus']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('wiring (the page really uses the pieces)', () => {
  it('the profile page mounts the plan anchor section and the arrival hook, inside Suspense', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/(app)/profile/page.tsx', 'utf8');
    expect(src).toContain('<ProfilePlanSection');
    expect(src).toContain('useImportArrival()');
    expect(src).toContain('<Suspense');
    expect(src).not.toContain("<BillingPanel />");
  });
});
