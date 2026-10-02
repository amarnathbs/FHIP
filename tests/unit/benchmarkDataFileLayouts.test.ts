// BENCH-1 Phase 2 -- file layout registry and column resolution (pure).
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_LAYOUTS,
  resolveLayout,
  type UploadParams,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

const base = (o: Partial<UploadParams> = {}): UploadParams => ({
  shape: 'single',
  mode: 'new_history',
  returnVariant: 'total_return',
  currencyCode: 'INR',
  historyClass: 'live',
  dateFormat: 'YYYY-MM-DD',
  numberLocale: 'plain',
  ...o,
});

const failure = (header: string[], p: UploadParams) => {
  const r = resolveLayout(header, p);
  if (r.ok) throw new Error(`expected failure, resolved ${r.layout.id}`);
  return r;
};
const success = (header: string[], p: UploadParams) => {
  const r = resolveLayout(header, p);
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r;
};

describe('single and multi shapes', () => {
  it('single: requires exactly date,value (any order, any case, trimmed)', () => {
    const r = success([' Value ', 'DATE'], base());
    expect(r.layout.id).toBe('single_date_value');
    expect(r.mapping).toEqual({ dateColumn: 'DATE', valueColumn: ' Value ', keyColumn: undefined });
  });

  it('single: an extra column is rejected, not ignored', () => {
    const r = failure(['date', 'value', 'volume'], base());
    expect(r.code).toBe('UNEXPECTED_COLUMN');
    expect(r.message).toContain('volume');
    expect(failure(['date', 'value', ''], base()).code).toBe('UNEXPECTED_COLUMN');
  });

  it('single: a missing column is reported', () => {
    expect(failure(['date'], base()).code).toBe('REQUIRED_COLUMN_MISSING');
    expect(failure(['value'], base()).code).toBe('REQUIRED_COLUMN_MISSING');
    // A multi-style header is not a single-benchmark header.
    expect(failure(['benchmark_key', 'date', 'value'], base()).code).toBe('UNEXPECTED_COLUMN');
  });

  it('multi: requires benchmark_key,date,value', () => {
    const r = success(['Benchmark_Key', 'Date', 'Value'], base({ shape: 'multi' }));
    expect(r.layout.id).toBe('multi_key_date_value');
    expect(r.mapping.keyColumn).toBe('Benchmark_Key');
    expect(failure(['date', 'value'], base({ shape: 'multi' })).code).toBe('REQUIRED_COLUMN_MISSING');
    expect(failure(['benchmark_key', 'date', 'value', 'x'], base({ shape: 'multi' })).code).toBe('UNEXPECTED_COLUMN');
  });

  it('rejects duplicate (case-insensitively equal) headers', () => {
    expect(failure(['date', 'Date', 'value'], base()).code).toBe('DUPLICATE_HEADER');
  });
});

describe('registered provider layouts', () => {
  it('every registry entry is labelled UNVERIFIED and self-consistent', () => {
    expect(Object.keys(PROVIDER_LAYOUTS).sort()).toEqual(['bse_price_export', 'nse_ind_close_all', 'nse_price_export', 'nse_tri_export']);
    for (const [id, l] of Object.entries(PROVIDER_LAYOUTS)) {
      expect(l.id).toBe(id);
      expect(l.unverified).toBe(true);
      expect(l.note).toContain('UNVERIFIED');
      expect(l.requiredHeaders).toContain(l.dateColumn);
      expect(l.requiredHeaders).toContain(l.valueColumn);
    }
  });

  it('resolves by explicit id', () => {
    const r = success(['Date', 'Total Returns Index'], base({ shape: 'provider_export', providerLayoutId: 'nse_tri_export' }));
    expect(r.layout.id).toBe('nse_tri_export');
    expect(r.layout.variantHint).toBe('total_return');
    expect(r.layout.unverified).toBe(true);
    expect(r.mapping).toEqual({ dateColumn: 'Date', valueColumn: 'Total Returns Index', indexNameColumn: undefined });
    expect(r.notes.join(' ')).toContain('UNVERIFIED');
  });

  it('auto-recognises a header that equals a registered set exactly', () => {
    const p = base({ shape: 'provider_export', returnVariant: 'price' });
    expect(success(['Index Name', 'Date', 'Open', 'High', 'Low', 'Close'], p).layout.id).toBe('nse_price_export');
    expect(success(['date', 'open', 'high', 'low', 'close'], p).layout.id).toBe('bse_price_export');
    expect(success(['Date', 'Total Returns Index'], base({ shape: 'provider_export' })).layout.id).toBe('nse_tri_export');
    const all = success(
      ['Index Name', 'Index Date', 'Open Index Value', 'High Index Value', 'Low Index Value', 'Closing Index Value', 'Points Change'],
      p,
    );
    expect(all.layout.id).toBe('nse_ind_close_all');
    expect(all.mapping.indexNameColumn).toBe('Index Name');
    expect(all.mapping.valueColumn).toBe('Closing Index Value');
    expect(all.notes.join(' ')).toContain('Ignored extra columns');
  });

  it('never infers: an unrecognised header is LAYOUT_UNRECOGNISED with the closest candidates', () => {
    const r = failure(['Date', 'Close Price', 'Volume'], base({ shape: 'provider_export', returnVariant: 'price' }));
    expect(r.code).toBe('LAYOUT_UNRECOGNISED');
    expect(r.candidates?.length).toBeGreaterThan(0);
    expect(r.candidates!.length).toBeLessThanOrEqual(3);
    expect(Object.keys(PROVIDER_LAYOUTS)).toEqual(expect.arrayContaining(r.candidates as string[]));
    // A header with the right columns plus an unlisted one is also not silently accepted for a strict layout.
    expect(failure(['Date', 'Total Returns Index', 'Volume'], base({ shape: 'provider_export' })).code).toBe('LAYOUT_UNRECOGNISED');
  });

  it('an explicit id with a non-matching header is LAYOUT_HEADER_MISMATCH; an unknown id is rejected', () => {
    const r = failure(['Date', 'Close'], base({ shape: 'provider_export', providerLayoutId: 'nse_tri_export' }));
    expect(r.code).toBe('LAYOUT_HEADER_MISMATCH');
    expect(r.message).toContain('Total Returns Index');
    expect(failure(['Date', 'Total Returns Index', 'Volume'], base({ shape: 'provider_export', providerLayoutId: 'nse_tri_export' })).code).toBe('LAYOUT_HEADER_MISMATCH');
    expect(failure(['Date'], base({ shape: 'provider_export', providerLayoutId: 'nope' })).code).toBe('LAYOUT_UNKNOWN_ID');
    expect(failure(['Date'], base({ shape: 'provider_export', providerLayoutId: 'constructor' })).code).toBe('LAYOUT_UNKNOWN_ID');
  });

  it('a layout whose variant conflicts with the declared variant is a hard VARIANT_LAYOUT_CONFLICT', () => {
    const tri = failure(['Date', 'Total Returns Index'], base({ shape: 'provider_export', returnVariant: 'price' }));
    expect(tri.code).toBe('VARIANT_LAYOUT_CONFLICT');
    expect(tri.message).toContain('total_return');
    expect(failure(['Date', 'Total Returns Index'], base({ shape: 'provider_export', returnVariant: 'net_total_return' })).code).toBe('VARIANT_LAYOUT_CONFLICT');
    expect(failure(['Date', 'Open', 'High', 'Low', 'Close'], base({ shape: 'provider_export', returnVariant: 'total_return' })).code).toBe('VARIANT_LAYOUT_CONFLICT');
    expect(
      failure(['Index Name', 'Index Date', 'Closing Index Value'], base({ shape: 'provider_export', providerLayoutId: 'nse_ind_close_all', returnVariant: 'total_return' })).code,
    ).toBe('VARIANT_LAYOUT_CONFLICT');
    // Controls: the matching declaration resolves.
    expect(success(['Date', 'Total Returns Index'], base({ shape: 'provider_export', returnVariant: 'total_return' })).ok).toBe(true);
    expect(success(['Date', 'Open', 'High', 'Low', 'Close'], base({ shape: 'provider_export', returnVariant: 'price' })).ok).toBe(true);
  });

  it('notes a date-format choice that differs from the layout usual one (advisory only)', () => {
    const r = success(['Date', 'Total Returns Index'], base({ shape: 'provider_export', dateFormat: 'DD/MM/YYYY' }));
    expect(r.notes.join(' ')).toContain('DD MMM YYYY');
  });
});

describe('explicit column mapping', () => {
  const p = (columnMap: UploadParams['columnMap'], o: Partial<UploadParams> = {}) => base({ shape: 'provider_export', columnMap, ...o });

  it('maps named columns case-insensitively to the real header text', () => {
    const r = success(['Trade Date', 'Settle', 'Notes'], p({ date: 'trade date', value: 'SETTLE' }));
    expect(r.layout.id).toBe('explicit_column_map');
    expect(r.mapping).toEqual({ dateColumn: 'Trade Date', valueColumn: 'Settle', keyColumn: undefined, indexNameColumn: undefined });
  });

  it('every named column must exist in the header', () => {
    const r = failure(['Trade Date', 'Settle'], p({ date: 'Trade Date', value: 'Close' }));
    expect(r.code).toBe('MAPPED_COLUMN_MISSING');
    expect(r.message).toContain('Close');
    expect(failure(['a', 'b'], p({ date: 'a' })).code).toBe('MAPPED_COLUMN_MISSING');
    expect(failure(['a', 'b'], p({ value: 'b' })).code).toBe('MAPPED_COLUMN_MISSING');
    expect(failure(['a', 'b', 'c'], p({ date: 'a', value: 'b', benchmarkKey: 'zzz' })).code).toBe('MAPPED_COLUMN_MISSING');
  });

  it('two roles cannot map to one column', () => {
    expect(failure(['Close', 'x'], p({ date: 'Close', value: 'close' })).code).toBe('MAPPED_COLUMNS_COLLIDE');
    expect(failure(['a', 'b'], p({ date: 'a', value: 'b', benchmarkKey: 'b' })).code).toBe('MAPPED_COLUMNS_COLLIDE');
  });

  it('identity must come from one place only; layout id and map cannot both be given', () => {
    expect(failure(['a', 'b', 'k', 'n'], p({ date: 'a', value: 'b', benchmarkKey: 'k', indexName: 'n' })).code).toBe('COLUMN_MAP_KEY_AND_INDEX_NAME');
    expect(failure(['Date', 'Total Returns Index'], p({ date: 'Date', value: 'Total Returns Index' }, { providerLayoutId: 'nse_tri_export' })).code).toBe('LAYOUT_AND_COLUMN_MAP_BOTH');
  });

  it('carries key and index-name columns when mapped', () => {
    expect(success(['a', 'b', 'k'], p({ date: 'a', value: 'b', benchmarkKey: 'k' })).mapping.keyColumn).toBe('k');
    expect(success(['a', 'b', 'n'], p({ date: 'a', value: 'b', indexName: 'n' })).mapping.indexNameColumn).toBe('n');
  });
});
