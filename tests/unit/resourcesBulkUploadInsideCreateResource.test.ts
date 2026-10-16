/**
 * Resources Bulk Upload lives INSIDE Create Resource (PO decision 16-10-2026: "Bulk Upload lives inside Create Resource;
 * no separate sidebar group"). Navigation and placement only: no apply, staging, database, migration or API behaviour changes.
 *
 * Proves, with the real server pages driven under a mocked role resolver:
 *  - the Admin sidebar has NO Bulk Upload group or item for any capability combination (BU-1..BU-3);
 *  - the Create Resource page offers the Bulk Upload option only when the SERVER-side capability
 *    (canBulkImportResources, resources.content.bulk_import) is held, and a user without it does not see it (BU-4..BU-8);
 *  - the same on the Money Update create screen (BU-9..BU-10);
 *  - a direct URL to every importer page still redirects a caller without the capability (BU-11..BU-12);
 *  - the importer's parent is Create Resource and the page keeps its capability guard (BU-13..BU-14);
 *  - the PO decision is written in the docs (BU-15).
 * NEGATIVE CONTROLS (BU-N1, BU-N2) re-run the same assertions on a mutated source and require the mutation to be caught.
 * Hermetic: no database, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as adminNav from '@/lib/admin/adminNav';
import { buildAdminNavGroups, NO_ADMIN_CAPABILITIES, shouldShowAdminMenu, type AdminCapabilities } from '@/lib/admin/adminNav';
import { NewContentChooser } from '@/components/resources/editor/NewContentChooser';
import { MoneyUpdateNewChooser } from '@/components/resources/money-update/MoneyUpdateNewChooser';

type Roles = { userId: string | null; isSuperAdmin: boolean; roles: string[] };
const state: { current: Roles } = { current: { userId: 'u', isSuperAdmin: false, roles: [] } };

vi.mock('@/lib/resources/admin/access', () => ({ requireResourceAdminAccess: async () => state.current }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'user' }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ marker: 'admin' }) }));
vi.mock('@/lib/resources/import/staging', () => ({ listRuns: async () => [], getRun: async () => null, getRunRows: async () => [] }));
vi.mock('@/lib/resources/import/history', () => ({ toHistoryRows: async () => [] }));
vi.mock('@/lib/resources/editor/queries', () => ({ getEditorReferenceData: async () => ({}) }));
vi.mock('@/lib/resources/sources/queries', () => ({ searchSources: async () => [] }));

import ContentNewPage from '../../app/(app)/admin/resources/content/new/page';
import MoneyUpdateNewPage from '../../app/(app)/admin/resources/money-updates/new/page';
import ImportChooserPage from '../../app/(app)/admin/resources/import/page';
import ImportUploadPage from '../../app/(app)/admin/resources/import/upload/page';
import ImportHistoryPage from '../../app/(app)/admin/resources/import/history/page';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every page default export is `<><PageBackLink/><Content {...props}/></>`; return both halves so the REAL server component can be run. */
async function runPage(Page: (p: never) => React.ReactElement, props: unknown): Promise<{ backLink: React.ReactElement; html: string }> {
  const frag = (Page as unknown as (p: unknown) => React.ReactElement)(props);
  const [backLink, content] = React.Children.toArray((frag.props as { children: React.ReactNode }).children) as React.ReactElement[];
  const inner = await (content.type as unknown as (p: unknown) => Promise<React.ReactElement>)(content.props);
  return { backLink, html: renderToStaticMarkup(inner) };
}
const as = (roles: string[], isSuperAdmin = false) => {
  state.current = { userId: 'u', isSuperAdmin, roles };
};
const search = { searchParams: Promise.resolve({}) };

const ALL_ON = Object.fromEntries(Object.keys(NO_ADMIN_CAPABILITIES).map((k) => [k, true])) as unknown as AdminCapabilities;

beforeEach(() => as([]));

describe('BU-1..3 the Admin sidebar has no Bulk Upload group (PO decision 16-10-2026)', () => {
  it('BU-1: no nav constant points at the importer and BULK_UPLOAD_ITEMS no longer exists', () => {
    expect((adminNav as Record<string, unknown>).BULK_UPLOAD_ITEMS).toBeUndefined();
    for (const [name, value] of Object.entries(adminNav)) {
      if (!Array.isArray(value)) continue;
      for (const item of value as { label?: string; href?: string }[]) {
        expect(item.href ?? '', name).not.toMatch(/\/admin\/resources\/import/);
        expect(item.label ?? '', name).not.toMatch(/bulk upload/i);
      }
    }
  });
  it('BU-2: holding the capability, alone or with every other capability and Super Admin, adds no Bulk Upload group or item', () => {
    for (const isAdmin of [false, true]) {
      for (const caps of [{ ...NO_ADMIN_CAPABILITIES, resourceContentBulkImport: true }, ALL_ON]) {
        const groups = buildAdminNavGroups(isAdmin, caps);
        expect(groups.map((g) => g.label)).not.toContain('Bulk Upload');
        for (const g of groups) for (const i of g.items) expect(i.href).not.toMatch(/\/admin\/resources\/import/);
      }
    }
  });
  it('BU-3: the capability stays its own fail-closed field, but on its own it neither builds a group nor opens the Admin menu', () => {
    expect(NO_ADMIN_CAPABILITIES.resourceContentBulkImport).toBe(false);
    const only = { ...NO_ADMIN_CAPABILITIES, resourceContentBulkImport: true };
    expect(buildAdminNavGroups(false, only)).toEqual([]);
    expect(shouldShowAdminMenu(false, only)).toBe(false);
  });
});

describe('BU-4..8 Create Resource offers Bulk Upload only to a holder of the server-side capability', () => {
  it('BU-4: Editor, Resource Admin and Super Admin see a separate Bulk Upload section with the explanatory text and a link to the importer chooser', async () => {
    for (const [roles, sa] of [[['editor'], false], [['resource_admin'], false], [[], true]] as const) {
      as([...roles], sa);
      const { html } = await runPage(ContentNewPage as never, search);
      expect(html, roles.join()).toContain('What type of Resource would you like to create?');
      expect(html).toContain('id="bulk-upload-h"');
      expect(html).toContain('Create many Articles or Money Updates from one spreadsheet. Every item becomes a private draft.');
      expect(html).toMatch(/<a [^>]*href="\/admin\/resources\/import"[^>]*>Bulk Upload<\/a>/);
      // the three existing create cards are untouched
      for (const t of ['article', 'guide', 'fhip_explainer']) expect(html).toContain(`href="/admin/resources/content/new?type=${t}"`);
    }
  });
  it('BU-5: NEGATIVE: an Author (can create, lacks the capability) sees the three create cards and NO Bulk Upload option or link', async () => {
    as(['author']);
    const { html } = await runPage(ContentNewPage as never, search);
    expect(html).toContain('href="/admin/resources/content/new?type=article"');
    expect(html).not.toContain('Bulk Upload');
    expect(html).not.toContain('bulk-upload-h');
    expect(html).not.toContain('/admin/resources/import');
  });
  it('BU-6: NEGATIVE: Compliance Reviewer, Publisher and Analyst (cannot create) see only the denial, never the option', async () => {
    for (const r of ['compliance_reviewer', 'publisher', 'analyst']) {
      as([r]);
      const { html } = await runPage(ContentNewPage as never, search);
      expect(html, r).toContain("You don&#x27;t have permission to create Resources content.");
      expect(html, r).not.toContain('Bulk Upload');
      expect(html, r).not.toContain('/admin/resources/import');
    }
  });
  it('BU-7: the option cannot be turned on from the client: the URL carries no such switch, and the component fails closed by default', async () => {
    as(['author']);
    const { html } = await runPage(ContentNewPage as never, { searchParams: Promise.resolve({ canBulkImport: 'true', bulk: '1', type: undefined }) });
    expect(html).not.toContain('Bulk Upload');
    expect(renderToStaticMarkup(React.createElement(NewContentChooser, { canCreate: true }))).not.toContain('Bulk Upload');
    const page = read('app/(app)/admin/resources/content/new/page.tsx');
    expect(page).toContain('canBulkImport={canBulkImportResources(current)}');
    expect(page).not.toMatch(/searchParams[^;\n]*bulk/i);
  });
  it('BU-8: the section is accessible: a labelled region, a real link of at least 44 px (min-h-11), and it sits after the three cards', async () => {
    as(['editor']);
    const { html } = await runPage(ContentNewPage as never, search);
    expect(html).toMatch(/<section aria-labelledby="bulk-upload-h"/);
    expect(html).toMatch(/<h2 id="bulk-upload-h"[^>]*>Bulk Upload<\/h2>/);
    expect(html).toMatch(/<a [^>]*min-h-11[^>]*href="\/admin\/resources\/import"|<a [^>]*href="\/admin\/resources\/import"[^>]*min-h-11/);
    expect(html.indexOf('Create FHIP Explainer')).toBeGreaterThan(-1);
    expect(html.indexOf('bulk-upload-h')).toBeGreaterThan(html.indexOf('Create FHIP Explainer'));
  });
});

describe('BU-9..10 the Money Update create screen offers it consistently', () => {
  it('BU-9: a holder sees the Money Update wording and a link that opens the importer with Money Updates preselected', async () => {
    as(['editor']);
    const { html } = await runPage(MoneyUpdateNewPage as never, search);
    expect(html).toContain('Create many Money Updates from one spreadsheet. Every item becomes a private draft.');
    expect(html).toMatch(/href="\/admin\/resources\/import\/upload\?type=money_update"[^>]*>Bulk Upload<\/a>/);
    expect(html).toContain('href="/admin/resources/money-updates/new?type=money_update"');
  });
  it('BU-10: NEGATIVE: an Author and a default (no prop) render show no Bulk Upload on the Money Update create screen', async () => {
    as(['author']);
    const { html } = await runPage(MoneyUpdateNewPage as never, search);
    expect(html).not.toContain('Bulk Upload');
    expect(html).not.toContain('/admin/resources/import');
    expect(renderToStaticMarkup(React.createElement(MoneyUpdateNewChooser, { canCreate: true }))).not.toContain('Bulk Upload');
  });
});

describe('BU-11..12 direct URLs still redirect a caller without the capability (routes and guards unchanged)', () => {
  it('BU-11: Author and the read-only roles are redirected from the chooser, the uploader and the history', async () => {
    for (const r of ['author', 'compliance_reviewer', 'publisher', 'analyst']) {
      as([r]);
      await expect(runPage(ImportChooserPage as never, {}), r).rejects.toThrow('REDIRECT:/admin/resources');
      await expect(runPage(ImportUploadPage as never, { searchParams: Promise.resolve({ type: 'article' }) }), r).rejects.toThrow('REDIRECT:/admin/resources');
      await expect(runPage(ImportHistoryPage as never, {}), r).rejects.toThrow('REDIRECT:/admin/resources');
    }
  });
  it('BU-12: a holder still reaches the chooser and the uploader (the routes were not removed)', async () => {
    as(['editor']);
    const chooser = await runPage(ImportChooserPage as never, {});
    expect(chooser.html).toContain('What would you like to upload?');
    expect(chooser.html).toContain('href="/admin/resources/import/upload?type=article"');
    expect(chooser.html).toContain('href="/admin/resources/import/upload?type=money_update"');
    const up = await runPage(ImportUploadPage as never, { searchParams: Promise.resolve({ type: 'money_update' }) });
    expect(up.html).toContain('Upload');
  });
});

describe('BU-13..14 the importer is a child of Create Resource', () => {
  const backTarget = (el: React.ReactElement) => ({ href: (el.props as { href: string }).href, label: (el.props as { label: string }).label });
  it('BU-13: the chooser back link and breadcrumb lead to Create Resource; the sub-pages still return to the chooser', async () => {
    as(['editor']);
    const chooser = await runPage(ImportChooserPage as never, {});
    expect(backTarget(chooser.backLink)).toEqual({ href: '/admin/resources/content/new', label: 'Create Resource' });
    expect(chooser.html).toContain('href="/admin/resources/content/new"');
    const up = await runPage(ImportUploadPage as never, { searchParams: Promise.resolve({ type: 'article' }) });
    expect(backTarget(up.backLink)).toEqual({ href: '/admin/resources/import', label: 'Bulk Upload' });
    expect(up.html).toContain('href="/admin/resources/content/new"');
    const hist = await runPage(ImportHistoryPage as never, {});
    expect(backTarget(hist.backLink)).toEqual({ href: '/admin/resources/import', label: 'Bulk Upload' });
    expect(hist.html).toContain('href="/admin/resources/content/new"');
  });
  it('BU-14: the page guard is still the capability redirect and no import page points back at a Bulk Upload module root outside the chain', () => {
    const src = read('app/(app)/admin/resources/import/page.tsx');
    expect(src).toMatch(/if \(!canBulkImportResources\(current\)\) redirect\('\/admin\/resources'\);/);
    expect(src).toContain('<PageBackLink href="/admin/resources/content/new" label="Create Resource" />');
    expect(read('docs/ux/BACK_NAVIGATION_INVENTORY.md')).toContain('`/admin/resources/content/new`: "Back to Create Resource"');
  });
});

describe('BU-15 the PO decision is written in the docs', () => {
  const DECISION = 'Bulk Upload lives inside Create Resource; no separate sidebar group';
  it('names the decision with its date in the feature doc, runbook, security note and certification', () => {
    for (const f of ['RESOURCE_BULK_UPLOAD.md', 'RESOURCE_BULK_UPLOAD_RUNBOOK.md', 'RESOURCE_BULK_UPLOAD_SECURITY.md', 'RESOURCE_BULK_UPLOAD_CERTIFICATION.md']) {
      const doc = read(`docs/resources/${f}`);
      expect(doc, f).toContain('16-10-2026');
      expect(doc, f).toContain(DECISION);
    }
  });
});

describe('negative controls: the assertions bite', () => {
  it('BU-N1: if the page passed the option to everyone, BU-5 would fail (an Author would see Bulk Upload)', () => {
    const mutated = renderToStaticMarkup(React.createElement(NewContentChooser, { canCreate: true, canBulkImport: true }));
    expect(mutated).toContain('Bulk Upload');
    expect(mutated).toContain('/admin/resources/import');
  });
  it('BU-N2: if the sidebar group came back, BU-2 would see it', () => {
    const restored = [{ label: 'Bulk Upload', items: [{ label: 'Bulk Upload', href: '/admin/resources/import' }], matchMode: 'prefix' }];
    expect(restored.map((g) => g.label)).toContain('Bulk Upload');
    expect(restored[0].items[0].href).toMatch(/\/admin\/resources\/import/);
    // and the shipped source really lacks it:
    expect(read('lib/admin/adminNav.ts')).not.toMatch(/label: 'Bulk Upload'/);
  });
});
