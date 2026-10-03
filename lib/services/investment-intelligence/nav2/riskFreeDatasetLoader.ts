// NAV2 Stage 2 -- load the governed risk-free datasets from storage (migration 0260) into the engine's
// RiskFreeDataset contract. READ ONLY. The engine never reads storage; this is the one place that does.
//
// FAIL CLOSED: a missing table (migration not applied), a failed read, or an empty series is reported as
// "no dataset" (the engine then answers risk_free_missing with its typed reason) -- never as a zero rate.
// The dataset version is a deterministic digest of everything that can change a ratio (observations, the
// verified-through date, the enabled switch and the terms status), so a pinned report can say exactly which
// dataset it used and a correction visibly changes the version.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RiskFreeDataset, RiskFreeObservation, RiskFreeSupply } from '@/lib/engines/nav2/riskFree';
import { selectRiskFreeSupply } from '@/lib/engines/nav2/riskFree';
import { NAV2_RISK_FREE_CONFIG } from '@/lib/config/nav2/riskFreeSeriesConfig';
import { fetchAllRows } from '../pagination';

export interface RiskFreeSeriesRow {
  series_id: string;
  series_name: string;
  source: string;
  attribution_text: string;
  cadence: 'weekly_auction' | 'policy_change';
  max_staleness_days: number;
  enabled: boolean;
  terms_review_status: string;
  verified_through_date: string | null;
}

export interface RiskFreeObservationRow {
  series_id: string;
  observation_date: string;
  kind: 'value' | 'gap';
  value_percent: number | string | null;
  gap_reason: 'no_accepted_bids' | 'no_auction_held' | null;
  source_document: string;
  source_url: string | null;
  retrieved_on: string;
  notes: string | null;
  entry_kind: 'first_load_csv' | 'admin_upload' | 'weekly_refresh_job';
  extraction: unknown;
}

const d10 = (s: string): string => String(s).slice(0, 10);

/** Pure. One dataset per series row; observations ascending by date. */
export function rowsToRiskFreeDatasets(series: readonly RiskFreeSeriesRow[], observations: readonly RiskFreeObservationRow[]): RiskFreeDataset[] {
  return series.map((s) => {
    const obs: RiskFreeObservation[] = observations
      .filter((o) => o.series_id === s.series_id)
      .map((o) => ({
        observationDate: d10(o.observation_date),
        yieldPercent: o.value_percent === null ? null : Number(o.value_percent),
        kind: o.kind,
        gapReason: o.gap_reason,
        sourceDocument: o.source_document,
        sourceUrl: o.source_url,
        retrievedOn: d10(o.retrieved_on),
        notes: o.notes,
        entryKind: o.entry_kind,
        extraction: (o.extraction as RiskFreeObservation['extraction']) ?? null,
      }))
      .sort((a, b) => (a.observationDate < b.observationDate ? -1 : a.observationDate > b.observationDate ? 1 : 0));
    const retrievedOn = obs.reduce((m, o) => (o.retrievedOn > m ? o.retrievedOn : m), '');
    const digest = createHash('sha256')
      .update(JSON.stringify({ id: s.series_id, enabled: s.enabled, terms: s.terms_review_status, through: s.verified_through_date, obs: obs.map((o) => [o.observationDate, o.kind, o.yieldPercent, o.gapReason]) }))
      .digest('hex')
      .slice(0, 16);
    return {
      seriesId: s.series_id,
      seriesName: s.series_name,
      source: s.source,
      attributionText: s.attribution_text,
      cadence: s.cadence,
      datasetVersion: `${s.series_id}@${digest}`,
      retrievedOn: retrievedOn || '1970-01-01',
      termsReviewStatus: s.terms_review_status as RiskFreeDataset['termsReviewStatus'],
      enabled: s.enabled,
      yieldBasis: 'annualised_percent_as_published',
      conversion: 'compound_per_period_1_over_n',
      observationSemantics: 'latest_on_or_before_never_future_never_interpolated',
      maxStalenessDays: s.max_staleness_days,
      verifiedThroughDate: s.verified_through_date ? d10(s.verified_through_date) : null,
      observations: obs,
    };
  });
}

export interface RiskFreeLoad {
  supply: RiskFreeSupply;
  datasets: RiskFreeDataset[];
  /** Plain reason when nothing could be loaded (migration not applied, read failed); null when loaded. */
  unavailableReason: string | null;
}

/** Reads both series and all their observations; returns the supply the engine should use (the selected series). */
export async function loadRiskFreeSupply(client: SupabaseClient): Promise<RiskFreeLoad> {
  try {
    const { data: series, error } = await client
      .from('ii_risk_free_series')
      .select('series_id, series_name, source, attribution_text, cadence, max_staleness_days, enabled, terms_review_status, verified_through_date');
    if (error) return { supply: null, datasets: [], unavailableReason: 'The risk-free rate data could not be read.' };
    const seriesRows = (series ?? []) as RiskFreeSeriesRow[];
    if (seriesRows.length === 0) return { supply: null, datasets: [], unavailableReason: 'No risk-free rate series is set up.' };
    const obsRows = await fetchAllRows<RiskFreeObservationRow>(() =>
      client
        .from('ii_risk_free_observations')
        .select('series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, extraction')
        .order('series_id', { ascending: true })
        .order('observation_date', { ascending: true })
    );
    const datasets = rowsToRiskFreeDatasets(seriesRows, obsRows);
    const supply = selectRiskFreeSupply(datasets, NAV2_RISK_FREE_CONFIG);
    return { supply, datasets, unavailableReason: supply ? null : 'The selected risk-free rate series has not been loaded.' };
  } catch {
    return { supply: null, datasets: [], unavailableReason: 'The risk-free rate data could not be read.' };
  }
}
