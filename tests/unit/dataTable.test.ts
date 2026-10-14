// Shared table mechanism (components/ui/DataTable.tsx, ClampText.tsx, lib/ui/dataTable.ts). EVIDENCE LABEL: UNIT-TESTED by rendering to
// static HTML (there is no DOM environment in this repository) plus pure-function tests. How it LAYS OUT and how the Show more control
// behaves under real keyboard input is proven in a real browser by scripts/a11y/dataTableCheck.mjs (not by this file).
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Btn } from '@/components/admin/benchmarkData/ui';
import { ClampText, ClampToggle } from '@/components/ui/ClampText';
import { DataTable, DataTd, DataTh, DateRange, DateTimeText, NoWrap } from '@/components/ui/DataTable';
import {
  CLAMP_DEFAULT_LINES,
  LONG_TABLE_ROWS,
  cellClass,
  clampToggleLabel,
  headerClass,
  isClamped,
  neverWraps,
  shouldOfferJumpLink,
  type CellKind,
} from '@/lib/ui/dataTable';

const table = (props: Record<string, unknown>, ...children: unknown[]) => renderToStaticMarkup(h(DataTable, { label: 'Things', ...props } as never, ...(children as never[])));

describe('DataTable: the labelled, focusable region around every table', () => {
  const html = table({ className: 'min-w-full', 'data-testid': 'things' }, h('thead', null, h('tr', null, h(DataTh, null, 'Name'))), h('tbody', null, h('tr', null, h(DataTd, null, 'x'))));

  it('wraps a real table in a named, keyboard-focusable region (the narrow-screen container)', () => {
    expect(html).toMatch(/<div[^>]*role="region"[^>]*aria-label="Things"[^>]*tabindex="0"[^>]*class="fhip-table-wrap"/);
    expect(html).toContain('<table');
  });

  it('passes the table its own attributes through: class, test id, aria label', () => {
    const labelled = table({ 'aria-label': 'Own name', 'data-testid': 'india-mf-table', className: 'india-mf-table w-full' });
    expect(labelled).toContain('aria-label="Own name"');
    expect(labelled).toContain('data-testid="india-mf-table"');
    expect(labelled).toMatch(/<table[^>]*class="fhip-table india-mf-table w-full"/);
  });

  it('keeps wrapper attributes (a test id on the region) and extra wrapper classes', () => {
    const w = table({ wrapperClassName: 'rounded-card border', wrapperProps: { 'data-testid': 'india-mf-table-wrap' } });
    expect(w).toContain('data-testid="india-mf-table-wrap"');
    expect(w).toContain('class="fhip-table-wrap rounded-card border"');
  });

  it('marks the first column sticky (below 768 px, by CSS) unless asked not to', () => {
    expect(html).toContain('data-sticky-first="true"');
    expect(table({ stickyFirstColumn: false })).not.toContain('data-sticky-first');
  });

  it('adds no vertical scroll area: no max-height or overflow class on the region unless the caller asks for one', () => {
    expect(html).not.toMatch(/max-h-|overflow-y/);
  });

  it('shows a visible jump link past a long table only when a target is given and the table is long', () => {
    const jump = { href: '#upload', label: 'Skip to the upload form' };
    expect(table({ jumpTo: jump, rowCount: LONG_TABLE_ROWS })).toContain('<a href="#upload" class="fhip-table-jump-link">Skip to the upload form</a>');
    expect(table({ jumpTo: jump, rowCount: LONG_TABLE_ROWS - 1 })).not.toContain('fhip-table-jump');
    expect(table({ rowCount: 99 })).not.toContain('fhip-table-jump');
    expect(shouldOfferJumpLink(undefined, true)).toBe(false);
  });
});

describe('cells: numbers, dates, statuses and actions are single-line and never clamped', () => {
  const kinds: CellKind[] = ['num', 'date', 'status', 'action'];

  it.each(kinds)('%s cell does not wrap and does not contain a clamp', (kind) => {
    const td = renderToStaticMarkup(h('table', null, h('tbody', null, h('tr', null, h(DataTd, { kind }, 'x')))));
    expect(td).toContain('fhip-cell-nowrap');
    expect(td).not.toContain('fhip-clamp');
    expect(neverWraps(kind)).toBe(true);
    expect(headerClass(kind)).toContain('fhip-cell-nowrap');
  });

  it('a number cell is right-aligned with tabular figures (the G2 rule travels with it)', () => {
    expect(cellClass('num')).toContain('text-right');
    expect(cellClass('num')).toContain('tabular-nums');
  });

  it('an action cell is marked as the sticky action column', () => {
    expect(cellClass('action')).toContain('fhip-cell-action');
    expect(headerClass('action')).toContain('fhip-cell-action');
  });

  it('a plain text cell is neither clamped nor forced single-line, and keeps the caller classes', () => {
    expect(neverWraps('text')).toBe(false);
    expect(cellClass('text', 'px-2 py-1')).toBe('px-2 py-1');
  });

  it('a header cell is column-scoped by default', () => {
    expect(renderToStaticMarkup(h('table', null, h('thead', null, h('tr', null, h(DataTh, null, 'Name')))))).toContain('<th scope="col"');
  });
});

describe('clamp: two lines, with the whole text still in the document', () => {
  const long = 'Founding members cohort, October 2026 launch event, handed out by the partnerships team at the Sydney meetup';
  const cell = renderToStaticMarkup(h('table', null, h('tbody', null, h('tr', null, h(DataTd, { kind: 'clamp' }, long)))));

  it('defaults to two lines (the Product Owner rule)', () => {
    expect(CLAMP_DEFAULT_LINES).toBe(2);
    expect(cell).toContain('--fhip-clamp-lines:2');
    expect(cell).toContain('class="fhip-clamp"');
  });

  it('keeps the FULL text in the markup, so screen readers and find-in-page still reach it', () => {
    expect(cell).toContain(long);
  });

  it('gives a squeezed column a floor (a narrow sliver would be many lines tall) and an optional ceiling', () => {
    expect(cell).toContain('min-width:10ch');
    const wide = renderToStaticMarkup(h(ClampText, { minCh: 14, maxCh: 40, lines: 3, children: 'x' }));
    expect(wide).toContain('min-width:14ch');
    expect(wide).toContain('max-width:40ch');
    expect(wide).toContain('--fhip-clamp-lines:3');
  });

  it('shows no Show more control until the text is measured as really cut (short cells stay clean)', () => {
    expect(cell).not.toContain('fhip-clamp-toggle');
  });

  it('the overflow test: cut only when the content is taller than the box, one pixel of rounding tolerated', () => {
    expect(isClamped(40, 40)).toBe(false);
    expect(isClamped(41, 40)).toBe(false);
    expect(isClamped(60, 40)).toBe(true);
  });
});

describe('the Show more control is a real, keyboard-operable button', () => {
  const collapsed = renderToStaticMarkup(h(ClampToggle, { open: false, controls: 'c1', onToggle: () => undefined }));
  const expanded = renderToStaticMarkup(h(ClampToggle, { open: true, controls: 'c1', onToggle: () => undefined }));

  it('is a native button (Tab focuses it; Enter, Space, click and tap activate it with no custom key code)', () => {
    expect(collapsed).toMatch(/^<button type="button"/);
  });

  it('exposes its state and what it controls', () => {
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-controls="c1"');
    expect(collapsed).toContain('>Show more<');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('>Show less<');
    expect(clampToggleLabel(false)).toBe('Show more');
    expect(clampToggleLabel(true)).toBe('Show less');
  });

  it('relies on a real button, not a title attribute alone (a title is invisible to keyboard and touch users)', () => {
    expect(collapsed).not.toContain('title=');
  });
});

describe('dates never break at their hyphens', () => {
  it('NoWrap is unbreakable', () => {
    expect(renderToStaticMarkup(h(NoWrap, null, '08-10-2026'))).toBe('<span class="whitespace-nowrap">08-10-2026</span>');
  });

  it('a range keeps each end whole and can only break between the two dates; the text is unchanged', () => {
    const html = renderToStaticMarkup(h(DateRange, { from: '06-10-2026', to: '05-10-2036' }));
    expect(html).toBe('<span class="whitespace-nowrap">06-10-2026 to</span> <span class="whitespace-nowrap">05-10-2036</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('06-10-2026 to 05-10-2036');
  });

  it('a date and time can only break between the date and the time; the day-first wording is untouched', () => {
    const html = renderToStaticMarkup(h(DateTimeText, { value: '08-10-2026 02:37 UTC' }));
    expect(html).toBe('<span class="whitespace-nowrap">08-10-2026</span> <span class="whitespace-nowrap">02:37 UTC</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('08-10-2026 02:37 UTC');
    expect(renderToStaticMarkup(h(DateTimeText, { value: '08-10-2026' }))).toBe('<span class="whitespace-nowrap">08-10-2026</span>');
  });
});

describe('touch targets: compact action buttons and the Show more control', () => {
  it('a compact action button is small on a mouse screen and 44 px on a touch screen; a normal button stays 44 px', () => {
    const compact = renderToStaticMarkup(h(Btn, { compact: true, kind: 'secondary', ariaLabel: 'Edit revision of record a1b2c3', children: 'Edit revision' }));
    expect(compact).toContain('min-h-8');
    expect(compact).toContain('[@media(pointer:coarse)]:min-h-11');
    expect(compact).toContain('aria-label="Edit revision of record a1b2c3"');
    expect(renderToStaticMarkup(h(Btn, { kind: 'secondary', children: 'Open' }))).toContain('min-h-11');
  });

  it('the Show more control grows to 44 px on a touch screen (CSS), 24 px otherwise (WCAG 2.5.8)', () => {
    const css = readFileSync(path.resolve(__dirname, '..', '..', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.fhip-clamp-toggle \{[^}]*min-height: 1\.5rem/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.fhip-clamp-toggle \{[^}]*min-height: 2\.75rem/);
  });
});
