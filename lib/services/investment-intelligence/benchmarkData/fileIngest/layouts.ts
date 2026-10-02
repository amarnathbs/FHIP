// File-layout registry and resolver. A header is only ever mapped to the date /
// value / key roles in one of three explicit ways: (a) the fixed single or
// multi-benchmark shapes, (b) a REGISTERED provider layout, or (c) an explicit
// operator column map. Arbitrary columns are never inferred silently.
//
// HONESTY NOTE: the provider header sets below are written from publicly
// visible export conventions (the same ones indexCsvParser.ts documents). They
// are UNVERIFIED against a live download. Treat a mismatch as "register the
// real header set", never as "guess the columns".
import type { ColumnMap, DateFormatId, ReturnVariant, UploadParams } from './types';

export interface ProviderLayout {
  id: string;
  label: string;
  /** Exact required header set (compared case-insensitively, whitespace-normalised). */
  requiredHeaders: string[];
  dateColumn: string;
  valueColumn: string;
  /** Present when the file carries an index-name column (single- or multi-index). */
  indexNameColumn?: string;
  defaultDateFormat: DateFormatId;
  variantHint: ReturnVariant | null;
  /** When true, extra columns beyond requiredHeaders are expected (and listed as ignored). */
  allowExtraColumns: boolean;
  /** Always true: header sets are from public conventions, not a verified live download. */
  unverified: true;
  note: string;
}

export const PROVIDER_LAYOUTS: Record<string, ProviderLayout> = {
  nse_tri_export: {
    id: 'nse_tri_export',
    label: 'NSE Indices total-return export (Date, Total Returns Index)',
    requiredHeaders: ['Date', 'Total Returns Index'],
    dateColumn: 'Date',
    valueColumn: 'Total Returns Index',
    defaultDateFormat: 'DD MMM YYYY',
    variantHint: 'total_return',
    allowExtraColumns: false,
    unverified: true,
    note: 'UNVERIFIED: header set taken from publicly visible conventions, not from a recorded live download.',
  },
  nse_price_export: {
    id: 'nse_price_export',
    label: 'NSE Indices price history export (Index Name, Date, Open, High, Low, Close)',
    requiredHeaders: ['Index Name', 'Date', 'Open', 'High', 'Low', 'Close'],
    dateColumn: 'Date',
    valueColumn: 'Close',
    indexNameColumn: 'Index Name',
    defaultDateFormat: 'DD MMM YYYY',
    variantHint: 'price',
    allowExtraColumns: false,
    unverified: true,
    note: 'UNVERIFIED: header set taken from publicly visible conventions, not from a recorded live download.',
  },
  bse_price_export: {
    id: 'bse_price_export',
    label: 'BSE index history export (Date, Open, High, Low, Close)',
    requiredHeaders: ['Date', 'Open', 'High', 'Low', 'Close'],
    dateColumn: 'Date',
    valueColumn: 'Close',
    defaultDateFormat: 'DD-MMM-YYYY',
    variantHint: 'price',
    allowExtraColumns: false,
    unverified: true,
    note: 'UNVERIFIED: header set taken from publicly visible conventions, not from a recorded live download.',
  },
  nse_ind_close_all: {
    id: 'nse_ind_close_all',
    label: 'NSE daily all-index close file (Index Name, Index Date, Closing Index Value, ...)',
    requiredHeaders: ['Index Name', 'Index Date', 'Closing Index Value'],
    dateColumn: 'Index Date',
    valueColumn: 'Closing Index Value',
    indexNameColumn: 'Index Name',
    defaultDateFormat: 'DD-MM-YYYY',
    variantHint: 'price',
    allowExtraColumns: true,
    unverified: true,
    note: 'UNVERIFIED: header set taken from publicly visible conventions, not from a recorded live download. Multi-index daily file: every index in it needs an explicit index-name to benchmark_key mapping.',
  },
};

export interface ResolvedLayout {
  id: string;
  label: string;
  shape: UploadParams['shape'];
  variantHint: ReturnVariant | null;
  defaultDateFormat: DateFormatId | null;
  unverified: boolean;
}

export interface ResolvedMapping {
  dateColumn: string;
  valueColumn: string;
  keyColumn?: string;
  indexNameColumn?: string;
}

export type LayoutResolution =
  | { ok: true; layout: ResolvedLayout; mapping: ResolvedMapping; notes: string[] }
  | { ok: false; code: string; message: string; candidates?: string[] };

export function normaliseHeaderName(h: string): string {
  return h.replace(/﻿/g, '').trim().toLowerCase().split(/\s+/).join(' ');
}

function fail(code: string, message: string, candidates?: string[]): LayoutResolution {
  return candidates ? { ok: false, code, message, candidates } : { ok: false, code, message };
}

/** Maps normalised name -> original header text; null when a normalised name occurs twice. */
function indexHeader(header: string[]): { ok: true; byNorm: Map<string, string> } | { ok: false; dup: string } {
  const byNorm = new Map<string, string>();
  for (const h of header) {
    const n = normaliseHeaderName(h);
    if (n === '') continue;
    if (byNorm.has(n)) return { ok: false, dup: h };
    byNorm.set(n, h);
  }
  return { ok: true, byNorm };
}

function checkVariant(variantHint: ReturnVariant | null, params: UploadParams, label: string): LayoutResolution | null {
  if (variantHint !== null && variantHint !== params.returnVariant) {
    return fail(
      'VARIANT_LAYOUT_CONFLICT',
      `The file layout "${label}" is a ${variantHint} series but the upload is declared as ${params.returnVariant}. Price, total-return and net total-return series are different products; fix the declaration or upload the correct file.`,
    );
  }
  return null;
}

export function resolveLayout(header: string[], params: UploadParams): LayoutResolution {
  const idx = indexHeader(header);
  if (!idx.ok) return fail('DUPLICATE_HEADER', `The header has the column "${idx.dup}" more than once.`);
  const { byNorm } = idx;
  const notes: string[] = [];

  if (params.shape === 'single' || params.shape === 'multi') {
    const required = params.shape === 'single' ? ['date', 'value'] : ['benchmark_key', 'date', 'value'];
    const id = params.shape === 'single' ? 'single_date_value' : 'multi_key_date_value';
    for (const h of header) {
      const n = normaliseHeaderName(h);
      if (!required.includes(n)) {
        return fail(
          'UNEXPECTED_COLUMN',
          `The column "${h.slice(0, 40)}" is not part of the ${required.join(',')} layout. Remove it, or use a provider export with an explicit column mapping.`,
        );
      }
    }
    const missing = required.filter((r) => !byNorm.has(r));
    if (missing.length > 0) {
      return fail('REQUIRED_COLUMN_MISSING', `The header must contain ${required.join(', ')}; missing: ${missing.join(', ')}.`);
    }
    return {
      ok: true,
      layout: {
        id,
        label: params.shape === 'single' ? 'Single benchmark: date,value' : 'Multiple benchmarks: benchmark_key,date,value',
        shape: params.shape,
        variantHint: null,
        defaultDateFormat: null,
        unverified: false,
      },
      mapping: {
        dateColumn: byNorm.get('date') as string,
        valueColumn: byNorm.get('value') as string,
        keyColumn: params.shape === 'multi' ? byNorm.get('benchmark_key') : undefined,
      },
      notes,
    };
  }

  // provider_export
  if (params.providerLayoutId && params.columnMap) {
    return fail(
      'LAYOUT_AND_COLUMN_MAP_BOTH',
      'Choose either a registered provider layout or an explicit column map, not both.',
    );
  }

  if (params.columnMap) return resolveExplicit(params.columnMap, byNorm, header, params);

  let layout: ProviderLayout | undefined;
  if (params.providerLayoutId) {
    layout = Object.prototype.hasOwnProperty.call(PROVIDER_LAYOUTS, params.providerLayoutId)
      ? PROVIDER_LAYOUTS[params.providerLayoutId]
      : undefined;
    if (!layout) return fail('LAYOUT_UNKNOWN_ID', `"${params.providerLayoutId.slice(0, 40)}" is not a registered provider layout.`);
    const missing = layout.requiredHeaders.filter((r) => !byNorm.has(normaliseHeaderName(r)));
    if (missing.length > 0) {
      return fail(
        'LAYOUT_HEADER_MISMATCH',
        `The header does not match "${layout.label}"; missing columns: ${missing.join(', ')}.`,
        [layout.id],
      );
    }
    if (!layout.allowExtraColumns) {
      const extra = header.filter((h) => normaliseHeaderName(h) !== '' && !layout!.requiredHeaders.some((r) => normaliseHeaderName(r) === normaliseHeaderName(h)));
      if (extra.length > 0) {
        return fail(
          'LAYOUT_HEADER_MISMATCH',
          `The header has columns that "${layout.label}" does not list: ${extra.join(', ')}.`,
          [layout.id],
        );
      }
    }
  } else {
    // Auto-recognise: exact header-set equality first; a superset only for layouts that expect extras.
    const names = new Set(byNorm.keys());
    const reqNorm = (l: ProviderLayout) => l.requiredHeaders.map(normaliseHeaderName);
    const exact = Object.values(PROVIDER_LAYOUTS).filter((l) => {
      const r = reqNorm(l);
      return r.length === names.size && r.every((x) => names.has(x));
    });
    const supersets = Object.values(PROVIDER_LAYOUTS).filter(
      (l) => l.allowExtraColumns && reqNorm(l).every((x) => names.has(x)) && !exact.includes(l),
    );
    const matches = exact.length > 0 ? exact : supersets;
    if (matches.length === 1) layout = matches[0];
    else if (matches.length > 1) {
      return fail('LAYOUT_AMBIGUOUS', 'The header matches more than one registered layout; choose one explicitly.', matches.map((m) => m.id));
    } else {
      const scored = Object.values(PROVIDER_LAYOUTS)
        .map((l) => ({ id: l.id, hits: reqNorm(l).filter((x) => names.has(x)).length }))
        .sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
      return fail(
        'LAYOUT_UNRECOGNISED',
        'The header matches no registered provider layout. Pick a layout, or supply an explicit column mapping; columns are never guessed.',
        scored.slice(0, 3).map((s) => s.id),
      );
    }
    notes.push(`Layout recognised from the header: ${layout.label}.`);
  }

  const conflict = checkVariant(layout.variantHint, params, layout.label);
  if (conflict) return conflict;

  const used = new Set(layout.requiredHeaders.map(normaliseHeaderName));
  const ignored = header.filter((h) => normaliseHeaderName(h) !== '' && !used.has(normaliseHeaderName(h)));
  const unused = layout.requiredHeaders.filter((r) => r !== layout!.dateColumn && r !== layout!.valueColumn && r !== layout!.indexNameColumn);
  if (unused.length > 0) notes.push(`Columns present but not used as data: ${unused.join(', ')}.`);
  if (ignored.length > 0) notes.push(`Ignored extra columns: ${ignored.join(', ')}.`);
  if (params.dateFormat !== layout.defaultDateFormat) {
    notes.push(`The layout usually uses date format ${layout.defaultDateFormat}; you selected ${params.dateFormat}.`);
  }
  notes.push(layout.note);
  return {
    ok: true,
    layout: {
      id: layout.id,
      label: layout.label,
      shape: 'provider_export',
      variantHint: layout.variantHint,
      defaultDateFormat: layout.defaultDateFormat,
      unverified: layout.unverified,
    },
    mapping: {
      dateColumn: byNorm.get(normaliseHeaderName(layout.dateColumn)) as string,
      valueColumn: byNorm.get(normaliseHeaderName(layout.valueColumn)) as string,
      indexNameColumn: layout.indexNameColumn ? byNorm.get(normaliseHeaderName(layout.indexNameColumn)) : undefined,
    },
    notes,
  };
}

function resolveExplicit(
  map: ColumnMap,
  byNorm: Map<string, string>,
  header: string[],
  params: UploadParams,
): LayoutResolution {
  void header;
  void params;
  if (!map.date || !map.value) {
    return fail('MAPPED_COLUMN_MISSING', 'An explicit column map must name both the date column and the value column.');
  }
  if (map.benchmarkKey && map.indexName) {
    return fail(
      'COLUMN_MAP_KEY_AND_INDEX_NAME',
      'Map either a benchmark_key column or an index-name column, not both: the benchmark identity must come from exactly one place.',
    );
  }
  const roles: Array<[keyof ColumnMap, string]> = [];
  for (const role of ['date', 'value', 'benchmarkKey', 'indexName'] as const) {
    const name = map[role];
    if (name !== undefined && name !== '') roles.push([role, name]);
  }
  const resolved: Partial<Record<keyof ColumnMap, string>> = {};
  const taken = new Map<string, keyof ColumnMap>();
  for (const [role, name] of roles) {
    const n = normaliseHeaderName(name);
    const actual = byNorm.get(n);
    if (!actual) {
      return fail('MAPPED_COLUMN_MISSING', `The ${role} column "${name.slice(0, 40)}" does not exist in the file header.`);
    }
    const prev = taken.get(n);
    if (prev) {
      return fail('MAPPED_COLUMNS_COLLIDE', `The ${prev} and ${role} roles are mapped to the same column "${actual}".`);
    }
    taken.set(n, role);
    resolved[role] = actual;
  }
  return {
    ok: true,
    layout: {
      id: 'explicit_column_map',
      label: 'Explicit operator column mapping',
      shape: 'provider_export',
      variantHint: null,
      defaultDateFormat: null,
      unverified: false,
    },
    mapping: {
      dateColumn: resolved.date as string,
      valueColumn: resolved.value as string,
      keyColumn: resolved.benchmarkKey,
      indexNameColumn: resolved.indexName,
    },
    notes: ['Columns were mapped explicitly by the operator; columns not listed in the mapping are ignored.'],
  };
}
