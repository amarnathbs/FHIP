// F7 render tests: the import-batch and source-correction panels, rendered to static HTML with
// react-dom/server (no DOM needed). Proves the PO-visible behaviour: repeated healthy lines are
// folded into a summary, the disclosure is keyboard-accessible (a real <button> with aria-expanded
// and aria-controls), expansion is bounded with a truncation note, and every safety signal
// (failure, rejection, stale, missed) is on screen in the default collapsed state.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportBatchesPanel } from '@/components/admin/referenceDataQuality/ImportBatchesPanel';
import { CorrectionsPanel } from '@/components/admin/referenceDataQuality/CorrectionsPanel';
import { RENDER_ROW_CAP, buildCorrectionView, buildImportBatchView, type RawRow } from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';

const TZ = 'UTC';
function run(i: number, o: Partial<RawRow> = {}): RawRow {
  const day = String(1 + (i % 28)).padStart(2, '0');
  return {
    id: `b${i}`, source_config_id: 'amfi_nav_history', batch_kind: 'nav_history', as_of_date: `2026-09-${day}`, status: 'succeeded',
    started_at: `2026-09-${day}T04:10:10.390779+00:00`, rows_read: 19, rows_accepted: 19, rows_rejected: 0, rows_inserted: 0, rows_unchanged: 0, rows_superseded: 0,
    error_code: null, error_detail: null, ...o,
  };
}
const render = (rows: RawRow[], opts: Parameters<typeof buildImportBatchView>[1] = {}, expanded = false) =>
  renderToStaticMarkup(h(ImportBatchesPanel, { view: buildImportBatchView(rows, { timeZone: TZ, ...opts }), defaultExpanded: expanded }));

describe('ImportBatchesPanel', () => {
  const successes = Array.from({ length: 15 }, (_, i) => run(i));

  it('collapsed: shows only the latest successful run plus the hidden-runs summary, not 15 lines', () => {
    const html = render(successes, { asOfDate: '2026-09-28' });
    expect(html.match(/amfi_nav_history as at/g)).toHaveLength(1);
    expect(html).toContain('amfi_nav_history: 14 further successful runs hidden, latest 15-09-2026 (read 19, accepted 19)');
    expect(html).toContain('Nothing failed, was rejected, went stale or was missed.');
  });

  it('the disclosure is a real button with aria-expanded=false and aria-controls pointing at a hidden region', () => {
    const html = render(successes);
    const btn = /<button[^>]*>/.exec(html)?.[0] ?? '';
    expect(btn).toContain('type="button"');
    expect(btn).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(btn)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toMatch(new RegExp(`<div id="${controls!.replace(/[:]/g, '\\:')}" hidden`));
    expect(html).toContain('Show all 15 runs loaded');
  });

  it('expanded: aria-expanded=true and every loaded run is listed', () => {
    const html = render(successes, {}, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Hide all runs');
    expect(html.match(/succeeded amfi_nav_history as at/g)!.length).toBeGreaterThanOrEqual(15);
  });

  it('expanded and over the cap: renders at most 100 rows and states the truncation', () => {
    const many = Array.from({ length: RENDER_ROW_CAP + 30 }, (_, i) => run(i, { id: `m${i}`, started_at: `2026-08-01T00:${String(i % 60).padStart(2, '0')}:00+00:00` }));
    const html = render(many, {}, true);
    expect(html).toContain(`Showing the newest ${RENDER_ROW_CAP} of ${RENDER_ROW_CAP + 30} runs loaded.`);
    const rendered = (html.match(/succeeded amfi_nav_history as at/g) ?? []).length;
    // the latest-success feed line plus at most RENDER_ROW_CAP list rows
    expect(rendered).toBeLessThanOrEqual(RENDER_ROW_CAP + 1);
  });

  it('a failed run among many successes is on screen in the COLLAPSED state, with its error and day-first dates', () => {
    const failed = run(99, { id: 'F', status: 'failed', error_code: 'http_503', error_detail: 'outage since 2026-09-12T01:00:00+00:00', started_at: '2026-09-12T01:00:00+00:00' });
    const html = render([...successes, failed]);
    expect(html).toContain('Runs that need attention (1)');
    expect(html).toContain('failed amfi_nav_history');
    expect(html).toContain('http_503: outage since 12-09-2026 01:00');
    expect(html).toContain('did not succeed');
    expect(html).toContain('Something below needs attention.');
    expect(html).not.toContain('Nothing failed');
  });

  it('NEGATIVE CONTROL: with the failure removed from the data, the failure text is absent (so the test above really observes it)', () => {
    const html = render(successes);
    expect(html).not.toContain('Runs that need attention');
    expect(html).not.toContain('http_503');
  });

  it('a rejected-rows run, a stale feed and a missed feed are visible while collapsed', () => {
    const html = render([run(1, { id: 'R', rows_rejected: 4, as_of_date: '2026-09-01' })], {
      asOfDate: '2026-10-06', staleAfterDaysByFeed: { amfi_nav_history: 4 }, expectedFeeds: ['amfi_nav_daily'],
    });
    expect(html).toContain('rejected 4');
    expect(html).toContain('rows were rejected');
    expect(html).toContain('Stale: last successful run is 35 days old (limit 4).');
    expect(html).toContain('Missed.');
    expect(html).toContain('amfi_nav_daily');
  });

  it('no ISO date or raw ISO timestamp appears anywhere in the rendered panel', () => {
    const failed = run(99, { id: 'F', status: 'failed', error_code: 'x', error_detail: 'at 2026-09-12T01:00:00+00:00' });
    const html = render([...successes, failed], { asOfDate: '2026-09-28' }, true);
    expect(html).not.toMatch(/\b\d{4}-\d{2}-\d{2}/);
  });

  it('nothing recorded is stated as such, not as a healthy empty list', () => {
    expect(render([])).toContain('No import runs are recorded yet. This is not the same as a healthy feed.');
  });
});

describe('CorrectionsPanel', () => {
  const same = (i: number): RawRow => ({
    id: `c${i}`, target_table: 'ii_prices_nav', target_row_id: 'r1', correction_kind: 'source_correction', actor_kind: 'system_import',
    reason: 'NAV corrected for 2019-07-15', created_at: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T02:00:00+00:00`,
  });

  it('shows one grouped row with count and first/last date instead of 30 repeats', () => {
    const view = buildCorrectionView(Array.from({ length: 30 }, (_, i) => same(i)), TZ);
    const html = renderToStaticMarkup(h(CorrectionsPanel, { view }));
    expect(html.match(/ii_prices_nav/g)).toHaveLength(1);
    expect(html).toContain('30 times, first 10-09-2026 02:00, last 24-09-2026 02:00');
    expect(html).toContain('NAV corrected for 15-07-2019');
    expect(html).not.toMatch(/\b\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain('<button'); // one group: nothing to expand
  });

  it('with more than ten distinct corrections: a collapsed button, then a bounded expansion with a truncation note', () => {
    const rows = Array.from({ length: RENDER_ROW_CAP + 5 }, (_, i) => ({ ...same(i), target_row_id: `r${i}` }));
    const view = buildCorrectionView(rows, TZ);
    const collapsed = renderToStaticMarkup(h(CorrectionsPanel, { view }));
    expect(collapsed).toContain('aria-expanded="false"');
    expect((collapsed.match(/<li/g) ?? []).length).toBe(10);
    const expanded = renderToStaticMarkup(h(CorrectionsPanel, { view, defaultExpanded: true }));
    expect(expanded).toContain('aria-expanded="true"');
    expect((expanded.match(/<li/g) ?? []).length).toBe(RENDER_ROW_CAP);
    expect(expanded).toContain(`Showing the first ${RENDER_ROW_CAP} of ${RENDER_ROW_CAP + 5} distinct corrections.`);
  });

  it('a manual correction is flagged and is on screen in the collapsed state', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => ({ ...same(i), target_row_id: `r${i}` })), { id: 'm', target_table: 'ii_prices_nav', target_row_id: 'x', correction_kind: 'manual_admin_correction', actor_kind: 'admin', reason: 'Hand fix', created_at: '2026-09-01T00:00:00+00:00' }];
    const html = renderToStaticMarkup(h(CorrectionsPanel, { view: buildCorrectionView(rows, TZ) }));
    expect(html).toContain('manual_admin_correction');
    expect(html).toContain('Not an automatic import correction.');
  });
});
