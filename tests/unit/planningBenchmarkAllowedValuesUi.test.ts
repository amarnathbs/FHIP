// Planning Benchmarks upload: the collapsible "Allowed values" panel on the Upload tab (three parts: Columns,
// Allowed datasets and metrics, Cohorts). Evidence label: UNIT-TESTED by server render of the pure view with
// lists derived through the real loader; the repo has no jsdom, so interaction is not simulated and the panel is
// not browser-verified here. Accessibility is asserted structurally (captions, th scope, named focusable scroll
// regions, a labelled select).
//
// NAMED NEGATIVE CONTROL
//   NC-P1  unavailable lists are never rendered as empty tables: the panel says so and still shows the column guide.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createInMemoryDb } from './support/inMemorySupabase';
import { FIXTURE_TODAY, pbReferenceTables } from './support/pbAllowedFixture';
import { loadAllowedValues, UNAVAILABLE_LINE, type AllowedValuesOk } from '@/lib/planning-benchmarks/allowedValues';
import { AllowedValuesPanel, AllowedValuesView, ColumnGuide, summaryText, ALLOWED_VALUES_CSV_URL } from '@/components/admin/PlanningBenchmarkAllowedValues';
import { PlanningBenchmarkUpload } from '@/components/admin/PlanningBenchmarkUpload';
import { UPLOAD_KINDS, XLSX_README_SHEET, columnGuide } from '@/lib/planning-benchmarks/uploadSchema';
import { buildTemplateXlsx } from '@/lib/planning-benchmarks/uploadTemplates';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

async function lists(): Promise<AllowedValuesOk> {
  const db = createInMemoryDb();
  db.reset(pbReferenceTables() as Record<string, never[]>);
  const r = await loadAllowedValues(db.client as never, FIXTURE_TODAY);
  if (r.state !== 'ok') throw new Error('lists');
  return r;
}

describe('Allowed values panel', () => {
  it('shows the datasets, metrics with units and cohorts, with the counts in the headings', async () => {
    const av = await lists();
    const html = renderToStaticMarkup(createElement(AllowedValuesView, { data: av }));
    const t = text(html);
    expect(t).toContain('3 datasets are open for upload today');
    expect(t).toContain('4 metrics are registered and can be uploaded to (3 active)');
    expect(t).toContain('2 cohorts exist');
    for (const d of av.datasets) expect(t).toContain(d.name);
    expect(t).toContain('AU household debt context');
    expect(t).toMatch(/AU household debt context 1\.0 observed_market superseded .* none \(status is superseded\)/);
    for (const m of av.metrics) expect(t).toMatch(new RegExp(`${m.code} ${m.name.replace(/[()]/g, '.')} ${m.unit}`));
    for (const c of av.cohorts) expect(t).toContain(c.code);
    expect(t).toContain('Part 2. Allowed datasets and metrics');
    expect(t).toContain('Part 3. Cohorts');
  });

  it('is accessible: captioned tables, column-scoped headers, named and keyboard-focusable scroll regions, headings in order', async () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(ColumnGuide), createElement(AllowedValuesView, { data: await lists() })));
    expect((html.match(/<caption class="sr-only">/g) ?? []).length).toBe(4);
    expect((html.match(/<th scope="col"/g) ?? []).length).toBeGreaterThanOrEqual(16);
    expect(html).not.toMatch(/<th (?!scope)/);
    const regions = html.match(/<div role="region" aria-label="[^"]+" tabindex="0"/g) ?? [];
    expect(regions.length).toBe(4);
    expect(html).toMatch(/<label for="[^"]+"[^>]*><span>Kind of file<\/span><select id="[^"]+"/);
    expect(html.indexOf('Part 1.')).toBeLessThan(html.indexOf('Part 2.'));
    expect(html.indexOf('Part 2.')).toBeLessThan(html.indexOf('Part 3.'));
  });

  it('NC-P1: unavailable lists say so (never empty tables), and the column guide is still there', () => {
    const view = renderToStaticMarkup(createElement(AllowedValuesView, { data: { state: 'unavailable', reason: 'x' } }));
    expect(text(view)).toContain(UNAVAILABLE_LINE);
    expect(view).not.toContain('<table');
    expect(summaryText({ state: 'unavailable', reason: 'x' })).toMatch(/unavailable/);
    expect(renderToStaticMarkup(createElement(ColumnGuide))).toContain('<table');
  });

  it('the panel starts collapsed, shows a loading state (not an empty list), offers the CSV, and carries the column guide', () => {
    const html = renderToStaticMarkup(createElement(AllowedValuesPanel));
    expect(html).toMatch(/<details[^>]*data-testid="pb-allowed-panel"/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('Allowed values and column guide');
    expect(html).toContain('Loading the allowed values');
    expect(html).toContain(`href="${ALLOWED_VALUES_CSV_URL.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('Part 1. Columns');
    expect(html).not.toContain('Part 2.'); // the lists appear only once they are loaded
  });

  it('the Upload tab offers the "Allowed values (CSV)" link next to the template buttons and mounts the panel', () => {
    const src = read('components/admin/PlanningBenchmarkUpload.tsx');
    expect(src).toContain('Allowed values (CSV)');
    expect(src).toContain('<AllowedValuesPanel />');
    expect(src.indexOf('Excel template')).toBeLessThan(src.indexOf('Allowed values (CSV)'));
    expect(src.indexOf('Allowed values (CSV)')).toBeLessThan(src.indexOf('<AllowedValuesPanel />'));
    // the initial server render of the whole screen is still an explicit loading state
    expect(text(renderToStaticMarkup(createElement(PlanningBenchmarkUpload)))).toMatch(/Loading/);
  });

  it('no year-first date text in the panel source', () => {
    const src = read('components/admin/PlanningBenchmarkAllowedValues.tsx');
    expect(/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(src) || /yyyy-mm-dd/i.test(src)).toBe(false);
  });
});

describe('the column guide, the Read me column table and the panel are one source (cannot drift)', () => {
  it('for every kind the Read me Column | Required | Type | Description rows equal columnGuide(kind), and the panel prints them', () => {
    for (const kind of UPLOAD_KINDS) {
      const wb = XLSX.read(buildTemplateXlsx(kind), { type: 'array' });
      const rows = (XLSX.utils.sheet_to_json(wb.Sheets[XLSX_README_SHEET], { header: 1, defval: '' }) as unknown[][]).map((r) => r.map(String));
      const start = rows.findIndex((r) => r[0] === 'Column' && r[1] === 'Required' && r[2] === 'Type' && r[3] === 'Description');
      expect(start).toBeGreaterThan(0);
      const guide = columnGuide(kind);
      expect(rows.slice(start + 1, start + 1 + guide.length)).toEqual(guide.map((g) => [g.name, g.required, g.type, g.description]));
    }
    // the panel prints the same rows for its default kind (values); the other kinds come from the same function
    const t = text(renderToStaticMarkup(createElement(ColumnGuide)));
    for (const g of columnGuide('values')) {
      expect(t).toContain(g.name);
      expect(t).toContain(g.description);
    }
    const src = read('components/admin/PlanningBenchmarkAllowedValues.tsx');
    expect(src).toMatch(/columnGuide\(kind\)/);
    expect(read('lib/planning-benchmarks/uploadTemplates.ts')).toMatch(/columnGuide\(kind\)/);
  });
});
