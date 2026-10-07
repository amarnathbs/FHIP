// Planning Benchmarks: a figure is formatted by ITS OWN currency or unit, never by the viewer's profile or locale
// (Product Owner, 07/10/2026: the DEV upload preview showed AUD 183000 as 1,83,000).
//
// FAILING-FIRST: on the base (52253bb plus 0277 work) the preview used n.toLocaleString('en-IN') for every figure, the
// Observed values and Target ranges tabs showed the raw database string, and there was no shared helper. Every test below
// that names figureFormat, previewFigures or the cell contexts fails there by construction, and the NC-F1 control re-creates
// the old behaviour and must fail the same assertion.
//
// EVIDENCE LABEL: UNIT-TESTED. The preview component is a client component (the repo has no jsdom), so its formatting is
// proven through the pure functions it calls plus a source contract; not browser-verified.
//
// NAMED NEGATIVE CONTROLS
//   NC-F1  the old formatter (en-IN for everything) fails the AUD assertion;
//   NC-F2  a formatter that follows the viewer (locale argument undefined) is caught: every call must name its locale;
//   NC-F3  the source sweep flags a hard-coded locale for a figure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENCY_NOT_STATED, currencyIsMissing, figureCurrency, formatCount, formatFigure } from '@/lib/planning-benchmarks/figureFormat';
import { localeForCurrencyCode, formatMoneyCode } from '@/lib/engines/money';
import { addFigureContext } from '@/lib/planning-benchmarks/previewFigures';
import { displayCell, type Row } from '@/components/admin/adminBenchmarksCells';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('formatFigure: the currency of the figure decides the grouping', () => {
  it('NEW: AUD 183000 reads 183,000 and AUD 182781 reads 182,781', () => {
    expect(formatFigure('183000', { unit: 'currency', currency: 'AUD' })).toBe('183,000');
    expect(formatFigure(182781, { unit: 'currency', currency: 'AUD' })).toBe('182,781');
  });

  it('NEW: INR 183000 reads 1,83,000 and INR 182781 reads 1,82,781', () => {
    expect(formatFigure('183000', { unit: 'currency', currency: 'INR' })).toBe('1,83,000');
    expect(formatFigure(182781, { unit: 'currency', currency: 'INR' })).toBe('1,82,781');
  });

  it('NEW: the same AUD figure reads the same whoever looks at it (an India-locale viewer cannot change it)', () => {
    // The helper takes no viewer input. Prove it never asks the runtime for the viewer's locale: every call names one.
    const calls: Array<string | undefined> = [];
    const original = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
      calls.push(Array.isArray(locales) ? String(locales[0]) : (locales as string | undefined));
      return original.call(this, locales, options);
    });
    // a viewer whose browser default is India
    const realFormat = Intl.NumberFormat;
    vi.stubGlobal('navigator', { language: 'en-IN', languages: ['en-IN'] });
    expect(formatFigure(183000, { unit: 'currency', currency: 'AUD' })).toBe('183,000');
    expect(formatFigure(183000, { unit: 'currency', currency: 'INR' })).toBe('1,83,000');
    expect(formatFigure(183000, { unit: 'count' })).toBe('183,000');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((l) => l === 'en-AU' || l === 'en-IN'), `locales used: ${calls.join(', ')}`).toBe(true);
    expect(Intl.NumberFormat).toBe(realFormat);
  });

  it('percentages, ratios, months, days and counts are plain numbers with Australian grouping, up to 4 decimals', () => {
    expect(formatFigure('12.5', { unit: 'percentage' })).toBe('12.5');
    expect(formatFigure('0.4567891', { unit: 'ratio' })).toBe('0.4568');
    expect(formatFigure('6', { unit: 'months' })).toBe('6');
    expect(formatFigure('100000', { unit: 'count' })).toBe('100,000');
    expect(formatFigure('1234567.5', { unit: 'days' })).toBe('1,234,567.5');
    // an unknown unit is shown as a plain number too, never as Indian grouping
    expect(formatFigure('183000')).toBe('183,000');
    expect(formatFigure('-2500.25', { unit: 'currency', currency: 'AUD' })).toBe('-2,500.25');
  });

  it('a currency figure keeps the decimals it has (the reviewer sees the exact figure), none forced', () => {
    expect(formatFigure('559000.5', { unit: 'currency', currency: 'AUD' })).toBe('559,000.5');
    expect(formatFigure('559000', { unit: 'currency', currency: 'AUD' })).toBe('559,000');
  });

  it('NEW: unit currency without original_currency falls back safely and says so', () => {
    expect(formatFigure('183000', { unit: 'currency' })).toBe(`183,000 (${CURRENCY_NOT_STATED})`);
    expect(formatFigure('183000', { unit: 'currency', currency: '' })).toBe(`183,000 (${CURRENCY_NOT_STATED})`);
    expect(formatFigure('183000', { unit: 'currency', currency: 'rupees' })).toBe(`183,000 (${CURRENCY_NOT_STATED})`);
    expect(currencyIsMissing({ unit: 'currency' })).toBe(true);
    expect(currencyIsMissing({ unit: 'currency', currency: 'AUD' })).toBe(false);
    expect(currencyIsMissing({ unit: 'percentage' })).toBe(false);
  });

  it('a band has no currency of its own: it takes the currency of its country, and says so when it has neither', () => {
    expect(formatFigure('183000', { unit: 'currency', country: 'AU' })).toBe('183,000');
    expect(formatFigure('183000', { unit: 'currency', country: 'IN' })).toBe('1,83,000');
    expect(formatFigure('183000', { unit: 'currency', country: 'GB' })).toBe(`183,000 (${CURRENCY_NOT_STATED})`);
    expect(formatFigure('183000', { unit: 'currency', currency: 'INR', country: 'AU' })).toBe('1,83,000'); // its own code wins
    expect(figureCurrency({ country: 'in' })).toBe('INR');
    expect(figureCurrency({})).toBeNull();
  });

  it('a missing value is none and text that is not a number comes back unchanged', () => {
    expect(formatFigure(null)).toBe('none');
    expect(formatFigure(undefined)).toBe('none');
    expect(formatFigure('')).toBe('none');
    expect(formatFigure('n/a', { unit: 'currency', currency: 'AUD' })).toBe('n/a');
  });

  it('the grouping rule is the one rule of lib/engines/money.ts, shared with the rest of the app', () => {
    expect(localeForCurrencyCode('INR')).toBe('en-IN');
    expect(localeForCurrencyCode('inr')).toBe('en-IN');
    expect(localeForCurrencyCode('AUD')).toBe('en-AU');
    expect(localeForCurrencyCode(null)).toBe('en-AU');
    expect(formatMoneyCode(183000, 'INR')).toContain('1,83,000');
    expect(formatMoneyCode(183000, 'AUD')).toContain('183,000');
  });

  it('NC-F1: the old preview formatter (en-IN for every figure) fails the AUD assertion', () => {
    const old = (v: string) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 });
    expect(old('183000')).toBe('1,83,000');
    expect(old('183000')).not.toBe(formatFigure('183000', { unit: 'currency', currency: 'AUD' }));
  });

  it('NC-F2: a formatter that follows the viewer is caught (the locale argument must always be named)', () => {
    const calls: Array<string | undefined> = [];
    const original = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
      calls.push(Array.isArray(locales) ? String(locales[0]) : (locales as string | undefined));
      return original.call(this, locales, options);
    });
    (183000).toLocaleString(undefined, { maximumFractionDigits: 4 }); // what a viewer-following formatter does
    expect(calls.every((l) => l === 'en-AU' || l === 'en-IN')).toBe(false);
  });
});

describe('the Observed values and Target ranges tabs show figures by their own currency', () => {
  const valueRow = (over: Row = {}): Row => ({
    id: 'v1', statistic_type: 'median', value_numeric: '183000', unit: 'currency', original_currency: 'AUD', is_derived: false,
    benchmark_metric_definitions: { metric_code: 'net_worth', metric_name: 'Net worth', unit: 'currency' }, benchmark_datasets: { dataset_name: 'D' }, ...over,
  });
  const bandRow = (over: Row = {}): Row => ({
    id: 'b1', country_code: 'AU', band_label: 'low', band_tier: 1, lower_bound: '183000', upper_bound: '1250000.5',
    benchmark_metric_definitions: { metric_code: 'net_worth', metric_name: 'Net worth', unit: 'currency' }, ...over,
  });

  it('NEW: an AUD value reads 183,000 and an INR value reads 1,83,000', () => {
    expect(displayCell(valueRow(), 'Value')).toBe('183,000');
    expect(displayCell(valueRow({ original_currency: 'INR' }), 'Value')).toBe('1,83,000');
  });

  it('NEW: a percentage value is plain; a currency value with no currency says so', () => {
    expect(displayCell(valueRow({ unit: 'percentage', original_currency: null, value_numeric: '12.5' }), 'Value')).toBe('12.5');
    expect(displayCell(valueRow({ original_currency: null }), 'Value')).toBe(`183,000 (${CURRENCY_NOT_STATED})`);
  });

  it('NEW: band bounds take the currency of their country and the unit of their metric', () => {
    expect(displayCell(bandRow(), 'Min')).toBe('183,000');
    expect(displayCell(bandRow(), 'Max')).toBe('1,250,000.5');
    expect(displayCell(bandRow({ country_code: 'IN' }), 'Max')).toBe('12,50,000.5');
    expect(displayCell(bandRow({ benchmark_metric_definitions: { metric_code: 'savings_rate', unit: 'percentage' }, upper_bound: '20' }), 'Max')).toBe('20');
  });

  it('an open ended band keeps its dash, and the other columns are unchanged', () => {
    expect(displayCell(bandRow({ upper_bound: null }), 'Max')).toBe('—');
    expect(displayCell(bandRow(), 'Band Label')).toBe('low');
  });

  it('the target ranges route selects the metric unit the tab needs', () => {
    expect(read('app/api/admin/benchmarks/target-ranges/route.ts')).toMatch(/benchmark_metric_definitions!inner\(metric_code, metric_name, unit\)/);
    expect(read('components/admin/AdminBenchmarksClient.tsx')).toMatch(/displayCell\(r, c\)/);
  });
});

// A chainable fake of the Supabase reads previewFigures makes.
function fakeClient(tables: Record<string, Row[]>, failTable?: string) {
  return {
    from: (t: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        order: () => q,
        limit: () => q,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(failTable === t ? { data: null, error: { message: 'boom' } } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(res),
      };
      return q;
    },
  } as never;
}

describe('previewFigures: the currency and unit the preview needs', () => {
  const valuesReply = (): Row => ({
    batch: { id: 'b1', kind: 'values' },
    rows: [
      { row_no: 2, metric_code: 'net_worth', unit: 'currency', new_value: '183000', live_value: '182781' },
      { row_no: 3, metric_code: 'savings_rate', unit: 'percentage', new_value: '12', live_value: null },
    ],
    removed: [],
  });

  it('NEW: adds the staged and the live currency to each value row, so the live figure is formatted by its own currency', async () => {
    const out = await addFigureContext(
      fakeClient({
        benchmark_upload_rows: [
          { batch_id: 'b1', row_no: 2, payload: { original_currency: 'AUD' }, live_ids: ['lv1'] },
          { batch_id: 'b1', row_no: 3, payload: { original_currency: '' }, live_ids: [] },
        ],
        benchmark_values: [{ id: 'lv1', original_currency: 'INR' }],
      }),
      valuesReply()
    );
    const rows = out.rows as Row[];
    expect(rows[0]).toMatchObject({ currency: 'AUD', live_currency: 'INR' });
    expect(rows[1]).toMatchObject({ currency: null, live_currency: null });
    // the screen's own formatting of what it receives
    expect(formatFigure(rows[0].new_value as string, { unit: 'currency', currency: rows[0].currency as string })).toBe('183,000');
    expect(formatFigure(rows[0].live_value as string, { unit: 'currency', currency: rows[0].live_currency as string })).toBe('1,82,781');
  });

  it('NEW: adds the metric unit to every band row and to every removed band', async () => {
    const reply: Row = {
      batch: { id: 'b2', kind: 'target_ranges' },
      rows: [{ row_no: 2, metric_code: 'net_worth', country_code: 'AU' }],
      removed: [{ metric_code: 'savings_rate', band_tier: 3, band_label: 'high', lower: '20', upper: null, country_code: 'AU' }],
    };
    const out = await addFigureContext(fakeClient({ benchmark_metric_definitions: [{ metric_code: 'net_worth', unit: 'currency' }, { metric_code: 'savings_rate', unit: 'percentage' }] }), reply);
    expect((out.rows as Row[])[0].metric_unit).toBe('currency');
    expect((out.removed as Row[])[0].metric_unit).toBe('percentage');
  });

  it('a cohorts batch and an unreadable table return the reply unchanged (the screen then says currency not stated)', async () => {
    const cohorts: Row = { batch: { id: 'b3', kind: 'cohorts' }, rows: [{ row_no: 2 }], removed: [] };
    expect(await addFigureContext(fakeClient({}), cohorts)).toBe(cohorts);
    const v = valuesReply();
    expect(await addFigureContext(fakeClient({}, 'benchmark_upload_rows'), v)).toBe(v);
    const throwing = { from: () => { throw new Error('down'); } } as never;
    expect(await addFigureContext(throwing, v)).toBe(v);
  });
});

describe('source sweep: no Planning Benchmarks screen picks a figure locale on its own', () => {
  const FILES = [
    'components/admin/PlanningBenchmarkUpload.tsx',
    'components/admin/PlanningBenchmarkAllowedValues.tsx',
    'components/admin/PlanningBenchmarkDatasetMetrics.tsx',
    'components/admin/adminBenchmarksCells.ts',
    'components/admin/AdminBenchmarksClient.tsx',
    'lib/planning-benchmarks/allowedValues.ts',
    'lib/planning-benchmarks/uploadValidate.ts',
    'lib/planning-benchmarks/uploadTemplates.ts',
    'lib/planning-benchmarks/previewFigures.ts',
  ];
  const violations = (src: string) => [...src.matchAll(/toLocaleString\(\s*(?!['"]en-AU['"])[^)]*\)|Intl\.NumberFormat\(\s*(?:undefined|navigator)/g)].map((m) => m[0]);

  it('NEW: none of them calls toLocaleString with another locale or with the viewer locale', () => {
    for (const f of FILES) expect(violations(read(f)), f).toEqual([]);
  });

  it('NEW: the upload preview formats through the shared helper', () => {
    const t = read('components/admin/PlanningBenchmarkUpload.tsx');
    expect(t).toMatch(/formatFigure/);
    expect(t).toMatch(/figureFormat/);
    expect(t).not.toMatch(/en-IN/);
  });

  it('NC-F3: the sweep flags a hard-coded locale and a viewer locale', () => {
    expect(violations("x.toLocaleString('en-IN', { maximumFractionDigits: 4 })")).not.toEqual([]);
    expect(violations('x.toLocaleString()')).not.toEqual([]); // no locale argument follows the viewer
    expect(violations('x.toLocaleString(undefined, {})')).not.toEqual([]);
    expect(violations("new Intl.NumberFormat(undefined, {})")).not.toEqual([]);
  });
});
