// Resources Bulk Upload tables on the shared table mechanism (stack r4: S4 meets the global table layout, 15-10-2026).
//
// The two tables of this feature -- the "Recent imports" history and the import preview "Rows" table -- used to be raw
// <table> elements with a fixed min-w. The repository-wide guard (tests/unit/dataTableGuard.test.ts) forbids that, so both now
// use <DataTable>. EVIDENCE LABEL: UNIT-TESTED by static render (no DOM in this repository). Nothing here proves layout in a
// browser; the shared mechanism's browser proof is scripts/a11y/dataTableCheck.mjs and does not include these two tables.
//
// What is pinned: the accessible names the tables had before (region label and caption), every column header, the link to the
// run, the status text, the row toggle button with its ARIA state, the detail-row colSpan, and that no hard-coded min-w or
// hand-made overflow wrapper is left (the mechanism provides the scroll region). Dates stay day-first (dd/mm/yyyy, AU).
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ImportHistoryTable, type HistoryRow } from '@/components/resources/import/ImportHistoryTable';
import { ImportPreview, type PreviewRow, type PreviewRun } from '@/components/resources/import/ImportPreview';

const root = path.resolve(__dirname, '..', '..');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const historyRows: HistoryRow[] = [
  { id: 'run-1', content_type: 'article', file_name: 'articles-oct.xlsx', status: 'applied', row_count: 12, valid_count: 12, error_count: 0, created_post_count: 12, created_at: '2026-10-15T03:30:00.000Z', actor_label: 'Editor One' },
  { id: 'run-2', content_type: 'money_update', file_name: 'updates.xlsx', status: 'has_errors', row_count: 4, valid_count: 1, error_count: 3, created_post_count: 0, created_at: '2026-10-14T23:05:00.000Z', actor_label: 'Editor Two' },
];

describe('ImportHistoryTable on the shared DataTable', () => {
  const html = renderToStaticMarkup(h(ImportHistoryTable, { rows: historyRows }));

  it('keeps the accessible names: a labelled focusable region and the Recent imports caption', () => {
    expect(html).toMatch(/role="region"[^>]*aria-label="Recent imports \(scrollable\)"[^>]*tabindex="0"/);
    expect(html).toContain('<caption class="sr-only">Recent imports</caption>');
    expect((html.match(/<table/g) ?? []).length).toBe(1);
  });

  it('keeps all seven column headers as column headers', () => {
    for (const name of ['Date', 'File', 'Type', 'Actor', 'Rows', 'Result', 'Status']) {
      expect(html).toMatch(new RegExp(`<th[^>]*scope="col"[^>]*>${name}</th>`));
    }
  });

  it('keeps behaviour: link to each run, status text, row count, result wording, day-first date', () => {
    expect(html).toContain('href="/admin/resources/import/runs/run-1"');
    expect(html).toContain('href="/admin/resources/import/runs/run-2"');
    expect(html).toContain('Applied');
    expect(html).toContain('Has errors');
    expect(html).toContain('12 created');
    expect(html).toContain('3 with errors, nothing created');
    expect(html).toContain('Article');
    expect(html).toContain('Money Update');
    // 15 October 2026 (AU, day-first), never an ISO or US-order date.
    expect(html).toMatch(/15\/10\/2026/);
    expect(html).not.toMatch(/2026-10-1[45]/);
    expect(html).not.toMatch(/10\/15\/2026/);
  });

  it('never wraps or clamps dates, counts and statuses; clamps only plain descriptive text', () => {
    expect(html).toMatch(/<td[^>]*data-cell-kind="date"/);
    expect(html).toMatch(/<td[^>]*data-cell-kind="num"[^>]*>12<\/td>/);
    expect(html).toMatch(/<td[^>]*data-cell-kind="status"/);
    expect(html).toMatch(/<td[^>]*data-cell-kind="clamp"/);
    // The file-name cell holds a link and stays plain text (the clamp control is for plain text only).
    expect(html).not.toMatch(/data-cell-kind="clamp"[^>]*><span[^>]*><a /);
  });

  it('shows the empty message and no table when there is nothing', () => {
    const empty = renderToStaticMarkup(h(ImportHistoryTable, { rows: [], emptyText: 'No imports yet.' }));
    expect(empty).toContain('No imports yet.');
    expect(empty).not.toContain('<table');
  });
});

const run = {
  id: 'run-9', content_type: 'article', file_name: 'a.xlsx', template_version: '1.0', status: 'ready', row_count: 2, valid_count: 1, warning_count: 1,
  error_count: 1, created_post_count: 0, failure_code: null, failure_message_safe: null, file_issues: [], created_at: '2026-10-15T03:30:00.000Z', applied_at: null,
  expires_at: '2026-10-22T03:30:00.000Z',
} as unknown as PreviewRun;

const previewRows = [
  { row_number: 2, title: 'How to read a payslip', slug: 'how-to-read-a-payslip', display: { jurisdiction: 'australia', compliance_classification: 'general_information', primary_category: 'Tax' }, validation_errors: [], validation_warnings: [{ code: 'NOTE', message: 'note', field: null }], result_post_id: null, result_status: 'pending' },
  { row_number: 3, title: null, slug: null, display: {}, validation_errors: [{ code: 'TITLE_MISSING', message: 'Title is required', field: 'title' }], validation_warnings: [], result_post_id: null, result_status: 'pending' },
] as unknown as PreviewRow[];

describe('ImportPreview rows table on the shared DataTable', () => {
  const html = renderToStaticMarkup(h(ImportPreview, { run, rows: previewRows, editBase: 'content', listHref: '/admin/resources/content' }));

  it('keeps the accessible names: labelled focusable region and caption', () => {
    expect(html).toMatch(/role="region"[^>]*aria-label="Rows of the import \(scrollable\)"[^>]*tabindex="0"/);
    expect(html).toContain('<caption class="sr-only">Rows of the import with their validation status</caption>');
    expect((html.match(/<table/g) ?? []).length).toBe(1);
  });

  it('keeps all eight column headers', () => {
    for (const name of ['Row', 'Title', 'Type', 'Jurisdiction', 'Compliance', 'Category', 'Status', 'Issues']) {
      expect(html).toMatch(new RegExp(`<th[^>]*scope="col"[^>]*>${name}</th>`));
    }
  });

  it('keeps the row toggle button with its ARIA state and accessible text', () => {
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="row-detail-2"/);
    expect(html).toContain('How to read a payslip');
    expect(html).toContain('(no title)');
    expect(html).toContain(', show details');
  });

  it('keeps the status and issue wording and never clamps a status or a row number', () => {
    expect(html).toContain('Ready, with notes');
    expect(html).toContain('Error');
    expect(html).toContain('1 error');
    expect(html).toContain('1 note');
    expect(html).toMatch(/<td[^>]*data-cell-kind="num"[^>]*>2<\/td>/);
    expect(html).toMatch(/<td[^>]*data-cell-kind="status"/);
  });
});

describe('the sources carry no leftover hand-made table scaffolding', () => {
  for (const rel of ['components/resources/import/ImportHistoryTable.tsx', 'components/resources/import/ImportPreview.tsx']) {
    it(`${rel}: no raw <table, no fixed min-w, no own overflow-x-auto wrapper`, () => {
      const code = src(rel);
      expect(code).not.toMatch(/<table[\s>]/);
      expect(code).not.toMatch(/min-w-\[/);
      expect(code).not.toMatch(/overflow-x-auto/);
      expect(code).toMatch(/from '@\/components\/ui\/DataTable'/);
    });
  }

  it('the expandable detail row still spans all eight columns', () => {
    expect(src('components/resources/import/ImportPreview.tsx')).toMatch(/<td colSpan=\{8\}>/);
  });
});
