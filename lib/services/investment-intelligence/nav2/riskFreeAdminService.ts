// NAV2 Stage 2 -- the Risk-free Rate Data admin surface: the status read model and the validated POST bodies.
//
// ADMIN STANDARD, stated for this surface:
//   Section 2  two named capabilities (upload / switch), see riskFreeAdmin.ts. A panel the caller's capabilities do not
//              cover is reported as `not_permitted`, never as an empty list.
//   Section 7  no user data is read or shown here at all (global reference data), so there is no cohort to suppress; the
//              monitoring panel that DOES count user holdings is a separate surface with its own capability and the
//              database function's own suppression (nav2_monitoring_snapshot, migration 0262).
//   Section 8  every panel is `ok` or `unavailable` (with the reason): a missing table (0260 not applied) is "unavailable",
//              never a healthy empty dashboard; a never-loaded series is `no_data`, not "fresh" and not a zero.
//   Section 9  another admin's identifier is never returned (uploadedByMe / actedByMe only).
//   Section 13 a read error is unavailable/500, never a fabricated success.

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bad } from '@/lib/api';
import { safeDbError } from '@/lib/services/adminAuth';
import { riskFreeFreshness, type RiskFreeFreshness } from '@/lib/engines/nav2/riskFree';
import { NAV2_JOB_KEYS } from './nav2Flags';
import { type RiskFreeCapabilityFlags } from './riskFreeAdmin';
import { loadRiskFreeSupply } from './riskFreeDatasetLoader';
import { RISK_FREE_CSV_MAX_BYTES } from './riskFreeCsv';
import { RISK_FREE_ATTESTATION_TEXT } from './riskFreeUploadService';

export const UNAVAILABLE_0260 = 'Migration 0260 has not been applied to this database, so the risk-free tables do not exist yet. This is reported as unavailable rather than as an empty healthy state.';

export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || /does not exist|schema cache/i.test(error.message ?? '')));
}

/** A database-function failure as an HTTP response: the function's own authorisation refusal (42501) is an explicit 403; anything else goes through safeDbError (no internal message leaks). */
export function rpcFailure(error: { code?: string; message?: string }, context: string): Response {
  if (error.code === '42501') return bad('You do not have access to this action.', 403);
  // The function does not exist yet: the code was deployed before the migration that creates it (deploy-order guard).
  if (error.code === 'PGRST202' || error.code === '42883') return bad(`This action needs a database update that has not been applied yet (${context}). Ask the person who runs the database steps to apply migration 0294.`, 503);
  return safeDbError(error, context);
}

type Panel<T> = { state: 'ok'; data: T } | { state: 'unavailable'; reason: string } | { state: 'not_permitted' };

export interface SeriesStatus {
  seriesId: string;
  name: string;
  role: string;
  cadence: string;
  enabled: boolean;
  termsReviewStatus: string;
  observationCount: number;
  gapRowCount: number;
  firstObservationDate: string | null;
  freshness: RiskFreeFreshness;
  datasetVersion: string;
  attributionText: string;
}

export interface RiskFreeAdminStatus {
  state: 'ok' | 'unavailable';
  reason?: string;
  asOfDate: string;
  capabilities: RiskFreeCapabilityFlags;
  attestationText: string;
  limits: { maxBytes: number };
  series?: SeriesStatus[];
  weeklyRefresh?: { jobEnabled: boolean; disabledReason: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; consecutiveFailures: number };
  recentBatches: Panel<Array<Record<string, unknown>>>;
  openReviewItems: Panel<Array<Record<string, unknown>>>;
  recentCorrections: Panel<Array<Record<string, unknown>>>;
  stateLog: Panel<Array<Record<string, unknown>>>;
}

/** `client` MUST be the caller's own session client: RLS then enforces the capability a second time. */
export async function buildRiskFreeAdminStatus(client: SupabaseClient, userId: string, flags: RiskFreeCapabilityFlags, todayIso: string): Promise<RiskFreeAdminStatus> {
  const base = { asOfDate: todayIso, capabilities: flags, attestationText: RISK_FREE_ATTESTATION_TEXT, limits: { maxBytes: RISK_FREE_CSV_MAX_BYTES } };
  const notPermitted: Panel<never> = { state: 'not_permitted' };

  const loaded = await loadRiskFreeSupply(client);
  if (loaded.datasets.length === 0 && loaded.unavailableReason) {
    // Distinguish "table missing" from "registry empty" by probing the registry once.
    const { error } = await client.from('ii_risk_free_series').select('series_id').limit(1);
    return { ...base, state: 'unavailable', reason: error && isMissingRelation(error) ? UNAVAILABLE_0260 : loaded.unavailableReason, recentBatches: notPermitted, openReviewItems: notPermitted, recentCorrections: notPermitted, stateLog: notPermitted };
  }

  const { data: seriesMeta } = await client.from('ii_risk_free_series').select('series_id, role');
  const roleBy = new Map(((seriesMeta ?? []) as Array<{ series_id: string; role: string }>).map((r) => [r.series_id, r.role]));
  const series: SeriesStatus[] = loaded.datasets.map((ds) => ({
    seriesId: ds.seriesId,
    name: ds.seriesName,
    role: roleBy.get(ds.seriesId) ?? 'unknown',
    cadence: ds.cadence,
    enabled: ds.enabled,
    termsReviewStatus: ds.termsReviewStatus,
    observationCount: ds.observations.filter((o) => o.kind !== 'gap').length,
    gapRowCount: ds.observations.filter((o) => o.kind === 'gap').length,
    firstObservationDate: ds.observations.length ? ds.observations[0].observationDate : null,
    freshness: riskFreeFreshness(ds, todayIso),
    datasetVersion: ds.datasetVersion,
    attributionText: ds.attributionText,
  }));

  const { data: job } = await client.from('ii_reference_job_control').select('enabled, disabled_reason, last_success_at, last_failure_at, consecutive_failures').eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh).maybeSingle();
  const j = job as { enabled?: boolean; disabled_reason?: string | null; last_success_at?: string | null; last_failure_at?: string | null; consecutive_failures?: number } | null;

  async function panel(build: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>, map: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): Promise<Panel<Array<Record<string, unknown>>>> {
    const { data, error } = await build();
    if (error) return { state: 'unavailable', reason: isMissingRelation(error) ? UNAVAILABLE_0260 : 'This panel could not be read.' };
    return { state: 'ok', data: map((data ?? []) as Array<Record<string, unknown>>) };
  }

  const recentBatches: Panel<Array<Record<string, unknown>>> = flags.upload
    ? await panel(
        () => client.from('ii_risk_free_batches').select('id, series_id, source_kind, file_name, file_sha256, rows_submitted, rows_inserted, rows_identical_skipped, rows_review_queued, date_from, date_to, uploader_user_id, attested, created_at').order('created_at', { ascending: false }).limit(30),
        (rows) => rows.map(({ uploader_user_id, ...rest }) => ({ ...rest, uploadedByMe: uploader_user_id === userId }))
      )
    : notPermitted;
  const openReviewItems: Panel<Array<Record<string, unknown>>> = flags.upload
    ? await panel(() => client.from('ii_risk_free_review_items').select('id, series_id, observation_date, reasons, candidate, evidence, created_at').eq('status', 'open').order('created_at', { ascending: true }).limit(100), (rows) => rows)
    : notPermitted;
  const recentCorrections: Panel<Array<Record<string, unknown>>> = flags.upload
    ? await panel(
        () => client.from('ii_risk_free_corrections').select('id, series_id, observation_date, previous_value_percent, new_value_percent, reason, actor_user_id, created_at').order('created_at', { ascending: false }).limit(30),
        (rows) => rows.map(({ actor_user_id, ...rest }) => ({ ...rest, actedByMe: actor_user_id === userId }))
      )
    : notPermitted;
  const stateLog: Panel<Array<Record<string, unknown>>> = await panel(
    () => client.from('ii_risk_free_series_state_log').select('id, series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id, created_at').order('created_at', { ascending: false }).limit(30),
    (rows) => rows.map(({ actor_user_id, ...rest }) => ({ ...rest, actedByMe: actor_user_id === userId }))
  );

  return {
    ...base,
    state: 'ok',
    series,
    weeklyRefresh: { jobEnabled: j?.enabled === true, disabledReason: j?.disabled_reason ?? null, lastSuccessAt: j?.last_success_at ?? null, lastFailureAt: j?.last_failure_at ?? null, consecutiveFailures: j?.consecutive_failures ?? 0 },
    recentBatches,
    openReviewItems,
    recentCorrections,
    stateLog,
  };
}

// ---------------------------------------------------------------------------
// Validated bodies
// ---------------------------------------------------------------------------
const SERIES_ID = z.enum(['RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE']);
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.');

export const uploadBodySchema = z
  .object({
    action: z.enum(['preview', 'commit']),
    seriesId: SERIES_ID,
    fileName: z.string().trim().min(1).max(255).default('upload.csv'),
    csvText: z.string().min(1).max(RISK_FREE_CSV_MAX_BYTES * 2),
    verifiedThrough: z.union([ISO_DATE, z.literal('')]).nullable().optional(),
    firstLoad: z.boolean().optional(),
    attested: z.boolean().optional(),
    attestationText: z.string().max(1000).optional(),
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

export const reviewBodySchema = z.object({ decision: z.enum(['accept', 'reject']), note: z.string().trim().min(20, 'A note of at least 20 characters is required.').max(500) }).strict();

export const correctionBodySchema = z
  .object({ seriesId: SERIES_ID, date: ISO_DATE, newValue: z.number().min(0).max(100), reason: z.string().trim().min(20, 'A reason of at least 20 characters is required.').max(500) })
  .strict();

/** The dedicated confirmation: the repo rate is still current through a date (migration 0294). */
export const confirmCurrentBodySchema = z
  .object({ seriesId: SERIES_ID, throughDate: ISO_DATE, reason: z.string().trim().min(20, 'A reason of at least 20 characters is required.').max(500) })
  .strict();

export const seriesStateBodySchema = z
  .object({
    seriesId: SERIES_ID,
    enabled: z.boolean(),
    termsStatus: z.enum(['po_accepted_2026-10-03', 'confirmed_in_writing', 'pending_confirmation', 'declined']),
    reason: z.string().trim().min(20, 'A reason of at least 20 characters is required.').max(500),
  })
  .strict();
