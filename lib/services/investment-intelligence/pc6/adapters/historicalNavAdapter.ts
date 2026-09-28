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
  /**
   * NAV 1 incident fix (2026-09-28) — an already-known-persistently-failing
   * instrument (per the caller's own attempt ledger) is asked for with a much
   * smaller retry budget than a fresh one. Found live in production: a scheme
   * neither AMFI nor TIGZIG will EVER publish (a leftover synthetic test
   * fixture, AMFI code 999999) made TIGZIG's fallback retry-with-backoff run
   * its full 6 attempts x up to 60s each, occasionally long enough that the
   * platform killed the whole hydration invocation mid-flight -- the run's
   * "running" batch was then only discovered abandoned 30 minutes later by
   * the NEXT tick's stale-batch reconciliation, and that tick's own attempt
   * was never recorded to the ledger (it never reached the `finally` that
   * writes it). An instrument that has already failed
   * HYDRATION_PERSISTENT_FAILURE_THRESHOLD+ times in a row does not need the
   * full retry budget to prove it again -- one quick, bounded check is
   * enough to notice if the provider ever starts answering, without risking
   * the whole run. Optional: an adapter that ignores these fields keeps its
   * own defaults (DEFAULT_FETCH_TIMEOUT_MS / 6 attempts), so this is purely
   * additive.
   */
  retryBudget?: { maxAttempts: number; timeoutMs: number };
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
