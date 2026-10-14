// F7 (PO review 2026-10-06): the Reference Data Quality page shows the last update per feed plus
// anything abnormal, folds repeated healthy lines, and prints day-first dates only.
// Admin Standard: section 8 (result states - a missing/failed run is never shown as healthy)
// and section 13 (safe failure - the collapse must never hide a failure).
import { describe, expect, it } from 'vitest';
import {
  RENDER_ROW_CAP,
  buildCorrectionView,
  buildImportBatchView,
  formatDateDMY,
  formatDateTimeDMY,
  localiseIsoDatesInText,
  type ImportBatchView,
  type RawRow,
} from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';

const TZ = 'UTC';

function run(i: number, o: Partial<RawRow> = {}): RawRow {
  const day = String(1 + (i % 28)).padStart(2, '0');
  return {
    id: `b${i}`,
    source_key: 'amfi',
    source_config_id: 'amfi_nav_history',
    batch_kind: 'nav_history',
    as_of_date: `2026-09-${day}`,
    status: 'succeeded',
    started_at: `2026-09-${day}T04:10:10.390779+00:00`,
    rows_read: 19, rows_accepted: 19, rows_rejected: 0, rows_inserted: 0, rows_unchanged: 0, rows_superseded: 0,
    error_code: null, error_detail: null,
    ...o,
  };
}

describe('day-first dates (PO standing rule)', () => {
  it('formats a calendar date as dd-mm-yyyy without timezone drift', () => {
    expect(formatDateDMY('2026-10-06', 'Australia/Sydney')).toBe('06-10-2026');
    expect(formatDateDMY('2019-07-15')).toBe('15-07-2019');
  });
  it('formats a raw ISO timestamp as dd-mm-yyyy hh:mm', () => {
    expect(formatDateTimeDMY('2026-09-30T04:10:10.390779+00:00', TZ)).toBe('30-09-2026 04:10');
    expect(formatDateTimeDMY('2026-09-30T04:10:10.390779+00:00', 'Asia/Kolkata')).toBe('30-09-2026 09:40');
  });
  it('shows nothing invented for a date-only value, and null for missing', () => {
    expect(formatDateTimeDMY('2026-10-06', TZ)).toBe('06-10-2026');
    expect(formatDateDMY(null)).toBeNull();
    expect(formatDateTimeDMY('')).toBeNull();
  });
  it('never hides an unparseable value', () => {
    expect(formatDateDMY('not a date')).toBe('not a date');
    expect(formatDateDMY('2026-02-31')).toBe('2026-02-31');
  });
  it('rewrites every ISO date and ISO timestamp inside server text, and leaves non-dates alone', () => {
    const t = localiseIsoDatesInText('stale since 2026-09-15; failed at 2026-09-30T04:10:10.390779+00:00; ref 12026-09-15x; bad 2026-13-45', TZ);
    expect(t).toContain('stale since 15-09-2026;');
    expect(t).toContain('failed at 30-09-2026 04:10;');
    expect(t).toContain('bad 2026-13-45');
    expect(t).not.toMatch(/\b2026-09-/);
  });
});

/** The safety assertion shared by the real test and the negative control. */
function assertSafetySignalsVisible(view: ImportBatchView, failedId: string): void {
  const visibleIds = new Set<string>([...view.attention.map((l) => l.id), ...view.feeds.map((f) => f.latestSuccess?.id ?? '')]);
  if (!visibleIds.has(failedId)) throw new Error(`failed run ${failedId} is hidden`);
}

describe('import batches: collapse hides only clean repeats of a successful feed', () => {
  const successes = Array.from({ length: 50 }, (_, i) => run(i));
  const failed = run(99, { id: 'FAILED', status: 'failed', error_code: 'http_503', error_detail: 'AMFI outage at 2026-09-12T01:00:00+00:00', rows_read: 0, rows_accepted: 0, started_at: '2026-09-12T01:00:00+00:00' });
  const view = buildImportBatchView([...successes.slice(0, 20), failed, ...successes.slice(20)], { asOfDate: '2026-09-28', timeZone: TZ });

  it('keeps the latest success per feed and folds the rest into a summary', () => {
    expect(view.feeds).toHaveLength(1);
    expect(view.feeds[0].latestSuccess).not.toBeNull();
    expect(view.feeds[0].hiddenSuccessCount).toBe(49);
    expect(view.feeds[0].summaryText).toBe('amfi_nav_history: 49 further successful runs hidden, latest 28-09-2026 (read 19, accepted 19)');
    expect(view.hiddenByCollapse).toBe(49);
  });

  it('a failed run among 50 successes stays visible, with its error text in day-first dates', () => {
    expect(view.needsAttention).toBe(true);
    const f = view.attention.find((l) => l.id === 'FAILED');
    expect(f).toBeDefined();
    expect(f?.reasons).toContain('not_succeeded');
    expect(f?.errorText).toBe('http_503: AMFI outage at 12-09-2026 01:00');
    expect(() => assertSafetySignalsVisible(view, 'FAILED')).not.toThrow();
  });

  it('NEGATIVE CONTROL: a naive "latest success per feed only" collapse hides the failure and the same assertion fails', () => {
    const naive: ImportBatchView = { ...view, attention: [] }; // what a careless collapse would produce
    expect(() => assertSafetySignalsVisible(naive, 'FAILED')).toThrow(/hidden/);
  });

  it.each(['failed', 'rolled_back', 'skipped_kill_switch', 'skipped_source_outage', 'running'])('status %s is never collapsed', (status) => {
    const v = buildImportBatchView([run(1), run(2), run(3, { id: 'X', status, finished_at: null })], { timeZone: TZ });
    expect(v.attention.map((l) => l.id)).toContain('X');
  });

  it('a succeeded run that rejected rows stays visible, as does one with an error code', () => {
    const v = buildImportBatchView([run(1), run(2, { id: 'REJ', rows_rejected: 3 }), run(3, { id: 'ERR', error_code: 'warn_partial' }), run(4)], { timeZone: TZ });
    const ids = [...v.attention.map((l) => l.id), v.feeds[0].latestSuccess?.id];
    expect(ids).toContain('REJ');
    expect(ids).toContain('ERR');
    expect(v.attention.find((l) => l.id === 'REJ')?.reasons).toContain('rejected_rows');
    expect(v.attention.find((l) => l.id === 'ERR')?.reasons).toContain('error_recorded');
  });

  it('an unknown (null) rejected count is not assumed to be zero', () => {
    const v = buildImportBatchView([run(1, { id: 'U', rows_rejected: null })], { timeZone: TZ });
    expect(v.needsAttention).toBe(true);
    expect(v.feeds[0].latestSuccess?.reasons).toContain('rejected_rows');
  });

  it('the latest success itself carries its reasons when it rejected rows (and is not repeated in the attention list)', () => {
    const v = buildImportBatchView([run(5, { id: 'LATEST', rows_rejected: 2 }), run(1)], { timeZone: TZ });
    expect(v.feeds[0].latestSuccess?.id).toBe('LATEST');
    expect(v.feeds[0].latestSuccess?.reasons).toContain('rejected_rows');
    expect(v.attention.map((l) => l.id)).not.toContain('LATEST');
    expect(v.needsAttention).toBe(true);
  });

  it('a feed with only failures is flagged as having no successful run', () => {
    const v = buildImportBatchView([run(1, { status: 'failed', error_code: 'x' })], { timeZone: TZ });
    expect(v.feeds[0].noSuccessfulRun).toBe(true);
    expect(v.feeds[0].latestSuccess).toBeNull();
    expect(v.needsAttention).toBe(true);
  });

  it('an expected feed with no run at all is flagged as missed, never silently omitted', () => {
    const v = buildImportBatchView([run(1)], { expectedFeeds: ['amfi_nav_daily'], timeZone: TZ });
    const missed = v.feeds.find((f) => f.feedKey === 'amfi_nav_daily');
    expect(missed?.noRunRecorded).toBe(true);
    expect(v.needsAttention).toBe(true);
    expect(v.feeds[0].feedKey).toBe('amfi_nav_daily'); // attention first
  });

  it('a feed whose latest success is older than its threshold is flagged stale', () => {
    const rows = [run(1, { as_of_date: '2026-09-20' })];
    const stale = buildImportBatchView(rows, { asOfDate: '2026-10-06', staleAfterDaysByFeed: { amfi_nav_history: 4 }, timeZone: TZ });
    expect(stale.feeds[0].stale).toEqual({ ageDays: 16, thresholdDays: 4 });
    expect(stale.needsAttention).toBe(true);
    const fresh = buildImportBatchView(rows, { asOfDate: '2026-09-22', staleAfterDaysByFeed: { amfi_nav_history: 4 }, timeZone: TZ });
    expect(fresh.feeds[0].stale).toBeNull();
    expect(fresh.needsAttention).toBe(false);
  });

  it('an all-healthy page says nothing needs attention', () => {
    const v = buildImportBatchView(successes, { asOfDate: '2026-09-28', timeZone: TZ });
    expect(v.needsAttention).toBe(false);
    expect(v.attention).toEqual([]);
  });

  it('separate feeds each keep their own latest success', () => {
    const v = buildImportBatchView([run(1), run(2, { source_config_id: 'amfi_scheme_master', batch_kind: 'scheme_master', id: 'sm' })], { timeZone: TZ });
    expect(v.feeds.map((f) => f.feedKey).sort()).toEqual(['amfi_nav_history', 'amfi_scheme_master']);
  });

  it('"Show all" is bounded to the cap and says so', () => {
    const many = Array.from({ length: RENDER_ROW_CAP + 40 }, (_, i) => run(i, { id: `m${i}`, started_at: `2026-08-01T00:${String(i % 60).padStart(2, '0')}:00+00:00` }));
    const v = buildImportBatchView(many, { timeZone: TZ });
    expect(v.all).toHaveLength(RENDER_ROW_CAP);
    expect(v.allTruncated).toBe(true);
    expect(v.totalRuns).toBe(RENDER_ROW_CAP + 40);
  });

  it('shows timestamps and as-at dates day-first, never ISO', () => {
    const v = buildImportBatchView([run(5)], { timeZone: TZ });
    expect(v.feeds[0].latestSuccess?.asOfDate).toBe('06-09-2026');
    expect(v.feeds[0].latestSuccess?.startedAt).toBe('06-09-2026 04:10');
  });
});

describe('source corrections: identical lines become one row with a count', () => {
  const same = (i: number): RawRow => ({
    id: `c${i}`, target_table: 'ii_prices_nav', target_row_id: 'row-2019-07-15', correction_kind: 'source_correction', actor_kind: 'system_import',
    reason: 'Source corrected NAV for 2019-07-15', created_at: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T02:00:00+00:00`,
  });
  const rows: RawRow[] = [...Array.from({ length: 40 }, (_, i) => same(i)), { id: 'manual', target_table: 'ii_prices_nav', target_row_id: 'r2', correction_kind: 'manual_admin_correction', actor_kind: 'admin', reason: 'Fixed typo', created_at: '2026-09-01T00:00:00+00:00' }];
  const view = buildCorrectionView(rows, TZ);

  it('groups identical (table, row, kind, actor, message) with count and first/last date', () => {
    expect(view.totalLines).toBe(41);
    expect(view.groups).toHaveLength(2);
    const g = view.groups.find((x) => x.correctionKind === 'source_correction');
    expect(g?.count).toBe(40);
    expect(g?.firstAt).toBe('10-09-2026 02:00');
    expect(g?.lastAt).toBe('24-09-2026 02:00');
    expect(g?.reason).toBe('Source corrected NAV for 15-07-2019');
  });

  it('a manual correction is never folded into the automatic ones and is listed first', () => {
    expect(view.groups[0].correctionKind).toBe('manual_admin_correction');
    expect(view.groups[0].notable).toBe(true);
    expect(view.groups[1].notable).toBe(false);
  });

  it('lines that differ in any field are NOT merged (negative control)', () => {
    const v = buildCorrectionView([same(1), { ...same(2), reason: 'a different message' }, { ...same(3), target_row_id: 'other' }, { ...same(4), actor_kind: 'admin' }], TZ);
    expect(v.groups).toHaveLength(4);
  });

  it('caps the expanded list at the render limit and flags truncation', () => {
    const many = Array.from({ length: RENDER_ROW_CAP + 5 }, (_, i) => ({ ...same(i), target_row_id: `r${i}` }));
    const v = buildCorrectionView(many, TZ);
    expect(v.allCapped).toHaveLength(RENDER_ROW_CAP);
    expect(v.allTruncated).toBe(true);
  });
});
