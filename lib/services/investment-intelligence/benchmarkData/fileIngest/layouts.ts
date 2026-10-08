// File-layout registry and resolver. A header is only ever mapped to the date /
// value / key roles in one of three explicit ways: (a) the fixed single or
// multi-benchmark shapes, (b) a REGISTERED provider layout, or (c) an explicit
// operator column map. Arbitrary columns are never inferred silently.
//
// HONESTY NOTE: a provider header set is marked `unverified: false` ONLY when it
// has been compared, byte for byte, with a real download recorded by the Product
// Owner (the `note` of that layout names the file and the date). Every other
// header set below was written from publicly visible export conventions (the
// same ones indexCsvParser.ts documents) and stays UNVERIFIED. Treat a mismatch
// as "register the real header set", never as "guess the columns".
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
  /**
   * Extra columns this layout is KNOWN to carry and that are deliberately NOT loaded
   * (listed as ignored in the preview, never mapped). Matching stays exact: a column
   * that is neither required nor listed here is refused, so an arbitrary new column
   * is never silently accepted. Unlike allowExtraColumns, this is a closed list.
   */
  ignoredHeaders?: string[];
  /**
   * false ONLY when the header set was compared with a real recorded download (named in
   * `note`). true means "from public conventions, not checked against a live download".
   */
  unverified: boolean;
  note: string;
}

const UNVERIFIED_NOTE = 'UNVERIFIED: header set taken from publicly visible conventions, not from a recorded live download.';

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
    note: UNVERIFIED_NOTE,
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
    unverified: false,
    note: 'Header set matches a real download of 08-10-2026 (NIFTY 50 historical data, price index, from niftyindices.com): every field quoted, dates like 07 Oct 2026, newest row first.',
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
    note: UNVERIFIED_NOTE,
  },
  bse_sensex_download: {
    id: 'bse_sensex_download',
    label: 'BSE Sensex history download (Date, Open, High, Low, Close and statistics columns)',
    requiredHeaders: ['Date', 'Open', 'High', 'Low', 'Close'],
    dateColumn: 'Date',
    valueColumn: 'Close',
    defaultDateFormat: 'DD-MMM-YYYY',
    variantHint: 'price',
    allowExtraColumns: false,
    ignoredHeaders: ['Points Change', 'Change(%)', 'Volume(Cr.)', 'Turnover (Rs.Cr.)', 'P/E', 'P/B', 'Div Yield'],
    unverified: false,
    note: 'Header set matches a real download of 08-10-2026 (BSE Sensex historical data): unquoted, no index-name column, dates like 28-September-2026 and 1-October-2026 (full month name, day not zero-padded), oldest row first. The file does not name the index, so the benchmark you choose decides. Only Date and Close are loaded; the seven statistics columns are ignored.',
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
    note: UNVERIFIED_NOTE + ' Multi-index daily file: every index in it needs an explicit index-name to benchmark_key mapping.',
  },
};

export interface ResolvedLayout {
  id: string;
  label: string;
  shape: UploadParams['shape'];
  variantHint: ReturnVariant | null;
  defaultDateFormat: DateFormatId | null;
  unverified: boolean;
  /** How the layout was decided: by the file's exact header, by the operator's choice, by the fixed shape, or by an explicit column map. */
  matchedBy: 'header' | 'chosen' | 'fixed' | 'column_map';
}

export interface ResolvedMapping {
  dateColumn: string;
  valueColumn: string;
  keyColumn?: string;
  indexNameColumn?: string;
}

export type LayoutResolution =
  | {
      ok: true;
      layout: ResolvedLayout;
      mapping: ResolvedMapping;
      notes: string[];
      /** Header columns that are NOT loaded (exact header text), so the preview can list them. */
      ignoredColumns: string[];
    }
  | { ok: false; code: string; message: string; candidates?: string[] };

export function normaliseHeaderName(h: string): string {
  return h.replace(/﻿/g, '').trim().toLowerCase().split(/\s+/).join(' ');
}

function normSet(list: readonly string[] | undefined): Set<string> {
  return new Set((list ?? []).map(normaliseHeaderName));
}

/**
 * The registered provider layouts a header set is recognised as. ONE function for the
 * server resolver and the form's hint, so they can never disagree. Matching is exact:
 *   tier 1  the header set equals the layout's required set;
 *   tier 2  the header holds the required set plus ONLY columns the layout lists as
 *           known-and-ignored (a closed list);
 *   tier 3  the header holds the required set and the layout declares that arbitrary
 *           extra columns are expected (allowExtraColumns).
 * The first tier that matches anything wins. A column nobody registered never matches.
 */
export function matchRegisteredLayouts(header: readonly string[], opts: { allowArbitraryExtras?: boolean } = {}): ProviderLayout[] {
  const names = new Set(header.map(normaliseHeaderName).filter((n) => n !== ''));
  if (names.size === 0) return [];
  const all = Object.values(PROVIDER_LAYOUTS);
  const req = (l: ProviderLayout) => normSet(l.requiredHeaders);
  const hasAllRequired = (l: ProviderLayout) => [...req(l)].every((x) => names.has(x));
  // A layout that lists known-ignorable columns is recognised only when the header actually carries
  // at least one of them (tier 2); the bare required set belongs to the plain layout of that shape.
  const exact = all.filter((l) => {
    const r = req(l);
    return !l.ignoredHeaders?.length && r.size === names.size && [...r].every((x) => names.has(x));
  });
  if (exact.length > 0) return exact;
  const closedExtras = all.filter((l) => {
    if (!l.ignoredHeaders || l.ignoredHeaders.length === 0 || !hasAllRequired(l)) return false;
    const allowed = new Set([...req(l), ...normSet(l.ignoredHeaders)]);
    return names.size > req(l).size && [...names].every((n) => allowed.has(n));
  });
  if (closedExtras.length > 0) return closedExtras;
  if (opts.allowArbitraryExtras === false) return [];
  return all.filter((l) => l.allowExtraColumns && hasAllRequired(l));
}

/** Sentence appended to a refusal when the file's header is a registered provider layout. */
function layoutSuggestion(matches: readonly ProviderLayout[]): string {
  if (matches.length === 0) return '';
  const names = matches.map((l) => `"${l.label}"`).join(' or ');
  return ` This file's columns match the registered provider layout ${names}: choose the file shape "Supported provider export" and the layout ${names} instead.`;
}

/**
 * The closest registered layout(s) to a header that matches none, with exactly how it differs.
 * Only for the refusal message: a near miss is NEVER accepted on the strength of being close.
 */
export function nearestLayouts(header: readonly string[]): Array<{ layout: ProviderLayout; missing: string[]; unlisted: string[] }> {
  const names = header.filter((h) => normaliseHeaderName(h) !== '');
  const norm = new Set(names.map(normaliseHeaderName));
  const scored = Object.values(PROVIDER_LAYOUTS).map((layout) => {
    const req = normSet(layout.requiredHeaders);
    const allowed = new Set([...req, ...normSet(layout.ignoredHeaders)]);
    const missing = layout.requiredHeaders.filter((r) => !norm.has(normaliseHeaderName(r)));
    const unlisted = names.filter((h) => !allowed.has(normaliseHeaderName(h)));
    const hits = layout.requiredHeaders.length - missing.length;
    return { layout, missing, unlisted, hits, distance: missing.length + (layout.allowExtraColumns ? 0 : unlisted.length) };
  });
  const candidates = scored.filter((s) => s.hits >= 2);
  if (candidates.length === 0) return [];
  const best = Math.min(...candidates.map((s) => s.distance));
  return candidates.filter((s) => s.distance === best).map(({ layout, missing, unlisted }) => ({ layout, missing, unlisted }));
}

function nearMissSentence(header: readonly string[]): string {
  const near = nearestLayouts(header);
  if (near.length === 0) return '';
  const parts = near.map((n) => {
    const diffs: string[] = [];
    if (n.missing.length > 0) diffs.push(`missing ${n.missing.join(', ')}`);
    if (n.unlisted.length > 0 && !n.layout.allowExtraColumns) diffs.push(`not listed by that layout: ${n.unlisted.join(', ')}`);
    return `"${n.layout.label}" (${diffs.join('; ') || 'no difference found'})`;
  });
  return ` The nearest registered layout is ${parts.join(' or ')}; a header that is not an exact match is never accepted.`;
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
        // The header is not the plain shape. If it is EXACTLY a registered provider layout (the
        // required set, or the required set plus only the columns that layout lists as ignorable),
        // it is recognised by that exact header, whatever shape was selected. A near miss is not.
        const matches = matchRegisteredLayouts(header, { allowArbitraryExtras: false });
        const base = `The column "${h.slice(0, 40)}" is not part of the ${required.join(',')} layout.`;
        if (matches.length > 1) {
          return fail(
            'LAYOUT_AMBIGUOUS',
            `The header matches more than one registered layout (${matches.map((l) => `"${l.label}"`).join(' and ')}); choose the file shape "Supported provider export" and pick one explicitly.`,
            matches.map((l) => l.id),
          );
        }
        if (matches.length === 1) {
          const layout = matches[0];
          if (params.shape === 'multi' && !(layout.indexNameColumn && params.indexNameToKey && Object.keys(params.indexNameToKey).length > 0)) {
            return fail(
              'RECOGNISED_LAYOUT_NEEDS_BENCHMARK',
              `This file is the registered layout "${layout.label}", which holds one index and does not say which benchmark it is. Choose the file shape "Single benchmark" (or "Supported provider export") and pick the benchmark.`,
              [layout.id],
            );
          }
          const resolved = resolveLayout(header, { ...params, shape: 'provider_export', providerLayoutId: layout.id, columnMap: undefined });
          if (resolved.ok) {
            resolved.layout.matchedBy = 'header';
            resolved.notes.unshift(`Recognised file layout: ${layout.label} (matched by its exact header).`);
          }
          return resolved;
        }
        const near = nearMissSentence(header);
        return fail(
          'UNEXPECTED_COLUMN',
          near ? `${base}${near}` : `${base} Remove it, or use a provider export with an explicit column mapping.`,
          near ? nearestLayouts(header).map((n) => n.layout.id) : undefined,
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
        matchedBy: 'fixed',
      },
      mapping: {
        dateColumn: byNorm.get('date') as string,
        valueColumn: byNorm.get('value') as string,
        keyColumn: params.shape === 'multi' ? byNorm.get('benchmark_key') : undefined,
      },
      notes,
      ignoredColumns: [],
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
  let matchedBy: ResolvedLayout['matchedBy'] = 'chosen';
  if (params.providerLayoutId) {
    layout = Object.prototype.hasOwnProperty.call(PROVIDER_LAYOUTS, params.providerLayoutId)
      ? PROVIDER_LAYOUTS[params.providerLayoutId]
      : undefined;
    if (!layout) return fail('LAYOUT_UNKNOWN_ID', `"${params.providerLayoutId.slice(0, 40)}" is not a registered provider layout.`);
    // If the header is really ANOTHER registered layout, say so (the operator still chooses).
    const otherMatches = matchRegisteredLayouts(header).filter((l) => l.id !== layout!.id);
    const missing = layout.requiredHeaders.filter((r) => !byNorm.has(normaliseHeaderName(r)));
    if (missing.length > 0) {
      return fail(
        'LAYOUT_HEADER_MISMATCH',
        `The header does not match "${layout.label}"; missing columns: ${missing.join(', ')}.${layoutSuggestion(otherMatches)}`,
        [layout.id, ...otherMatches.map((l) => l.id)],
      );
    }
    if (!layout.allowExtraColumns) {
      const allowedExtra = normSet(layout.ignoredHeaders);
      const extra = header.filter(
        (h) =>
          normaliseHeaderName(h) !== '' &&
          !layout!.requiredHeaders.some((r) => normaliseHeaderName(r) === normaliseHeaderName(h)) &&
          !allowedExtra.has(normaliseHeaderName(h)),
      );
      if (extra.length > 0) {
        return fail(
          'LAYOUT_HEADER_MISMATCH',
          `The header has columns that "${layout.label}" does not list: ${extra.join(', ')}.${layoutSuggestion(otherMatches)}`,
          [layout.id, ...otherMatches.map((l) => l.id)],
        );
      }
    }
  } else {
    // Auto-recognise (exact header set first, then the layout's closed list of known ignorable
    // columns, then layouts that expect arbitrary extras). One shared function.
    const names = new Set(byNorm.keys());
    const reqNorm = (l: ProviderLayout) => l.requiredHeaders.map(normaliseHeaderName);
    const matches = matchRegisteredLayouts(header);
    if (matches.length === 1) layout = matches[0];
    else if (matches.length > 1) {
      return fail('LAYOUT_AMBIGUOUS', 'The header matches more than one registered layout; choose one explicitly.', matches.map((m) => m.id));
    } else {
      const scored = Object.values(PROVIDER_LAYOUTS)
        .map((l) => ({ id: l.id, hits: reqNorm(l).filter((x) => names.has(x)).length }))
        .sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
      return fail(
        'LAYOUT_UNRECOGNISED',
        `The header matches no registered provider layout. Pick a layout, or supply an explicit column mapping; columns are never guessed.${nearMissSentence(header)}`,
        scored.slice(0, 3).map((s) => s.id),
      );
    }
    matchedBy = 'header';
    notes.push(`Recognised file layout: ${layout.label} (matched by its exact header).`);
  }

  const conflict = checkVariant(layout.variantHint, params, layout.label);
  if (conflict) return conflict;

  const used = new Set(layout.requiredHeaders.map(normaliseHeaderName));
  const ignored = header.filter((h) => normaliseHeaderName(h) !== '' && !used.has(normaliseHeaderName(h)));
  const unused = layout.requiredHeaders.filter((r) => r !== layout!.dateColumn && r !== layout!.valueColumn && r !== layout!.indexNameColumn);
  if (unused.length > 0) notes.push(`Columns present but not used as data: ${unused.join(', ')}.`);
  if (ignored.length > 0) notes.push(`Ignored extra columns: ${ignored.join(', ')}.`);
  if (params.dateFormat !== undefined && params.dateFormat !== layout.defaultDateFormat) {
    notes.push(`The layout usually uses date format ${layout.defaultDateFormat}; you selected ${params.dateFormat}.`);
  }
  // A layout verified against a real download is verified only for THAT full header: a file that
  // carries fewer of its known columns is a subset, which has not been compared with anything real.
  const partialOfVerified = !layout.unverified && (layout.ignoredHeaders ?? []).some((h) => !byNorm.has(normaliseHeaderName(h)));
  if (partialOfVerified) {
    notes.push('UNVERIFIED: this header carries only some of the columns of the real download this layout was checked against.');
  } else notes.push(layout.note);
  const mapping: ResolvedMapping = {
    dateColumn: byNorm.get(normaliseHeaderName(layout.dateColumn)) as string,
    valueColumn: byNorm.get(normaliseHeaderName(layout.valueColumn)) as string,
    indexNameColumn: layout.indexNameColumn ? byNorm.get(normaliseHeaderName(layout.indexNameColumn)) : undefined,
  };
  return {
    ok: true,
    layout: {
      id: layout.id,
      label: layout.label,
      shape: 'provider_export',
      variantHint: layout.variantHint,
      defaultDateFormat: layout.defaultDateFormat,
      unverified: layout.unverified || partialOfVerified,
      matchedBy,
    },
    mapping,
    notes,
    ignoredColumns: unmappedColumns(header, mapping),
  };
}

/** Every non-empty header column that is not read as date, value, key or index name: never loaded, and listed as such. */
function unmappedColumns(header: readonly string[], mapping: ResolvedMapping): string[] {
  const read = new Set([mapping.dateColumn, mapping.valueColumn, mapping.keyColumn, mapping.indexNameColumn].filter((x): x is string => !!x));
  return header.filter((h) => normaliseHeaderName(h) !== '' && !read.has(h));
}

function resolveExplicit(
  map: ColumnMap,
  byNorm: Map<string, string>,
  header: string[],
  params: UploadParams,
): LayoutResolution {
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
  const mapping: ResolvedMapping = {
    dateColumn: resolved.date as string,
    valueColumn: resolved.value as string,
    keyColumn: resolved.benchmarkKey,
    indexNameColumn: resolved.indexName,
  };
  return {
    ok: true,
    layout: {
      id: 'explicit_column_map',
      label: 'Explicit operator column mapping',
      shape: 'provider_export',
      variantHint: null,
      defaultDateFormat: null,
      unverified: false,
      matchedBy: 'column_map',
    },
    mapping,
    notes: ['Columns were mapped explicitly by the operator; columns not listed in the mapping are ignored.'],
    ignoredColumns: unmappedColumns(header, mapping),
  };
}
