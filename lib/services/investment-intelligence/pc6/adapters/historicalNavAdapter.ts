// PC6/NAV 1.14 — provider-neutral historical NAV adapter contract.
//
// A historical source (TIGZIG today, mfnav as a possible fallback, AMFI's
// own NAVHistoryReport as the existing daily/backfill path) is asked for a
// bounded window of one scheme's observations and returns NORMALIZED
// CANDIDATE data plus its own provenance. It never writes to the database
// and never decides canonical promotion — that is referenceImportRunner.ts's
// job (existing `planImport`/quality-status machinery), which this contract
// deliberately does not duplicate. This mirrors the workbook's own
// requirement: "Provider adapters return normalized candidate data;
// canonical promotion follows validation."
//
// Every implementation must be honest about what it does NOT know: an
// adapter that cannot determine whether it returned the FULL requested
// window (vs. a truncated/partial one) must say so via `coverage`, not
// silently claim completeness.

export interface HistoricalNavRequest {
  /** AMFI scheme code, ISIN, or whatever identifier the adapter's provider accepts. */
  schemeIdentifier: string;
  /** ISO yyyy-mm-dd, inclusive. */
  fromDate: string;
  /** ISO yyyy-mm-dd, inclusive. */
  toDate: string;
}

export interface HistoricalNavObservation {
  /** ISO yyyy-mm-dd. */
  date: string;
  /** Decimal string, never a float, to avoid silent precision loss before validation. */
  nav: string;
}

export type CoverageStatus =
  | 'complete'          // adapter is confident it returned every published date in [fromDate, toDate]
  | 'partial'           // adapter knows some dates in the window are missing from its response
  | 'unknown';          // adapter cannot determine completeness (treat conservatively downstream)

export interface HistoricalNavResult {
  ok: true;
  schemeIdentifier: string;
  /** Provider's own resolved scheme label, when it returns one — for identity cross-checking, never for display. */
  providerSchemeName: string | null;
  observations: HistoricalNavObservation[];
  coverage: CoverageStatus;
  provider: {
    key: string;
    adapterVersion: string;
    requestUrl: string;
    httpStatus: number;
    retrievedAt: string;
    /** Bounded reference to the raw response for audit, per the workbook's "Source evidence" record — never the full body if large. */
    rawResponseChecksum: string;
  };
}

export interface HistoricalNavFailure {
  ok: false;
  schemeIdentifier: string;
  kind: 'network' | 'http_error' | 'not_found' | 'rate_limited' | 'schema_unexpected' | 'disabled';
  detail: string;
  provider: {
    key: string;
    adapterVersion: string;
    requestUrl: string | null;
    httpStatus: number | null;
    retrievedAt: string;
  };
}

export type HistoricalNavAdapterResult = HistoricalNavResult | HistoricalNavFailure;

export interface HistoricalNavAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;
  fetchHistory(request: HistoricalNavRequest): Promise<HistoricalNavAdapterResult>;
}
