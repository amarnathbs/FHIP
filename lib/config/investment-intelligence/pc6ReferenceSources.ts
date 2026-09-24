// PC6 (M6) — reference-market-data source registry.
//
// N.4 requires that the source URL and type live in CONFIGURATION, not in
// "hard-coded scattered strings". Every PC6 importer resolves its endpoint
// through this module and nowhere else; a grep for `amfiindia` outside this
// file (and the docs) should return nothing.
//
// BOUNDARY (N.1/N.2, D.1, D.7). Everything in here is EXTERNAL REFERENCE
// data. None of it is a user document, none of it flows through AIE, and
// none of it may ever overwrite a NAV/unit/value printed on a user's own
// statement. A PC6 row is a separate, independently-dated fact that sits
// BESIDE the statement fact.

export type ReferenceSourceKind =
  | 'scheme_master'
  | 'daily_nav'
  | 'nav_history'
  | 'benchmark_level'
  | 'risk_free_rate';

export type ReferenceSourceFormat = 'amfi_navall_txt' | 'amfi_navhistory_txt' | 'csv' | 'json' | 'manual_admin_entry';

/**
 * How confident we are that this source may LEGALLY be ingested and stored.
 *
 * `public_open`      — published by the issuing body for open public use.
 * `licence_required` — the data exists and is technically reachable, but the
 *                      publisher licenses it; ingesting it needs a commercial
 *                      agreement. PC6 must NOT ingest these on its own
 *                      authority. This is an honest blocked state, not a
 *                      reason to substitute a guess.
 * `po_decision_required` — more than one defensible source/methodology exists
 *                      and the choice is a Product Owner call (N.10).
 */
export type ReferenceSourceLicence = 'public_open' | 'licence_required' | 'po_decision_required';

export interface ReferenceSourceDefinition {
  /** Stable key. Also the `ii_sources.source_key` this source ingests under. */
  sourceKey: string;
  label: string;
  kind: ReferenceSourceKind;
  format: ReferenceSourceFormat;
  countryCode: string;
  currencyCode: string;
  /**
   * Endpoint. `urlTemplate` may contain `{frmdt}` / `{todt}` placeholders in
   * AMFI's own `dd-MMM-yyyy` form; `buildUrl()` is the only sanctioned way to
   * fill them.
   */
  urlTemplate: string | null;
  /** Documentation/terms page a human can check before relying on the feed. */
  termsUrl: string | null;
  licence: ReferenceSourceLicence;
  /** Expected publication cadence, used by staleness detection (N.5/N.11). */
  cadence: 'daily_business' | 'daily' | 'monthly' | 'irregular' | 'unknown';
  /**
   * How many days may elapse with no new as-of date before the series is
   * reported STALE on the admin surface. Business-daily Indian feeds get 4 to
   * absorb a Thu–Sun / festival run without false alarms.
   */
  staleAfterDays: number;
  /** false = the importer must refuse to run and say why. */
  enabled: boolean;
  notes: string;
}

/**
 * AMFI publishes the daily NAV of every SEBI-registered Indian mutual-fund
 * scheme as a plain semicolon-delimited text file at a stable public URL,
 * for open public consumption. This is the authoritative Indian
 * mutual-fund NAV and scheme-identity source, and it is the source PC6's
 * scheme master and NAV history are built from.
 *
 * NOTE ON HOST. `www.amfiindia.com` was not reachable from the build
 * environment on 2026-09-15 (connection refused at the IP layer);
 * `portal.amfiindia.com` — AMFI's own portal host, serving byte-identical
 * paths — was. The portal host is therefore the configured endpoint, with
 * the www host retained below as documentation of the canonical address.
 */
export const AMFI_CANONICAL_HOST = 'https://www.amfiindia.com';

export const PC6_REFERENCE_SOURCES: Record<string, ReferenceSourceDefinition> = {
  amfi_nav_daily: {
    sourceKey: 'amfi',
    label: 'AMFI — daily NAV of all schemes (NAVAll.txt)',
    kind: 'daily_nav',
    format: 'amfi_navall_txt',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: 'https://portal.amfiindia.com/spages/NAVAll.txt',
    termsUrl: 'https://www.amfiindia.com/nav-history-download',
    licence: 'public_open',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'One row per scheme with the LATEST NAV that scheme has published — not necessarily today. ' +
      'A dormant/wound-up scheme keeps its final NAV here for years, so per-scheme staleness must be ' +
      'judged from the row date, never from the file date.',
    enabled: true,
  },

  amfi_nav_history: {
    sourceKey: 'amfi',
    label: 'AMFI — NAV history report for a date window',
    kind: 'nav_history',
    format: 'amfi_navhistory_txt',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt={frmdt}&todt={todt}',
    termsUrl: 'https://www.amfiindia.com/nav-history-download',
    licence: 'public_open',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'Backfill endpoint (N.4 "support backfill windows"). DIFFERENT column order from NAVAll.txt — ' +
      'Scheme Code;NAV Name;Plan;Option;ISIN Growth;ISIN Reinvestment;NAV;Date — so it needs its own ' +
      'parser, not a reused one. Responses are large (~3.5 MB for a 3-day window across ~26k rows); ' +
      'keep windows bounded.',
    enabled: true,
  },

  amfi_scheme_master: {
    sourceKey: 'amfi',
    label: 'AMFI — scheme identity derived from NAVAll.txt section structure',
    kind: 'scheme_master',
    format: 'amfi_navall_txt',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: 'https://portal.amfiindia.com/spages/NAVAll.txt',
    termsUrl: 'https://www.amfiindia.com/nav-history-download',
    licence: 'public_open',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'AMFI does not publish a separate scheme-master file. NAVAll.txt IS the scheme master: its ' +
      'section headers carry scheme structure (Open Ended / Close Ended / Interval) and ' +
      'category/subcategory, its AMC sub-headers carry the AMC, and each data row carries the AMFI ' +
      'scheme code, both ISINs, plan and option. Fields AMFI does not publish here — inception date, ' +
      'closure date, merger date — stay NULL rather than being inferred.',
    enabled: true,
  },

  // ---------------------------------------------------------------------------
  // NAV 1 selective-historical candidate sources (governance registration
  // only — see lib/services/investment-intelligence/pc6/adapters/ for the
  // actual fetch implementations, which use their own JSON contract rather
  // than this registry's AMFI-text urlTemplate/buildUrl() machinery).
  // `enabled: false` here means "not yet qualified for the FHIP production
  // runtime network path" (NAV 1.18), NOT "no technical path exists" — do
  // not conflate this with the licence_required BLOCKED sources below.
  // ---------------------------------------------------------------------------
  tigzig_nav_history: {
    sourceKey: 'tigzig',
    label: 'TIGZIG — AMFI-derived mutual fund NAV history API',
    kind: 'nav_history',
    format: 'json',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: null, // see tigzigHistoricalAdapter.ts; not built through buildUrl()
    termsUrl: 'https://www.tigzig.com/terms',
    licence: 'public_open',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'Pilot selective-historical source (NAV 1.15). Re-qualified live 2026-09-21 from this session\'s ' +
      'own sandbox (NOT the FHIP production runtime network path): GET https://api.tigzig.com/mf/v1/nav ' +
      '?scheme=119551&since=2026-09-14&to=2026-09-18 returned HTTP 200 with 4 real observations, ' +
      'consistent with the workbook\'s own prior-recorded result. TIGZIG\'s own documentation explicitly ' +
      'disclaims authority ("not affiliated with, endorsed by, or sponsored by AMFI"), so its output is ' +
      'never promoted to canonical without AMFI cross-validation. enabled=false until NAV 1.18 repeats ' +
      'this request from the deployed FHIP runtime itself. ' +
      'APPROVED AS FALLBACK ONLY by the PO on 2026-09-24 (NAV 1 Stage D, D.3): AMFI is the primary ' +
      'historical source; TIGZIG is consulted only when AMFI fails -- chiefly for a scheme AMFI no ' +
      'longer publishes. Rows it supplies are stamped with provider key "tigzig" in data_version so ' +
      'they stay identifiable. Setting enabled back to false makes the adapter refuse (kind "disabled") ' +
      'before any network call.',
    enabled: true,
  },

  mfnav_fallback_history: {
    sourceKey: 'mfnav',
    label: 'mfnav.in — possible fallback mutual fund NAV history API',
    kind: 'nav_history',
    format: 'json',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: null,
    termsUrl: 'https://mfnav.in/terms',
    licence: 'public_open',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'Unqualified fallback (NAV 1.16). The workbook\'s own prior review recorded HTTP 403 from a ' +
      'research environment; this session did not independently re-test it (no adapter built — building ' +
      'one against an already-known-403 endpoint without a fresh access result would misrepresent ' +
      'qualification status). Do not call this operational until a genuine 200 response is observed from ' +
      'the actual FHIP network path per the workbook\'s own instruction ("test the real FHIP network path ' +
      'without bypassing access controls").',
    enabled: false,
  },

  // ---------------------------------------------------------------------------
  // BLOCKED SOURCES — registered so the gap is visible and governed, NOT so a
  // substitute can be quietly slotted in. See N.7-N.10 in the certification.
  // ---------------------------------------------------------------------------
  nse_index_tri: {
    sourceKey: 'nse_indices',
    label: 'NSE Indices Ltd — NIFTY index levels (TRI and PRI)',
    kind: 'benchmark_level',
    format: 'json',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: null,
    termsUrl: 'https://www.niftyindices.com/terms-of-use',
    licence: 'licence_required',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes:
      'BLOCKER PO-PC6-1. NIFTY index values are the property of NSE Indices Limited and are licensed, ' +
      'not open data. The legacy unauthenticated `Backpage.aspx/getTotalReturnIndexString` endpoint was ' +
      're-probed on 2026-09-15 and no longer returns data (it serves the HTML site shell), so there is ' +
      'not even a technical path, let alone a licensed one. PC6 therefore ships the full benchmark ' +
      'master/mapping/history MACHINERY but ingests no real Indian index level. Filling the blank with ' +
      'a guessed NIFTY series is explicitly forbidden by N.8.',
    enabled: false,
  },

  bse_index: {
    sourceKey: 'bse_indices',
    label: 'BSE — SENSEX and related index levels',
    kind: 'benchmark_level',
    format: 'json',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: null,
    termsUrl: 'https://www.bseindia.com/static/about/terms_of_usage.html',
    licence: 'licence_required',
    cadence: 'daily_business',
    staleAfterDays: 4,
    notes: 'BLOCKER PO-PC6-1 (same class as NSE). Index values are licensed by BSE Ltd / Asia Index.',
    enabled: false,
  },

  india_risk_free: {
    sourceKey: 'rbi',
    label: 'India risk-free rate — source and tenor NOT YET CHOSEN',
    kind: 'risk_free_rate',
    format: 'manual_admin_entry',
    countryCode: 'IN',
    currencyCode: 'INR',
    urlTemplate: null,
    termsUrl: 'https://data.rbi.org.in/',
    licence: 'po_decision_required',
    cadence: 'monthly',
    staleAfterDays: 45,
    notes:
      'BLOCKER PO-PC6-2. N.10 forbids silently choosing a proxy. At least three defensible candidates ' +
      'exist and they give materially different Sharpe/Sortino numbers: (a) RBI 91-day Treasury Bill ' +
      'auction cut-off yield, (b) the 10-year benchmark G-Sec yield, (c) the RBI policy repo rate. ' +
      'The existing 16 DEV rows in ii_risk_free_rates are self-labelled "DEV SEED - approximate ... ' +
      '(not a certified feed)" and must not be promoted to production on their own authority. PC6 ships ' +
      'the versioned series shape, the effective-dating and the methodology-record requirement, and ' +
      'leaves the source choice to the Product Owner.',
    enabled: false,
  },
};

export function getReferenceSource(id: string): ReferenceSourceDefinition {
  const def = PC6_REFERENCE_SOURCES[id];
  if (!def) throw new Error(`PC6: unknown reference source '${id}'`);
  return def;
}

/** AMFI's own date spelling, e.g. 11-Sep-2026. Deterministic, UTC, no locale. */
const AMFI_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function toAmfiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`PC6: expected an ISO yyyy-mm-dd date, got '${iso}'`);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`PC6: invalid month in '${iso}'`);
  return `${m[3]}-${AMFI_MONTHS[monthIndex]}-${m[1]}`;
}

export interface BuildUrlWindow {
  /** ISO yyyy-mm-dd, inclusive. */
  fromDate?: string;
  /** ISO yyyy-mm-dd, inclusive. */
  toDate?: string;
}

/**
 * The ONLY sanctioned way to turn a source definition into a request URL.
 * Refuses a disabled source outright so a blocked feed cannot be fetched by
 * accident, and refuses a window whose placeholders are unfilled.
 */
export function buildUrl(id: string, window: BuildUrlWindow = {}): string {
  const def = getReferenceSource(id);
  if (!def.enabled) {
    throw new Error(
      `PC6: source '${id}' is disabled (licence=${def.licence}) and must not be fetched. ${def.notes}`
    );
  }
  if (!def.urlTemplate) throw new Error(`PC6: source '${id}' has no endpoint configured`);
  let url = def.urlTemplate;
  if (url.includes('{frmdt}')) {
    if (!window.fromDate) throw new Error(`PC6: source '${id}' needs a fromDate`);
    url = url.replace('{frmdt}', toAmfiDate(window.fromDate));
  }
  if (url.includes('{todt}')) {
    if (!window.toDate) throw new Error(`PC6: source '${id}' needs a toDate`);
    url = url.replace('{todt}', toAmfiDate(window.toDate));
  }
  return url;
}

/** Every source the Product Owner still has to unblock, for the admin surface. */
export function blockedSources(): ReferenceSourceDefinition[] {
  return Object.values(PC6_REFERENCE_SOURCES).filter((s) => !s.enabled);
}
