// Factsheet source registry: the host allow-list, the seed list, and the two gates a fetch must pass
// BEFORE any network request is made. PURE: no I/O.
//
// GATE 1: the URL's host must be on the allow-list (the official fund-house domains confirmed in the
//         2026-10-03 six-funds research, plus AMFI's own SID host).
// GATE 2: the source's terms review must be 'approved'. 'not_reviewed' (the default), 'under_review' and
//         'declined' all REFUSE. This is how the pipeline stays off until the fund-house terms question
//         (counsel / PO review) is settled. A named negative control proves it.
//
// The seed list mirrors the INSERT in migration 0252 and a test compares the two, so they cannot drift.
// Every seeded row is 'not_reviewed'. No URL was fetched to produce this list: each is copied from the
// research file, which read each document once by hand.

import type { DocumentScope, FactsheetDocumentType, FactsheetSource, TermsReviewStatus } from './types';

/** Official domains only. A host matches when it equals a suffix or is a subdomain of it. */
export const FACTSHEET_ALLOWED_HOST_SUFFIXES: readonly string[] = ['hdfcfund.com', 'sbimf.com', 'mf.nipponindiaim.com', 'icicipruamc.com', 'portal.amfiindia.com'];

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return FACTSHEET_ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export type SourceGate = { allowed: true } | { allowed: false; reason: 'host_not_allowed' | 'terms_not_approved' | 'source_disabled'; detail: string };

/** The ONE gate every fetch passes through. Order matters: a disabled or unapproved source is refused before anything else. */
export function gateSourceFetch(source: Pick<FactsheetSource, 'url' | 'termsReviewStatus' | 'enabled' | 'sourceKey'>, resolvedUrl: string = source.url): SourceGate {
  if (!source.enabled) return { allowed: false, reason: 'source_disabled', detail: `${source.sourceKey}: the source is disabled.` };
  if (source.termsReviewStatus !== 'approved') {
    return { allowed: false, reason: 'terms_not_approved', detail: `${source.sourceKey}: the fund house's terms of use have not been approved for automated reading (status: ${source.termsReviewStatus}). Nothing was fetched.` };
  }
  if (!isAllowedHost(hostOf(resolvedUrl))) return { allowed: false, reason: 'host_not_allowed', detail: `${source.sourceKey}: the document's host is not on the official-domain allow-list.` };
  return { allowed: true };
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Resolve a monthly template for a calendar month ({YYYY}, {MM}, {MONTH} lower-case name). A fixed URL is returned unchanged. */
export function resolveSourceUrl(source: Pick<FactsheetSource, 'urlKind' | 'url'>, runMonth: string): string {
  if (source.urlKind === 'fixed') return source.url;
  const y = runMonth.slice(0, 4);
  const m = runMonth.slice(5, 7);
  return source.url.replace(/\{YYYY\}/g, y).replace(/\{MM\}/g, m).replace(/\{MONTH\}/g, MONTH_NAMES[Number(m) - 1] ?? m);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export interface FactsheetSourceSeed {
  sourceKey: string;
  amcKey: string;
  amcName: string;
  documentType: FactsheetDocumentType;
  url: string;
  amfiSchemeCodes: readonly string[];
  documentSchemeName: string;
  documentScope: DocumentScope;
  priority: number;
  termsReviewStatus: TermsReviewStatus;
  note: string;
}

/**
 * The registered documents. AMFI codes are the six research funds' codes as recorded in the repository's own
 * held-scheme evidence (docs/investment-intelligence/bench1_phase2/HELD_SCHEMES_BENCHMARK_WORKSHEET_2026-10-03.md).
 *
 * NOT SEEDED, ON PURPOSE:
 *   * No AMFI-hosted SID (portal.amfiindia.com/spages/<n>.pdf): the two such PDFs read in research
 *     (13662, 14110) do not belong to any held scheme, and an unverified number must never be invented.
 *     The host is allow-listed so a verified row can be added later.
 *   * No monthly URL template: SBI's monthly factsheet URL carries a per-file "sfvrsn" token that cannot be
 *     predicted, so a template would be a guess.
 */
export const FACTSHEET_SOURCE_SEED: readonly FactsheetSourceSeed[] = [
  {
    sourceKey: 'hdfc_baf_fund_facts_2026_03',
    amcKey: 'hdfc',
    amcName: 'HDFC Mutual Fund',
    documentType: 'amc_factsheet',
    url: 'https://files.hdfcfund.com/s3fs-public/Others/2026-03/Fund%20Facts%20-%20HDFC%20Balanced%20Advantage%20Fund_March%2026.pdf',
    amfiSchemeCodes: ['100119'],
    documentSchemeName: 'HDFC Balanced Advantage Fund',
    documentScope: 'single_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'Fund Facts, March 2026 (research: benchmark line NIFTY 50 Hybrid Composite Debt 50:50 TRI).',
  },
  {
    sourceKey: 'hdfc_baf_sid_2024_06',
    amcKey: 'hdfc',
    amcName: 'HDFC Mutual Fund',
    documentType: 'amc_sid',
    url: 'https://files.hdfcfund.com/s3fs-public/SID/2024-06/SID%20-%20HDFC%20Balanced%20Advantage%20Fund%20dated%20June%2028,%202024.pdf',
    amfiSchemeCodes: ['100119'],
    documentSchemeName: 'HDFC Balanced Advantage Fund',
    documentScope: 'single_scheme',
    priority: 50,
    termsReviewStatus: 'not_reviewed',
    note: 'SID dated 28 June 2024. Older than the Fund Facts above, so it can never supersede it.',
  },
  {
    sourceKey: 'hdfc_gold_fof_sid_2025_11',
    amcKey: 'hdfc',
    amcName: 'HDFC Mutual Fund',
    documentType: 'amc_sid',
    url: 'https://files.hdfcfund.com/s3fs-public/SID/2025-11/SID%20-%20HDFC%20Gold%20ETF%20Fund%20of%20Fund%20dated%20November%2021,%202025.pdf',
    amfiSchemeCodes: ['115934'],
    documentSchemeName: 'HDFC Gold ETF Fund of Fund',
    documentScope: 'single_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'SID dated 21 November 2025. Benchmark is a commodity price: recorded as unsupported, never published.',
  },
  {
    sourceKey: 'sbi_multi_asset_factsheet_2026_04',
    amcKey: 'sbi',
    amcName: 'SBI Mutual Fund',
    documentType: 'amc_factsheet',
    url: 'https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-multi-asset-allocation-fund-factsheet-april-2026.pdf?sfvrsn=829ed1fb_2',
    amfiSchemeCodes: ['103408'],
    documentSchemeName: 'SBI Multi Asset Allocation Fund',
    documentScope: 'single_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'Factsheet, report as on 30 April 2026. Four-leg composite with a stated effective date: recorded as unsupported composite, never published.',
  },
  {
    sourceKey: 'sbi_contra_factsheet_2025_08',
    amcKey: 'sbi',
    amcName: 'SBI Mutual Fund',
    documentType: 'amc_factsheet',
    url: 'https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-contra-fund-factsheet-august-2025.pdf?sfvrsn=6d2d8066_2',
    amfiSchemeCodes: ['102414'],
    documentSchemeName: 'SBI Contra Fund',
    documentScope: 'single_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'Factsheet, report as on 31 August 2025 (research: First Tier Benchmark BSE 500 TRI).',
  },
  {
    sourceKey: 'sbi_contra_sid_2025_10',
    amcKey: 'sbi',
    amcName: 'SBI Mutual Fund',
    documentType: 'amc_sid',
    url: 'https://www.sbimf.com/docs/default-source/sif-forms/sid---sbi-contra-fund.pdf?sfvrsn=4a20c1ae_0',
    amfiSchemeCodes: ['102414'],
    documentSchemeName: 'SBI Contra Fund',
    documentScope: 'single_scheme',
    priority: 50,
    termsReviewStatus: 'not_reviewed',
    note: 'SID dated 31 October 2025.',
  },
  {
    sourceKey: 'nippon_power_infra_presentation',
    amcKey: 'nippon',
    amcName: 'Nippon India Mutual Fund',
    documentType: 'other',
    url: 'https://mf.nipponindiaim.com/FundsAndPerformance/Presentation/NipponIndia-Power-Infra-Fund-Presentation.pdf',
    amfiSchemeCodes: ['101262'],
    documentSchemeName: 'Nippon India Power & Infra Fund',
    documentScope: 'single_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'Fund presentation (research read a copy with data as on 30 July 2021). Document type is "other", so it can never auto-publish: a human decides.',
  },
  {
    sourceKey: 'icici_dividend_yield_complete_factsheet',
    amcKey: 'icici',
    amcName: 'ICICI Prudential Mutual Fund',
    documentType: 'amc_factsheet',
    url: 'https://www.icicipruamc.com/blob/knowledgecentre/factsheet-complete/Complete.pdf',
    amfiSchemeCodes: ['129310'],
    documentSchemeName: 'ICICI Prudential Dividend Yield Equity Fund',
    documentScope: 'multi_scheme',
    priority: 10,
    termsReviewStatus: 'not_reviewed',
    note: 'Complete factsheet. Research found these PDFs exceed 10 MB, so this row is EXPECTED to end as "document too large" (skipped, not truncated); it is registered so the gap is visible, not hidden.',
  },
];

export function sourceFromSeed(seed: FactsheetSourceSeed, id: string): FactsheetSource {
  return {
    id,
    sourceKey: seed.sourceKey,
    amcKey: seed.amcKey,
    amcName: seed.amcName,
    documentType: seed.documentType,
    urlKind: 'fixed',
    url: seed.url,
    host: hostOf(seed.url) ?? '',
    amfiSchemeCodes: seed.amfiSchemeCodes,
    documentSchemeName: seed.documentSchemeName,
    documentScope: seed.documentScope,
    priority: seed.priority,
    enabled: true,
    termsReviewStatus: seed.termsReviewStatus,
    lastEtag: null,
    lastModified: null,
    lastChecksum: null,
    lastFetchedAt: null,
  };
}
