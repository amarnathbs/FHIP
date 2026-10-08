// BENCH-1 Phase 2 -- the RAW downloads the Product Owner gets from the index sites
// (niftyindices.com NIFTY 50 historical data; BSE Sensex historical data, both downloaded
// 08-10-2026) are accepted as they are, with no hand-cleaning:
//   * tests/fixtures/market-index/raw_niftyindices_nifty50_download_2026-10-08.csv
//   * tests/fixtures/market-index/raw_bse_sensex_download_2026-10-08.csv
// Both fixtures are the FIRST rows of the real files, cut byte-for-byte (header bytes, quoting,
// CRLF, date style), not retyped.
//
// Safety rules proved here (each negative control names the rule it guards):
//   - a header is recognised only on an EXACT match (the required set, or the required set plus
//     ONLY columns the layout lists as known-and-ignored); a near miss is refused with the nearest
//     registered layout named, never accepted;
//   - ignored columns are listed, never mapped;
//   - ambiguity between two layouts is refused;
//   - price vs total return stays a hard check;
//   - the layout and an explicit column map cannot be combined.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { PreviewPanel } from '@/components/admin/benchmarkData/PublishParts';
import {
  PROVIDER_LAYOUTS,
  matchRegisteredLayouts,
  nearestLayouts,
  parseMarketDate,
  readUploadToTable,
  resolveLayout,
  validateUpload,
  type CatalogueEntryLite,
  type UploadParams,
  type ValidationResult,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { parseIndexCsv } from '@/lib/services/investment-intelligence/marketIndex/indexCsvParser';
import { DATE_FORMAT_OPTIONS, describeLayoutDisclosure, providerLayoutOptionLabel, recognisedLayoutNotice } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'market-index');
const NIFTY_BYTES = new Uint8Array(fs.readFileSync(path.join(FIX, 'raw_niftyindices_nifty50_download_2026-10-08.csv')));
const SENSEX_BYTES = new Uint8Array(fs.readFileSync(path.join(FIX, 'raw_bse_sensex_download_2026-10-08.csv')));
const NIFTY_TEXT = Buffer.from(NIFTY_BYTES).toString('utf8');
const SENSEX_TEXT = Buffer.from(SENSEX_BYTES).toString('utf8');
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

const TODAY = '2026-10-08';
const NIFTY_KEY = 'IN_NIFTY_50_PRI';
const SENSEX_KEY = 'IN_SENSEX_PRI';
const priceEntry = (k: string): CatalogueEntryLite => ({ benchmarkKey: k, returnVariant: 'price', currencyCode: 'INR', isActive: true });
const CATALOGUE = new Map([[NIFTY_KEY, priceEntry(NIFTY_KEY)], [SENSEX_KEY, priceEntry(SENSEX_KEY)]]);

const params = (o: Partial<UploadParams> = {}): UploadParams => ({
  shape: 'single',
  mode: 'new_history',
  benchmarkKey: NIFTY_KEY,
  returnVariant: 'price',
  currencyCode: 'INR',
  historyClass: 'live',
  dateFormat: 'DD MMM YYYY',
  numberLocale: 'plain',
  ...o,
});
const niftyParams = (o: Partial<UploadParams> = {}) => params(o);
const sensexParams = (o: Partial<UploadParams> = {}) => params({ benchmarkKey: SENSEX_KEY, dateFormat: 'DD-MMM-YYYY', ...o });

function run(fileName: string, bytes: Uint8Array, p: UploadParams): ValidationResult {
  const read = readUploadToTable({ fileName, bytes, params: p });
  if (!read.ok) throw new Error(`read failed: ${read.problems.map((x) => x.message).join('; ')}`);
  return validateUpload(read.table, p, { todayIso: TODAY, catalogue: CATALOGUE, existing: new Map() });
}
const errorCodes = (r: ValidationResult) => r.issues.filter((i) => i.severity === 'error').map((i) => i.code);

const NIFTY_EXPECTED = [
  ['2026-10-01', 22421.95],
  ['2026-10-05', 22555.75],
  ['2026-10-06', 22776.1],
  ['2026-10-07', 22603.05],
];
const SENSEX_EXPECTED = [
  ['2026-09-28', 72771.72],
  ['2026-09-29', 72529.07],
  ['2026-09-30', 72480.29],
  ['2026-10-01', 71909.7],
  ['2026-10-07', 72638.7],
];

describe('the fixtures are the real files, byte for byte', () => {
  it('NIFTY header is fully quoted, rows are newest first, CRLF', () => {
    expect(NIFTY_TEXT.startsWith('"Index Name","Date","Open","High","Low","Close"\r\n"NIFTY 50","07 Oct 2026","22690.45"')).toBe(true);
    expect(NIFTY_TEXT).toContain('"22776.10"');
  });
  it('SENSEX header is unquoted with the seven statistics columns; dates use full month names and a non-padded day', () => {
    expect(SENSEX_TEXT.startsWith('Date,Open,High,Low,Close,Points Change,Change(%),Volume(Cr.),Turnover (Rs.Cr.),P/E,P/B,Div Yield\r\n28-September-2026,')).toBe(true);
    expect(SENSEX_TEXT).toContain('\r\n1-October-2026,');
    expect(SENSEX_TEXT).not.toContain('Index Name');
  });
});

describe('NIFTY 50 raw download (niftyindices.com)', () => {
  it('with the provider layout chosen: loads Date and Close, lists Open/High/Low as ignored', () => {
    const r = run('nifty.csv', NIFTY_BYTES, niftyParams({ shape: 'provider_export', providerLayoutId: 'nse_price_export' }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => [s.date, s.value])).toEqual(NIFTY_EXPECTED);
    expect(r.staged.every((s) => s.benchmarkKey === NIFTY_KEY)).toBe(true);
    expect(r.disclosure.layoutId).toBe('nse_price_export');
    expect(r.disclosure.layoutMatchedBy).toBe('chosen');
    expect(r.disclosure.layoutUnverified).toBe(false);
    expect(r.disclosure.ignoredColumns).toEqual(['Open', 'High', 'Low']);
    expect(r.disclosure.columnMapping).toEqual({ date: 'Date', value: 'Close', index_name: 'Index Name' });
    expect(r.perBenchmark[0].earliestDate).toBe('2026-10-01');
    expect(r.perBenchmark[0].latestDate).toBe('2026-10-07');
    expect(r.requiredAcknowledgements).toEqual([]);
  });

  it('the PO case: the single date,value shape is SELECTED but the header is the NIFTY layout -> recognised by its exact header', () => {
    const r = run('nifty.csv', NIFTY_BYTES, niftyParams({ shape: 'single' }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => [s.date, s.value])).toEqual(NIFTY_EXPECTED);
    expect(r.disclosure.layoutId).toBe('nse_price_export');
    expect(r.disclosure.layoutMatchedBy).toBe('header');
    expect(r.disclosure.ignoredColumns).toEqual(['Open', 'High', 'Low']);
  });

  it('provider export with no layout chosen is auto-recognised too, and the last row may lack a line break', () => {
    const noFinalEol = NIFTY_TEXT.replace(/\r\n$/, '');
    const r = run('nifty.csv', utf8(noFinalEol), niftyParams({ shape: 'provider_export' }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged).toHaveLength(4);
    expect(r.disclosure.layoutMatchedBy).toBe('header');
  });

  it('the multi shape cannot take a one-index layout (the benchmark would be unknown): refused, naming the layout', () => {
    const read = readUploadToTable({ fileName: 'n.csv', bytes: NIFTY_BYTES, params: niftyParams({ shape: 'multi', benchmarkKey: undefined }) });
    if (!read.ok) throw new Error('read');
    const res = resolveLayout(read.table.header, niftyParams({ shape: 'multi', benchmarkKey: undefined }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('RECOGNISED_LAYOUT_NEEDS_BENCHMARK');
      expect(res.message).toContain(PROVIDER_LAYOUTS.nse_price_export.label);
    }
  });
});

describe('BSE Sensex raw download', () => {
  it('with the provider layout chosen: full-month-name and non-padded dates parse; seven statistics columns are ignored', () => {
    const r = run('sensex.csv', SENSEX_BYTES, sensexParams({ shape: 'provider_export', providerLayoutId: 'bse_sensex_download' }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => [s.date, s.value])).toEqual(SENSEX_EXPECTED);
    expect(r.staged.every((s) => s.benchmarkKey === SENSEX_KEY)).toBe(true);
    expect(r.disclosure.layoutId).toBe('bse_sensex_download');
    expect(r.disclosure.layoutUnverified).toBe(false);
    expect(r.disclosure.columnMapping).toEqual({ date: 'Date', value: 'Close' });
    expect(r.disclosure.ignoredColumns).toEqual(['Open', 'High', 'Low', 'Points Change', 'Change(%)', 'Volume(Cr.)', 'Turnover (Rs.Cr.)', 'P/E', 'P/B', 'Div Yield']);
    // The ignored statistics are never loaded as data.
    expect(r.staged.some((s) => s.value < 1000)).toBe(false);
    expect(r.requiredAcknowledgements).toEqual([]);
  });

  it('the single shape SELECTED with the real header, no name column: recognised by its exact header, the form\'s declared index decides', () => {
    const r = run('sensex.csv', SENSEX_BYTES, sensexParams({ shape: 'single' }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => [s.date, s.value])).toEqual(SENSEX_EXPECTED);
    expect(r.disclosure.layoutMatchedBy).toBe('header');
    expect(r.disclosure.layoutId).toBe('bse_sensex_download');
    expect(r.perBenchmark[0].benchmarkKey).toBe(SENSEX_KEY);
  });

  it('a trailing blank line and a missing final line break are both fine', () => {
    expect(run('s.csv', utf8(SENSEX_TEXT + '\r\n'), sensexParams()).hardErrorCount).toBe(0);
    const r = run('s.csv', utf8(SENSEX_TEXT.replace(/\r\n$/, '')), sensexParams());
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged).toHaveLength(5);
  });

  it('1-October-2026 (non-padded day, full month name) is 2026-10-01; the same date format accepts the 3-letter name', () => {
    expect(parseMarketDate('1-October-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, iso: '2026-10-01' });
    expect(parseMarketDate('28-September-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, iso: '2026-09-28' });
    expect(parseMarketDate('1-Oct-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, iso: '2026-10-01' });
  });
});

describe('the honesty note is true only where it is true', () => {
  it('exactly the two layouts checked against the 08-10-2026 downloads say so; every other layout stays UNVERIFIED', () => {
    const verified = Object.values(PROVIDER_LAYOUTS).filter((l) => !l.unverified).map((l) => l.id).sort();
    expect(verified).toEqual(['bse_sensex_download', 'nse_price_export']);
    for (const l of Object.values(PROVIDER_LAYOUTS)) {
      if (l.unverified) expect(l.note).toContain('UNVERIFIED');
      else {
        expect(l.note).toContain('matches a real download of 08-10-2026');
        expect(l.note).not.toContain('UNVERIFIED');
      }
    }
  });

  it('a header carrying only SOME of the verified Sensex columns is recognised but reported as unverified', () => {
    const header = ['Date', 'Open', 'High', 'Low', 'Close', 'Points Change', 'P/E'];
    const res = resolveLayout(header, sensexParams({ shape: 'single' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.layout.id).toBe('bse_sensex_download');
      expect(res.layout.unverified).toBe(true);
      expect(res.notes.join(' ')).toContain('UNVERIFIED');
    }
  });
});

describe('older upload path: the same raw files', () => {
  it('indexCsvParser reads both raw downloads', () => {
    const n = parseIndexCsv(NIFTY_TEXT, 'IN_NIFTY_50_PRI', TODAY);
    expect(n.fileRejected).toBe(false);
    expect(n.accepted.map((x) => [x.date, x.close])).toEqual(NIFTY_EXPECTED);
    const s = parseIndexCsv(SENSEX_TEXT, 'IN_SENSEX_PRI', TODAY);
    expect(s.fileRejected).toBe(false);
    expect(s.rejected).toEqual([]);
    expect(s.accepted.map((x) => [x.date, x.close])).toEqual(SENSEX_EXPECTED);
  });
});

describe('negative controls (each names the rule it guards)', () => {
  it('RULE closed list: an UNKNOWN extra column on the Sensex header is not ignored -> refused, nearest layout named', () => {
    const header = ['Date', 'Open', 'High', 'Low', 'Close', 'Points Change', 'Brand New Column'];
    expect(matchRegisteredLayouts(header, { allowArbitraryExtras: false })).toEqual([]);
    const single = resolveLayout(header, sensexParams({ shape: 'single' }));
    expect(single.ok).toBe(false);
    if (!single.ok) {
      expect(single.code).toBe('UNEXPECTED_COLUMN');
      expect(single.message).toContain(PROVIDER_LAYOUTS.bse_sensex_download.label);
      expect(single.message).toContain('Brand New Column');
      expect(single.message).toContain('never accepted');
    }
    const auto = resolveLayout(header, sensexParams({ shape: 'provider_export' }));
    expect(auto.ok).toBe(false);
    if (!auto.ok) {
      expect(auto.code).toBe('LAYOUT_UNRECOGNISED');
      expect(auto.message).toContain('nearest registered layout');
    }
    const chosen = resolveLayout(header, sensexParams({ shape: 'provider_export', providerLayoutId: 'bse_sensex_download' }));
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) expect(chosen.code).toBe('LAYOUT_HEADER_MISMATCH');
  });

  it('RULE exact header: a near-miss NIFTY header (Close renamed Closing) is NOT auto-recognised and is refused with the nearest layout named', () => {
    const bad = NIFTY_TEXT.replace('"Close"', '"Closing"');
    for (const shape of ['single', 'provider_export'] as const) {
      const read = readUploadToTable({ fileName: 'n.csv', bytes: utf8(bad), params: niftyParams({ shape }) });
      if (!read.ok) throw new Error('read');
      const res = resolveLayout(read.table.header, niftyParams({ shape }));
      expect(res.ok, shape).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain(PROVIDER_LAYOUTS.nse_price_export.label);
        expect(res.message).toContain('missing Close');
      }
    }
    const r = (() => {
      const p = niftyParams({ shape: 'single' });
      const read = readUploadToTable({ fileName: 'n.csv', bytes: utf8(bad), params: p });
      if (!read.ok) throw new Error('read');
      return validateUpload(read.table, p, { todayIso: TODAY, catalogue: CATALOGUE, existing: new Map() });
    })();
    expect(r.staged).toEqual([]);
    expect(r.hardErrorCount).toBeGreaterThan(0);
  });

  it('RULE nothing near: a header that resembles no layout gets no suggestion and is refused', () => {
    expect(nearestLayouts(['Foo', 'Bar'])).toEqual([]);
    const res = resolveLayout(['Foo', 'Bar'], niftyParams({ shape: 'single' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('Remove it');
  });

  it('RULE layout XOR column map: a chosen layout together with an explicit column map is refused', () => {
    const res = resolveLayout(
      ['Index Name', 'Date', 'Open', 'High', 'Low', 'Close'],
      niftyParams({ shape: 'provider_export', providerLayoutId: 'nse_price_export', columnMap: { date: 'Date', value: 'Close' } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('LAYOUT_AND_COLUMN_MAP_BOTH');
  });

  it('RULE price vs total return: the recognised price layouts refuse a file declared as total return, whichever shape is selected', () => {
    for (const shape of ['single', 'provider_export'] as const) {
      const header = ['Date', 'Open', 'High', 'Low', 'Close', 'Points Change', 'Change(%)', 'Volume(Cr.)', 'Turnover (Rs.Cr.)', 'P/E', 'P/B', 'Div Yield'];
      const res = resolveLayout(header, sensexParams({ shape, returnVariant: 'total_return' }));
      expect(res.ok, shape).toBe(false);
      if (!res.ok) expect(res.code).toBe('VARIANT_LAYOUT_CONFLICT');
    }
    const nifty = run('n.csv', NIFTY_BYTES, niftyParams({ shape: 'single', returnVariant: 'total_return' }));
    expect(errorCodes(nifty)).toContain('VARIANT_LAYOUT_CONFLICT');
    expect(nifty.staged).toEqual([]);
  });

  it('RULE date format is the operator\'s: the wrong date format is refused row by row, never guessed', () => {
    const r = run('s.csv', SENSEX_BYTES, sensexParams({ shape: 'single', dateFormat: 'DD MMM YYYY' }));
    expect(r.staged).toEqual([]);
    expect(errorCodes(r)).toContain('DATE_FORMAT_INVALID');
  });

  it('RULE ambiguity: a header that two registered layouts match is refused, naming both', () => {
    const clone = { ...PROVIDER_LAYOUTS.bse_sensex_download, id: 'bse_sensex_download_twin', label: 'Twin of the Sensex download' };
    (PROVIDER_LAYOUTS as Record<string, typeof clone>).bse_sensex_download_twin = clone;
    try {
      const header = ['Date', 'Open', 'High', 'Low', 'Close', 'Points Change'];
      const res = resolveLayout(header, sensexParams({ shape: 'single' }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('LAYOUT_AMBIGUOUS');
        expect(res.message).toContain(PROVIDER_LAYOUTS.bse_sensex_download.label);
        expect(res.message).toContain('Twin of the Sensex download');
      }
    } finally {
      delete (PROVIDER_LAYOUTS as Record<string, unknown>).bse_sensex_download_twin;
    }
    expect(resolveLayout(['Date', 'Open', 'High', 'Low', 'Close', 'Points Change'], sensexParams({ shape: 'single' })).ok).toBe(true);
  });

  it('RULE plain shapes are untouched: date,value stays the fixed single layout and is not "recognised" as a provider layout', () => {
    const res = resolveLayout(['date', 'value'], niftyParams({ shape: 'single' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.layout.id).toBe('single_date_value');
      expect(res.layout.matchedBy).toBe('fixed');
      expect(res.ignoredColumns).toEqual([]);
    }
    const extra = resolveLayout(['date', 'value', 'volume'], niftyParams({ shape: 'single' }));
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.code).toBe('UNEXPECTED_COLUMN');
  });

  it('RULE the all-index daily file (arbitrary extras) is never auto-recognised under a plain shape', () => {
    const header = ['Index Name', 'Index Date', 'Closing Index Value', 'Points Change'];
    const res = resolveLayout(header, niftyParams({ shape: 'single' }));
    expect(res.ok).toBe(false);
    // ... but it is still recognised when the operator selects the provider export (unchanged behaviour).
    const pe = resolveLayout(header, niftyParams({ shape: 'provider_export' }));
    expect(pe.ok).toBe(true);
  });
});

// ------------------------------------------------------------------ the form and the preview ---
const headerOf = (text: string) => text.split(/\r?\n/)[0].split(',').map((h) => h.replace(/^"|"$/g, ''));

describe('upload form: the operator is told what will happen before pressing Check', () => {
  it('the real NIFTY header under the Single shape is announced as a recognised layout with Open/High/Low as ignored', () => {
    const n = recognisedLayoutNotice(headerOf(NIFTY_TEXT), 'single');
    expect(n).toMatchObject({ layoutId: 'nse_price_export', unverified: false, ignoredColumns: ['Open', 'High', 'Low'], problem: null });
  });
  it('the real SENSEX header lists the statistics columns as ignored', () => {
    const n = recognisedLayoutNotice(headerOf(SENSEX_TEXT), 'single');
    expect(n?.layoutId).toBe('bse_sensex_download');
    expect(n?.ignoredColumns).toEqual(['Open', 'High', 'Low', 'Points Change', 'Change(%)', 'Volume(Cr.)', 'Turnover (Rs.Cr.)', 'P/E', 'P/B', 'Div Yield']);
  });
  it('under Multi a one-index layout is flagged as a problem with what to choose instead', () => {
    expect(recognisedLayoutNotice(headerOf(NIFTY_TEXT), 'multi')?.problem).toContain('Single benchmark');
  });
  it('NEGATIVE: plain headers, near misses and unknown headers produce no recognition', () => {
    expect(recognisedLayoutNotice(['date', 'value'], 'single')).toBeNull();
    expect(recognisedLayoutNotice(['benchmark_key', 'date', 'value'], 'multi')).toBeNull();
    expect(recognisedLayoutNotice(['Index Name', 'Date', 'Open', 'High', 'Low', 'Closing'], 'single')).toBeNull();
    expect(recognisedLayoutNotice(['Date', 'Open', 'High', 'Low', 'Close', 'Brand New Column'], 'single')).toBeNull();
    expect(recognisedLayoutNotice(null, 'single')).toBeNull();
    expect(recognisedLayoutNotice(headerOf(NIFTY_TEXT), '')).toBeNull();
  });
  it('the layout choice and the date format say what they are', () => {
    expect(providerLayoutOptionLabel({ label: 'X', unverified: false })).toContain('matches a real download of 08-10-2026');
    expect(providerLayoutOptionLabel({ label: 'X', unverified: true })).toBe('X');
    expect(DATE_FORMAT_OPTIONS.find((o) => o.value === 'DD-MMM-YYYY')?.example).toContain('1-January-2024');
  });
});

describe('preview panel renders the layout lines (server-side render of the real component)', () => {
  it('shows the recognised layout, its verification status and the ignored columns, and still shows the entitlement block when blocked', () => {
    const r = run('sensex.csv', SENSEX_BYTES, sensexParams({ shape: 'single' }));
    const preview = {
      jobId: 'j', fileSha256: 'a'.repeat(64), fileBytes: 1, fileKind: 'csv', validatorVersion: 'v', layoutId: r.disclosure.layoutId, columnMapping: r.disclosure.columnMapping,
      disclosure: r.disclosure,
      params: { shape: 'single', mode: 'new_history', returnVariant: 'price', currencyCode: 'INR', historyClass: 'live', dateFormat: 'DD-MMM-YYYY', numberLocale: 'plain' },
      selectedBenchmarks: [SENSEX_KEY], source: { owner: 'o', reference: 'r', originalFileName: 'sensex.csv', dataAsOf: null },
      counts: { rowsTotal: r.rowsTotal, rowsValid: r.rowsValid, rowsInvalid: r.rowsInvalid, rowsExcluded: 0, duplicatesCollapsed: 0 },
      mutation: { new: 5, revive: 0, identical: 0, correction: 0 }, scope: r.perBenchmark, hardErrorCount: 0, warningCount: 0, issues: [], issuesTruncated: false, corrections: [],
      requiredAcknowledgements: [], eligibility: { [SENSEX_KEY]: { eligible: false, entitlementId: null } }, eligible: false, stagingDigest: 'b'.repeat(64),
      blockers: ['No approved entitlement permits publication for: IN_SENSEX_PRI. A file upload does not itself establish usage permission.'],
    } as unknown as Parameters<typeof PreviewPanel>[0]['preview'];
    const html = renderToStaticMarkup(createElement(PreviewPanel, { preview, jobId: null }));
    expect(html).toContain('Recognised file layout: ');
    expect(html).toContain('(matched by its exact header)');
    expect(html).toContain('Columns in the file that were not loaded: Open, High, Low, Points Change');
    expect(html).toContain('28-09-2026');
    expect(html).toContain('07-10-2026');
    expect(html).toContain('Publication is disabled');
    expect(html).toContain('No approved entitlement permits publication');
  });
});

describe('preview: the layout lines', () => {
  it('a header-recognised layout reads "Recognised file layout: ... (matched by its exact header)" and lists the ignored columns', () => {
    const r = run('sensex.csv', SENSEX_BYTES, sensexParams({ shape: 'single' }));
    const l = describeLayoutDisclosure(r.disclosure);
    expect(l.layoutLine).toContain('Recognised file layout: ');
    expect(l.layoutLine).toContain('(matched by its exact header)');
    expect(l.layoutLine).toContain('matches a real download of 08-10-2026');
    expect(l.ignoredLine).toContain('Points Change');
    expect(l.ignoredLine).toContain('Div Yield');
  });
  it('a layout chosen by the operator is labelled as chosen, and an older stored preview claims nothing', () => {
    const r = run('nifty.csv', NIFTY_BYTES, niftyParams({ shape: 'provider_export', providerLayoutId: 'nse_price_export' }));
    expect(describeLayoutDisclosure(r.disclosure).layoutLine).toContain('(chosen by you)');
    expect(describeLayoutDisclosure({ headerRow: 1, layoutId: 'single_date_value', columnMapping: {} })).toEqual({ layoutLine: null, ignoredLine: null });
  });
});
