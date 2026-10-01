// BENCH-1 Phase 2 -- historical benchmark file ingest: shared types.
//
// The whole fileIngest library is PURE: no database, no network, no clock
// (the caller injects `todayIso`). Hostile input never throws; every module
// reports `Problem`s instead.

export type ReturnVariant = 'price' | 'total_return' | 'net_total_return';
export type HistoryClass = 'live' | 'backtested' | 'mixed' | 'unknown';
export type UploadShape = 'single' | 'multi' | 'provider_export';
export type UploadMode = 'new_history' | 'correction';
export type DateFormatId =
  | 'YYYY-MM-DD'
  | 'DD/MM/YYYY'
  | 'MM/DD/YYYY'
  | 'DD-MM-YYYY'
  | 'DD-MMM-YYYY'
  | 'DD MMM YYYY'
  | 'excel_1900'
  | 'excel_1904';
/**
 * plain: 12345.67 ; en: 12,345.67 ; in: 1,23,456.78 (Indian grouping, dot
 * decimal) ; eu: 12.345,67
 */
export type NumberLocaleId = 'plain' | 'en' | 'in' | 'eu';

export interface ColumnMap {
  date?: string;
  value?: string;
  benchmarkKey?: string;
  indexName?: string;
}

export interface UploadParams {
  shape: UploadShape;
  mode: UploadMode;
  /** single / single-index provider export. */
  benchmarkKey?: string;
  /** provider_export: id from the layouts registry; omit to use an explicit columnMap. */
  providerLayoutId?: string;
  /** Explicit operator mapping (never inferred silently). */
  columnMap?: ColumnMap;
  /** Multi-index provider files: exact index-name -> benchmark_key. */
  indexNameToKey?: Record<string, string>;
  returnVariant: ReturnVariant;
  currencyCode: string;
  historyClass: HistoryClass;
  dateFormat: DateFormatId;
  numberLocale: NumberLocaleId;
  /** XLSX: the sheet to process (never defaulted silently). */
  sheetName?: string;
  /** XLSX / CSV: 1-based header row, default 1. */
  headerRow?: number;
  /** Default false; hidden rows are NEVER silently ignored: they are disclosed. */
  includeHiddenRows?: boolean;
}

export interface CatalogueEntryLite {
  benchmarkKey: string;
  returnVariant: ReturnVariant;
  currencyCode: string;
  isActive: boolean;
}

export interface UploadLimits {
  maxBytes: number;
  maxRows: number;
  maxZipEntries: number;
  maxZipUncompressedBytes: number;
  maxZipEntryBytes: number;
  maxZipRatio: number;
  maxXmlBytes: number;
}

export interface ValidationContext {
  /** YYYY-MM-DD, "now" in the caller; future dates are relative to this. */
  todayIso: string;
  /** By benchmark_key. */
  catalogue: ReadonlyMap<string, CatalogueEntryLite>;
  /** benchmarkKey -> (date -> existing level), for the incoming date range. */
  existing: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Data-date scope of the entitlement, if any. */
  entitlementDateScope?: { from?: string; to?: string } | null;
  limits?: Partial<UploadLimits>;
}

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS: UploadLimits = Object.freeze({
  maxBytes: 5 * MIB,
  maxRows: 20_000,
  maxZipEntries: 200,
  maxZipUncompressedBytes: 50 * MIB,
  maxZipEntryBytes: 25 * MIB,
  maxZipRatio: 100,
  maxXmlBytes: 25 * MIB,
});

export function resolveLimits(partial?: Partial<UploadLimits> | null): UploadLimits {
  return { ...DEFAULT_LIMITS, ...(partial ?? {}) };
}

/** A machine-readable problem. `rowNumber` is set when the problem is tied to a source row. */
export interface Problem {
  code: string;
  message: string;
  rowNumber?: number;
}
