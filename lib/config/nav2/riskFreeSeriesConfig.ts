// NAV2 -- the governed RISK-FREE series configuration (PO decision 2026-10-03):
//
//   PRIMARY   : RBI 91-day Treasury bill auction cut-off yield (weekly auction).
//   SECONDARY : RBI policy repo rate (the alternative series; selectable here).
//
// Series ids and the cadence words match the PO's first-load CSV files
// (RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv, RBI_POLICY_REPO_RATE_HISTORY.csv: columns
// series_id, observation_date, value_percent, frequency, source_document, source_url,
// retrieved_on, notes).
//
// WHAT THIS FILE IS. The descriptors, the switches and the terms status. It is
// configuration, not data: NO observation is shipped in code (no rate is invented,
// copied or seeded). Observations arrive as a governed RiskFreeDataset (see
// lib/engines/nav2/riskFree.ts) loaded from storage; storage, the admin upload and the
// weekly refresh job are Stage 2.
//
// TERMS (PO decision 03-10-2026, which superseded the earlier pending-confirmation status): RBI
// publishes no explicit reuse licence (its pages say "All Rights Reserved" and its
// disclaimer restricts caching, linking and framing without written permission). The PO
// has ACCEPTED that risk and written confirmation from RBI is NOT required. That is
// recorded as `termsReviewStatus = 'po_accepted_2026-10-03'`, with the factual note
// below, so it stays visible in the dataset and in the dependency register as a
// PO-accepted risk. Attribution ("Source: Reserve Bank of India") is printed with every
// figure built on the series. `enabled` is the master switch: set it to false (or a
// dataset's own flag) and every risk-free-dependent ratio answers `risk_free_missing`
// (reason `risk_free_series_disabled`), with no number and no data deleted.
//
// INGESTION (PO decision, latest): a weekly refresh job reads the RBI press release and
// the RBI weekly NSDP page politely (Stage 2 design: docs/nav2/
// NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER.md section 5), DEFAULT OFF behind a
// kill switch in the existing ii_reference_job_control mechanism; the admin upload stays
// as the manual and correction path. Nothing in the NAV2 ENGINE ever fetches: the engine
// takes a dataset as an input.
//
// Changing anything below changes how a ratio is computed: bump
// NAV2_RISK_FREE_CONFIG_VERSION and NAV2_POLICY_VERSION together.

import { RISK_FREE_MAX_STALENESS_DAYS } from './metricPolicy';

export const NAV2_RISK_FREE_CONFIG_VERSION = 'nav2-risk-free-config-v3';

export type RiskFreeSeriesId = keyof typeof RISK_FREE_MAX_STALENESS_DAYS;

export type RiskFreeCadence = 'weekly_auction' | 'policy_change';

export interface RiskFreeSeriesDescriptor {
  id: RiskFreeSeriesId;
  name: string;
  role: 'primary' | 'secondary';
  source: 'Reserve Bank of India';
  cadence: RiskFreeCadence;
  /** What an observation is, and from when it is in force. */
  observationMeaning: string;
  /** Named constant, in days (see RISK_FREE_MAX_STALENESS_DAYS for what it is measured from). */
  maxStalenessDays: number;
  /** Where the publication is found; each stored observation also carries its own document and URL. */
  publicationNote: string;
}

export const RISK_FREE_SERIES: Record<RiskFreeSeriesId, RiskFreeSeriesDescriptor> = {
  RBI_91D_TBILL_CUTOFF_YIELD: {
    id: 'RBI_91D_TBILL_CUTOFF_YIELD',
    name: 'RBI 91-day Treasury bill auction cut-off yield',
    role: 'primary',
    source: 'Reserve Bank of India',
    cadence: 'weekly_auction',
    observationMeaning: 'The cut-off yield of the weekly 91-day Treasury bill auction, in force from the auction date until the next auction. An auction with no accepted bids has no cut-off yield and is recorded as a gap, never as a value.',
    maxStalenessDays: RISK_FREE_MAX_STALENESS_DAYS.RBI_91D_TBILL_CUTOFF_YIELD,
    publicationNote: 'RBI press release "Treasury Bills: Full Auction Result" (row III, cut-off price and yield, 91-day column), cross-checked against the RBI weekly NSDP page.',
  },
  RBI_POLICY_REPO_RATE: {
    id: 'RBI_POLICY_REPO_RATE',
    name: 'RBI policy repo rate',
    role: 'secondary',
    source: 'Reserve Bank of India',
    cadence: 'policy_change',
    observationMeaning: 'The policy repo rate from the date a Monetary Policy Committee decision took effect, in force until the next change. Only CHANGES are recorded; freshness is measured from the dataset\'s verified-through date.',
    maxStalenessDays: RISK_FREE_MAX_STALENESS_DAYS.RBI_POLICY_REPO_RATE,
    publicationNote: 'RBI Monetary Policy Statement of each meeting; the RBI weekly NSDP page shows the rate in force each week.',
  },
};

/**
 * The short label printed beside EVERY ratio built on a series (Sharpe, Sortino, alpha) and kept in its provenance. The repo rate is
 * only ever a PROXY for the risk-free rate (it is an overnight policy rate, not a Treasury bill yield) and is labelled as one; it is
 * never substituted silently for the 91-day T-bill: the series is chosen by selectedSeriesId and nothing else.
 */
export const RISK_FREE_SERIES_LABELS: Record<RiskFreeSeriesId, string> = {
  RBI_91D_TBILL_CUTOFF_YIELD: 'RBI 91-day T-bill',
  RBI_POLICY_REPO_RATE: 'RBI policy repo-rate proxy',
};

export type RiskFreeTermsStatus = 'po_accepted_2026-10-03' | 'confirmed_in_writing' | 'pending_confirmation' | 'declined';

export interface RiskFreeConfig {
  configVersion: string;
  /** Master switch. false = every risk-free-dependent ratio is `risk_free_missing` (series disabled). */
  enabled: boolean;
  /** Which series feeds Sharpe, Sortino and alpha. */
  selectedSeriesId: RiskFreeSeriesId;
  termsReviewStatus: RiskFreeTermsStatus;
  /** The terms position stated factually, so a PO-accepted risk is never mistaken for a granted licence. */
  termsNote: string;
  attributionText: 'Source: Reserve Bank of India';
  /** How data may enter. The NAV2 engine itself never fetches. */
  ingestion: 'weekly_refresh_job_and_admin_upload';
  /** The Stage 2 weekly refresh job: shipped OFF, behind a kill switch row in ii_reference_job_control. */
  weeklyRefresh: { jobKey: 'nav2_risk_free_weekly_refresh'; defaultEnabled: false; dryRunByDefault: true };
  conversion: 'compound_per_period_1_over_n';
}

export const NAV2_RISK_FREE_CONFIG: RiskFreeConfig = {
  configVersion: NAV2_RISK_FREE_CONFIG_VERSION,
  enabled: true,
  selectedSeriesId: 'RBI_91D_TBILL_CUTOFF_YIELD',
  termsReviewStatus: 'po_accepted_2026-10-03',
  termsNote:
    'RBI publishes no explicit reuse licence (its pages state "All Rights Reserved" and its disclaimer restricts caching, linking and framing without written permission). The Product Owner accepted this risk on 03-10-2026; written confirmation from RBI is not required.',
  attributionText: 'Source: Reserve Bank of India',
  ingestion: 'weekly_refresh_job_and_admin_upload',
  weeklyRefresh: { jobKey: 'nav2_risk_free_weekly_refresh', defaultEnabled: false, dryRunByDefault: true },
  conversion: 'compound_per_period_1_over_n',
};
