// PC7 (M7) — underlying-fund-holdings disclosure source registry.
//
// O.3 requires that PC7's ingestion run against APPROVED sources and that the
// investigation of what is genuinely, legally accessible be done for real
// rather than assumed. This module is the single place any PC7 importer may
// learn an endpoint from — the same rule PC6 set for `pc6ReferenceSources.ts`.
//
// TERMINOLOGY (O.2). Everything registered here supplies **Underlying Fund
// Holdings** — the constituent securities held INSIDE a mutual-fund scheme.
// That is a different thing from a user's own fund position, which lives in
// the investment register and is never touched by anything in this module.
//
// BOUNDARY (O.3, D.1, D.7). Every source here is EXTERNAL REFERENCE data
// published by an AMC or a regulator about its own scheme. None of it is a
// user document. Nothing registered here may be routed through the AIE user
// acceptance lifecycle, and no PC7 importer may write to a user-owned table.
// PC7 is authoritative for reference-data quality and publication; AIE is
// authoritative for user-document intake. They are separate pipelines that
// happen to share low-level extraction utilities, and that sharing must never
// become a shared lifecycle.

export type DisclosureSourceKind =
  | 'amc_monthly_portfolio'
  | 'amc_fortnightly_portfolio'
  | 'aggregator_constituents'
  | 'admin_manual_entry';

/**
 * The FILE SHAPE, named honestly.
 *
 * O.3 warns against assuming PDF. The investigation recorded in the PC7
 * certification found that SEBI's monthly portfolio-disclosure mandate is met
 * by AMCs with SPREADSHEET files in a prescribed column layout far more often
 * than with narrative PDFs, so `sebi_monthly_portfolio_xls` is the primary
 * format and the PDF path is a fallback, not the default.
 */
export type DisclosureSourceFormat =
  | 'sebi_monthly_portfolio_xls'
  | 'sebi_monthly_portfolio_csv'
  | 'sebi_monthly_portfolio_pdf'
  | 'vendor_api_json'
  | 'manual_admin_entry';

/**
 * Same three-valued licence model PC6 established, for the same reason: a
 * source that is technically reachable but commercially licensed is a BLOCKED
 * state to be surfaced, never a reason to substitute a guess.
 */
export type DisclosureSourceLicence = 'public_open' | 'licence_required' | 'po_decision_required';

export interface DisclosureSourceDefinition {
  /** Stable key. Also the `ii_sources.source_key` this source ingests under. */
  sourceKey: string;
  label: string;
  kind: DisclosureSourceKind;
  format: DisclosureSourceFormat;
  countryCode: string;
  currencyCode: string;
  /** The AMC this source covers, or null for a multi-AMC/aggregator source. */
  amcName: string | null;
  /**
   * Landing page a human (or an operator-approved fetcher) uses to locate the
   * current period's file. DELIBERATELY NOT a direct file URL: Indian AMC
   * disclosure files are published at per-month paths that change shape
   * without notice, and hard-coding one produces an importer that silently
   * fetches last year's file forever.
   */
  landingUrl: string | null;
  /** Direct file template, only where the publisher genuinely offers a stable one. */
  urlTemplate: string | null;
  termsUrl: string | null;
  licence: DisclosureSourceLicence;
  cadence: 'monthly' | 'fortnightly' | 'irregular' | 'unknown';
  /**
   * Days after a disclosure's as-of date before the snapshot is reported STALE
   * on the PC7 admin surface (O.9). SEBI's own publication deadline is the
   * floor here: a file is not late until the publisher was obliged to have
   * produced it.
   */
  staleAfterDays: number;
  /** false = the importer must refuse to run and say why. */
  enabled: boolean;
  notes: string;
}

/**
 * SEBI's own published format document — the authority for what an Indian
 * monthly/half-yearly portfolio disclosure is supposed to look like.
 *
 * Recorded as the termsUrl of the AMC entries because there is no single
 * licence page covering ~57 AMCs: what exists is a regulator-published
 * OBLIGATION, and the per-AMC terms that govern consuming it must be captured
 * per AMC when each one is added.
 */
export const SEBI_MASTER_CIRCULAR_FORMATS_URL =
  'https://www.sebi.gov.in/sebi_data/commondocs/may-2023/Formats%20for%20Master%20Circular%20for%20Mutual%20Funds%20as%20on%20March%2031,%202023_p.pdf';

/**
 * AMFI publishes NAV, AUM and scheme identity — and, verified on 2026-09-15,
 * NO constituent-level holdings dataset. There is no AMFI equivalent of
 * NAVAll.txt for look-through data. Recorded as a named constant so that a
 * future reader looking for "the AMFI holdings feed" finds the answer instead
 * of assuming one exists and hunting for it.
 */
export const AMFI_PUBLISHES_NO_CONSTITUENT_DATASET = true as const;

/**
 * THE REGISTRY.
 *
 * Every entry ships `enabled: false`. That is not an oversight and not a
 * placeholder — it is the honest state at the end of M7:
 *
 *   * PC7 builds the whole ingestion, analytics, quality and safety machinery
 *     and proves it against real files' structure.
 *   * Whether FHIP may ingest and STORE a given AMC's portfolio disclosure is
 *     a licensing/terms question with a real answer per publisher, and that
 *     answer is a Product Owner decision, not an engineering one.
 *   * The binding execution override in this mission forbids activating any
 *     real ingestion schedule without a human present.
 *
 * Enabling an entry is therefore a deliberate, recorded operator act.
 */
export const PC7_DISCLOSURE_SOURCES: Record<string, DisclosureSourceDefinition> = {
  amc_monthly_portfolio_generic: {
    sourceKey: 'amc_portfolio_disclosure',
    label: 'AMC monthly portfolio disclosure (SEBI Master Circular ch.5 cl.5.1.1)',
    kind: 'amc_monthly_portfolio',
    format: 'sebi_monthly_portfolio_xls',
    countryCode: 'IN',
    currencyCode: 'INR',
    amcName: null,
    landingUrl: null,
    urlTemplate: null,
    termsUrl: SEBI_MASTER_CIRCULAR_FORMATS_URL,
    licence: 'po_decision_required',
    cadence: 'monthly',
    // SEBI requires monthly portfolio disclosure within 10 days of month end.
    // 45 days allows one full missed cycle to be visibly late rather than
    // instantly alarming on a publisher running a few days behind, and it
    // matches the certified X-Ray engine's CURRENT_MAX so the operator surface
    // and the user surface cannot disagree about what "stale" means.
    staleAfterDays: 45,
    notes:
      'BLOCKER PO-PC7-1 (LICENSING, not technical). SEBI Master Circular for Mutual Funds ' +
      'SEBI/HO/IMD/IMD-PoD-1/P/CIR/2024/90 (27 Jun 2024), Chapter 5 clause 5.1.1, obliges every AMC to ' +
      'publish each scheme\'s month-end portfolio WITH ISIN, in downloadable spreadsheet form, within 10 ' +
      'days, on its own site and on AMFI\'s. The obligation is real and the files are real. What is NOT ' +
      'settled is whether FHIP may programmatically RETRIEVE, STORE and REPUBLISH them — a public ' +
      'disclosure duty on the PUBLISHER is not a redistribution licence for a CONSUMER, and the two are ' +
      'routinely confused. Verified on 2026-09-15: AMFI\'s own Terms of Use licence the site "for your ' +
      'personal and non-commercial use only" and state "You shall not store electronically any ' +
      'significant portion of any part of the Site"; at least one large AMC (Nippon India MF) separately ' +
      'prohibits "aggregating, copying or duplicating in any manner any of the content"; SBI MF\'s ' +
      'robots.txt disallows the very query-string URLs its .xlsx files are served from; one major AMC ' +
      '(HDFC MF) edge-blocks non-browser clients outright. The posture is per-AMC and inconsistent across ' +
      'roughly 57 AMCs. Per-AMC entries must be added here, each with its own termsUrl and its own ' +
      'recorded Product Owner sign-off, before anything is ingested.',
    enabled: false,
  },

  amc_fortnightly_debt_portfolio: {
    sourceKey: 'amc_portfolio_disclosure',
    label: 'AMC fortnightly DEBT-scheme portfolio disclosure (SEBI cl.5.1.1)',
    kind: 'amc_fortnightly_portfolio',
    format: 'sebi_monthly_portfolio_xls',
    countryCode: 'IN',
    currencyCode: 'INR',
    amcName: null,
    landingUrl: null,
    urlTemplate: null,
    termsUrl: SEBI_MASTER_CIRCULAR_FORMATS_URL,
    licence: 'po_decision_required',
    // Registered SEPARATELY from the monthly entry rather than folded into it,
    // because the cadence difference is not cosmetic: judging a debt scheme's
    // freshness on the monthly threshold would call a two-week-late fortnightly
    // file "current", which is precisely the flattering-staleness error O.8
    // forbids.
    cadence: 'fortnightly',
    // Fortnightly within 5 days (circular SEBI/HO/IMD/DF3/CIR/P/2020/130,
    // effective 1 Oct 2020). 21 days allows one missed fortnight to show as
    // late without alarming on a publisher a few days behind.
    staleAfterDays: 21,
    notes:
      'BLOCKER PO-PC7-1, same licensing question as the monthly entry. Recorded separately because SEBI ' +
      'requires DEBT schemes to disclose FORTNIGHTLY within 5 days of each fortnight, and to state the ' +
      'yield of each instrument — so a debt scheme has a materially tighter freshness expectation and ' +
      'richer per-line data (YTM, rating) than an equity scheme.',
    enabled: false,
  },

  vendor_constituents: {
    sourceKey: 'vendor_portfolio_data',
    label: 'Commercial vendor — Indian MF portfolio constituents',
    kind: 'aggregator_constituents',
    format: 'vendor_api_json',
    countryCode: 'IN',
    currencyCode: 'INR',
    amcName: null,
    landingUrl: null,
    urlTemplate: null,
    termsUrl: null,
    licence: 'licence_required',
    cadence: 'monthly',
    staleAfterDays: 45,
    notes:
      'BLOCKER PO-PC7-2. Aggregated, normalised Indian MF constituent data is a PAID product. No vendor ' +
      'is CONFIGURED here, because configuring one would imply a commercial relationship that does not ' +
      'exist. The real candidates identified on 2026-09-15 are recorded in the PC7 certification for the ' +
      'Product Owner to choose from: ICRA Analytics (MFI Explorer / MFI360), Accord Fintech (ACE MF Nxt, ' +
      'ACE Datafeed), LSEG Lipper Fund Holdings, Morningstar Direct / Licensed Data, and CRISIL ' +
      'Intelligence. All require a paid licence. A licensed feed is the only path with clean ' +
      'redistribution rights, and PC7 must not sign a data licence on its own authority.',
    enabled: false,
  },

  admin_manual_disclosure: {
    sourceKey: 'admin_correction',
    label: 'Operator-entered portfolio disclosure (single scheme, audited)',
    kind: 'admin_manual_entry',
    format: 'manual_admin_entry',
    countryCode: 'IN',
    currencyCode: 'INR',
    amcName: null,
    landingUrl: null,
    urlTemplate: null,
    termsUrl: null,
    licence: 'po_decision_required',
    cadence: 'irregular',
    staleAfterDays: 45,
    notes:
      'The escape hatch for a single scheme an operator has a legitimate copy of. Still disabled by ' +
      'default: a manual path that is always open becomes the path everything takes, and PC7 would ' +
      'then have an unaudited back door into reference data that the whole write-restriction posture ' +
      'exists to prevent. Enabling it is an operator act, and every row it produces is attributed to ' +
      "the 'admin_correction' source so it is distinguishable from a publisher file forever.",
    enabled: false,
  },
};

export function getDisclosureSource(id: string): DisclosureSourceDefinition {
  const def = PC7_DISCLOSURE_SOURCES[id];
  if (!def) throw new Error(`PC7: unknown disclosure source '${id}'`);
  return def;
}

/**
 * The ONLY sanctioned way to turn a source definition into a request URL.
 *
 * Refuses a disabled source outright, and refuses a source with no stable
 * template rather than inventing one. Both refusals are the point: PC7's
 * failure mode must be "did not run, and said why", never "ran against
 * something plausible".
 */
export function buildDisclosureUrl(id: string, period: { asOfDate?: string } = {}): string {
  const def = getDisclosureSource(id);
  if (!def.enabled) {
    throw new Error(
      `PC7: disclosure source '${id}' is disabled (licence=${def.licence}) and must not be fetched. ${def.notes}`
    );
  }
  if (!def.urlTemplate) {
    throw new Error(
      `PC7: disclosure source '${id}' has no stable file endpoint. Indian AMC portfolio files are published ` +
        `at per-period paths; an operator must supply the period's file rather than PC7 guessing a URL.`
    );
  }
  let url = def.urlTemplate;
  if (url.includes('{asOfDate}')) {
    if (!period.asOfDate) throw new Error(`PC7: disclosure source '${id}' needs an asOfDate`);
    url = url.replace('{asOfDate}', period.asOfDate);
  }
  return url;
}

/** Every source the Product Owner still has to unblock, for the admin surface (O.9). */
export function blockedDisclosureSources(): DisclosureSourceDefinition[] {
  return Object.values(PC7_DISCLOSURE_SOURCES).filter((s) => !s.enabled);
}

/** True when ANY disclosure source is enabled. False is PC7's shipped state. */
export function anyDisclosureSourceEnabled(): boolean {
  return Object.values(PC7_DISCLOSURE_SOURCES).some((s) => s.enabled);
}
