// II-PC2 — structural UI contract (spec sections 11, 15, 16, 31, 40, 52).
//
// WHY THIS SUITE READS SOURCE FILES
// ---------------------------------
// This repository's vitest baseline is node-environment only — there is no
// jsdom and no @testing-library (see vitest.config.ts), so a rendered-DOM
// assertion is not available. Several existing suites therefore assert UI
// contracts structurally against source text (see
// tests/unit/aiContextualExplainUiContract.test.ts). PC2 follows that
// established pattern for the handful of guarantees that are genuinely about
// what the files contain rather than what a pure function returns.
//
// These are deliberately NARROW, high-signal assertions about properties that
// would silently regress: an engine import creeping into the Overview, a page
// losing its sub-navigation, or the CSV claim returning.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with block comments removed.
 *
 * Needed because PC2's own code comments quote the strings they removed (e.g.
 * the comment explaining why "PDF or CSV file" was wrong). A raw substring
 * search would match the explanation and report the defect as still present,
 * so any "this text must be gone" assertion runs against stripped source.
 * Line comments are left intact — none of the assertions below can collide
 * with one, and stripping `//` would corrupt URLs.
 */
const readCode = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '');

const WORKSPACE_PAGES = [
  'app/(app)/investment-intelligence/page.tsx',
  'app/(app)/investment-intelligence/data/page.tsx',
  'app/(app)/investment-intelligence/performance/page.tsx',
  'app/(app)/investment-intelligence/sip/page.tsx',
  'app/(app)/investment-intelligence/xray/page.tsx',
  'app/(app)/investment-intelligence/tax/page.tsx',
  'app/(app)/investment-intelligence/review/page.tsx',
];

describe('Persistent sub-navigation (spec section 31)', () => {
  it('renders on every workspace page', () => {
    for (const page of WORKSPACE_PAGES) {
      const src = read(page);
      expect(src, `${page} must render the workspace sub-navigation`).toContain('<InvestmentIntelligenceSubNav />');
      expect(src).toContain("from '@/components/investment-intelligence/InvestmentIntelligenceSubNav'");
    }
  });

  it('is the ONLY nav array — no page defines its own', () => {
    // Spec section 31: "no duplicated independent nav arrays across pages".
    for (const page of WORKSPACE_PAGES) {
      const src = read(page);
      expect(src).not.toMatch(/const\s+(TABS|NAV_ITEMS|LINKS)\s*=/);
    }
  });

  it('marks the active item with aria-current rather than colour alone', () => {
    const src = read('components/investment-intelligence/InvestmentIntelligenceSubNav.tsx');
    expect(src).toContain('aria-current');
    expect(src).toContain('aria-label="Investment Intelligence sections"');
    // Weight change accompanies the colour change (spec section 35).
    expect(src).toContain('font-semibold');
  });
});

describe('Overview runs no analytics engine (spec sections 11, 40)', () => {
  const OVERVIEW_SOURCES = [
    'app/api/investment-intelligence/overview/route.ts',
    'lib/services/investment-intelligence/overviewSummary.ts',
    'components/investment-intelligence/OverviewClient.tsx',
    'app/(app)/investment-intelligence/page.tsx',
  ];

  it('imports no calculation engine anywhere on the Overview path', () => {
    // The structural guarantee behind spec section 40. If someone later
    // "improves" the Overview by importing runAnalytics/runSipAnalytics/
    // runXrayAnalytics/runTaxSimulation, this fails immediately.
    for (const file of OVERVIEW_SOURCES) {
      const src = readCode(file);
      expect(src, `${file} must not import an engine`).not.toMatch(/from '@\/lib\/engines\/investment-intelligence\/[^']*(Orchestrator|Engine)'/);
      for (const forbidden of ['runAnalytics', 'runSipAnalytics', 'runXrayAnalytics', 'runTaxSimulation', 'runReviewCentreRefresh']) {
        expect(src, `${file} must not call ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never fetches an engine-executing analytics route from the client', () => {
    // Three of these PERSIST derived rows on GET; calling them to draw status
    // cards would rewrite the user's tax lots just by opening the page.
    const src = read('components/investment-intelligence/OverviewClient.tsx');
    for (const route of [
      '/api/investment-intelligence/analytics',
      '/api/investment-intelligence/sip',
      '/api/investment-intelligence/xray',
      '/api/investment-intelligence/tax/summary',
    ]) {
      expect(src, `Overview must not fetch ${route}`).not.toContain(route);
    }
    expect(src).toContain("fetch('/api/investment-intelligence/overview')");
  });

  it('uses only the RLS request client, never the service-role client', () => {
    // Spec section 48: the new aggregation surface must not widen tenancy.
    for (const file of ['app/api/investment-intelligence/overview/route.ts', 'lib/services/investment-intelligence/overviewSummary.ts']) {
      expect(read(file), `${file} must not use the admin client`).not.toContain('createAdminClient');
    }
    expect(read('app/api/investment-intelligence/overview/route.ts')).toContain('requireCountryConfirmedUser');
  });
});

describe('Import UX describes only what the workflow supports (spec section 15)', () => {
  const src = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');
  const code = readCode('components/investment-intelligence/InvestmentIntelligenceClient.tsx');

  it('no longer advertises CSV as a supported statement format', () => {
    // The parser registry holds exactly two adapters, both PDF-statement
    // text parsers. A CSV uploaded here can only ever end as `unsupported`.
    expect(code).not.toContain('PDF or CSV file');
    expect(code).not.toContain('accept=".pdf,.csv,application/pdf,text/csv"');
    expect(code).toContain('Statement file (PDF)');
  });

  it('accepts only PDF at the file input', () => {
    expect(src).toContain('accept=".pdf,application/pdf"');
  });

  it('states positively that CSV is not supported by this workflow', () => {
    expect(src).toMatch(/broker CSV files are not supported/i);
  });

  it('keeps the backend validator unchanged — capability is not removed', () => {
    // Spec section 15 forbids removing backend capability another path may
    // legitimately use; only the user-facing claim was corrected.
    const storage = read('lib/services/investment-intelligence/storage.ts');
    expect(storage).toContain("ALLOWED_MIME_TYPES = ['application/pdf', 'text/csv']");
  });

  it('labels the file input for assistive technology (spec section 35)', () => {
    expect(src).toContain('htmlFor="ii-statement-file"');
    expect(src).toContain('id="ii-statement-file"');
  });
});

describe('Document password handling (spec section 16)', () => {
  const src = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');

  it('clears the password on EVERY outcome, including a wrong-password rejection', () => {
    // The regression fixed here: the clear sat after a `throw`, so the one
    // case where the password most reliably lingered was a rejection — when
    // it is still a live secret.
    const handler = src.slice(src.indexOf('async function handleProcess'), src.indexOf('async function handleResolveCase'));
    const finallyIndex = handler.indexOf('} finally {');
    const clearIndex = handler.indexOf("setPasswordInputs((prev) => ({ ...prev, [id]: '' }))");
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(finallyIndex);
  });

  it('never renders the password as readable text', () => {
    expect(src).toContain('type="password"');
  });

  it('does not log or persist the password', () => {
    expect(src).not.toMatch(/console\.(log|info|warn|error)\([^)]*password/i);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe('Global navigation is not overloaded (spec section 32)', () => {
  it('keeps exactly one Investment Intelligence entry in the app sidebar', () => {
    // Preferred design: the sidebar shows the workspace once, and the
    // workspace carries its own sub-navigation.
    const shell = read('components/ui/AppShell.tsx');
    const matches = shell.match(/href: '\/investment-intelligence[^']*'/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe("href: '/investment-intelligence'");
  });
});
