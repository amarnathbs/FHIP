// NAV2 Stage 2 -- risk-free data upload: PREVIEW then COMMIT, stateless (the same pattern as the market-index upload).
//
//   plan   = parse + validate + compare with what is already published; writes NOTHING.
//   commit = re-runs the SAME analysis on the SAME file text (the client re-submits it; the hash must match the previewed
//            one) and then makes ONE call to the database function commit_risk_free_upload() under the CALLER'S OWN session
//            client, so the function's own auth.uid() / capability check is the authority (a service client would have no uid).
//
// This upload NEVER changes a published value: a date that already holds a different value blocks the whole upload (a
// published value changes only through correct_risk_free_observation(), which records who, why and the old value).
// Rejected rows block the commit as well (a governed dataset is not loaded half-way): fix the file and preview again.
// Re-committing an identical file is a no-op, both here (every row identical) and in the database (same series + file hash).
//
// Who may upload is NOT decided here: it is the capability guard (riskFreeAdmin.ts: API and page) and the database function.

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DATE_INPUT_HINT } from '@/lib/engines/dateInput';
import { fetchAllRows } from '../pagination';
import { dmy, parseRiskFreeCsv, RISK_FREE_CSV_MAX_BYTES, type RiskFreeCsvAnalysis, type RiskFreeCsvRow } from './riskFreeCsv';

export const RISK_FREE_UPLOAD_SERVICE_VERSION = 'risk-free-upload-v1';

/** The exact statement the operator attests to. Stored verbatim in the append-only batch ledger. */
export const RISK_FREE_ATTESTATION_TEXT =
  "I confirm that these values were read from the Reserve Bank of India publication named in each row and have not been altered, and that the Product Owner's decision of 03-10-2026 on RBI's terms (attribution kept, no scraping by the app) covers storing them in FHIP.";

export interface RiskFreeSeriesInfo {
  seriesId: string;
  cadence: 'weekly_auction' | 'policy_change';
}

export interface RiskFreeConflict {
  date: string;
  existing: number | null;
  incoming: number | null;
}

export interface RiskFreeUploadPlan {
  version: typeof RISK_FREE_UPLOAD_SERVICE_VERSION;
  seriesId: string;
  fileSha256: string;
  fileBytes: number;
  analysis: RiskFreeCsvAnalysis;
  newRows: RiskFreeCsvRow[];
  identicalExisting: number;
  conflicts: RiskFreeConflict[];
  /** Why a commit cannot proceed right now (empty = it can, subject to the attestation). */
  blockers: string[];
  warnings: string[];
  verifiedThrough: string | null;
}

export interface RiskFreePlanInput {
  seriesId: string;
  csvText: string;
  todayIso: string;
  /** policy_change series only: the date the series was last confirmed complete (a policy statement or a no-change check). */
  verifiedThrough?: string | null;
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function loadSeries(reader: SupabaseClient, seriesId: string): Promise<RiskFreeSeriesInfo> {
  const { data, error } = await reader.from('ii_risk_free_series').select('series_id, cadence').eq('series_id', seriesId).maybeSingle();
  if (error) throw new Error('The risk-free series registry could not be read.');
  if (!data) throw new Error('This risk-free series does not exist (migration 0260 has not been applied to this database, or the series is unknown).');
  return { seriesId: (data as { series_id: string }).series_id, cadence: (data as { cadence: 'weekly_auction' | 'policy_change' }).cadence };
}

async function loadExisting(reader: SupabaseClient, seriesId: string, from: string, to: string): Promise<Map<string, { kind: string; value: number | null }>> {
  const rows = await fetchAllRows<{ observation_date: string; kind: string; value_percent: number | string | null }>(() =>
    reader
      .from('ii_risk_free_observations')
      .select('observation_date, kind, value_percent')
      .eq('series_id', seriesId)
      .gte('observation_date', from)
      .lte('observation_date', to)
      .order('observation_date', { ascending: true })
  );
  return new Map(rows.map((r) => [String(r.observation_date).slice(0, 10), { kind: r.kind, value: r.value_percent === null ? null : Number(r.value_percent) }]));
}

export async function planRiskFreeUpload(reader: SupabaseClient, input: RiskFreePlanInput): Promise<RiskFreeUploadPlan> {
  const bytes = Buffer.byteLength(input.csvText, 'utf8');
  const fileSha256 = sha256Hex(input.csvText);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const verifiedThrough = input.verifiedThrough && input.verifiedThrough.trim() !== '' ? input.verifiedThrough.trim() : null;

  let series: RiskFreeSeriesInfo;
  try {
    series = await loadSeries(reader, input.seriesId);
  } catch (e) {
    const analysis = parseRiskFreeCsv('', input.seriesId, 'weekly_auction', input.todayIso);
    return { version: RISK_FREE_UPLOAD_SERVICE_VERSION, seriesId: input.seriesId, fileSha256, fileBytes: bytes, analysis, newRows: [], identicalExisting: 0, conflicts: [], blockers: [e instanceof Error ? e.message : 'The series could not be read.'], warnings, verifiedThrough };
  }

  if (bytes > RISK_FREE_CSV_MAX_BYTES) {
    blockers.push(`The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${RISK_FREE_CSV_MAX_BYTES / 1024 / 1024} MB.`);
    const analysis = parseRiskFreeCsv('', input.seriesId, series.cadence, input.todayIso);
    return { version: RISK_FREE_UPLOAD_SERVICE_VERSION, seriesId: input.seriesId, fileSha256, fileBytes: bytes, analysis, newRows: [], identicalExisting: 0, conflicts: [], blockers, warnings, verifiedThrough };
  }

  const analysis = parseRiskFreeCsv(input.csvText, input.seriesId, series.cadence, input.todayIso);
  if (analysis.fileRejected) blockers.push(analysis.fileRejectionReason ?? 'The file could not be used.');
  if (analysis.rejected.length > 0) blockers.push(`${analysis.rejected.length} row(s) were rejected. A governed dataset is not loaded half-way: correct the file and preview it again.`);
  warnings.push(...analysis.warnings);

  if (verifiedThrough !== null) {
    if (!ISO.test(verifiedThrough) || Number.isNaN(Date.parse(`${verifiedThrough}T00:00:00.000Z`))) blockers.push(`The "verified through" date is not a real date. ${DATE_INPUT_HINT}`);
    else if (verifiedThrough > input.todayIso) blockers.push('The "verified through" date cannot be in the future.');
    else if (analysis.dateTo && verifiedThrough < analysis.dateTo) blockers.push(`The "verified through" date (${dmy(verifiedThrough)}) cannot be earlier than the last observation in the file (${dmy(analysis.dateTo)}).`);
    else if (series.cadence === 'weekly_auction') warnings.push('"Verified through" is only used for a policy-change series; it has no effect on a weekly series.');
  } else if (series.cadence === 'policy_change') {
    warnings.push('This is a policy-change series: it supplies no rate for any date after its last observation until a "verified through" date (the day it was last confirmed complete) is recorded. Enter one, or the repo-rate series will report rates as unavailable.');
  }

  let newRows: RiskFreeCsvRow[] = [];
  let identicalExisting = 0;
  const conflicts: RiskFreeConflict[] = [];
  if (analysis.accepted.length > 0) {
    let existing: Map<string, { kind: string; value: number | null }>;
    try {
      existing = await loadExisting(reader, input.seriesId, analysis.accepted[0].date, analysis.accepted[analysis.accepted.length - 1].date);
    } catch {
      blockers.push('The values already published could not be read.');
      return { version: RISK_FREE_UPLOAD_SERVICE_VERSION, seriesId: input.seriesId, fileSha256, fileBytes: bytes, analysis, newRows: [], identicalExisting: 0, conflicts: [], blockers, warnings, verifiedThrough };
    }
    for (const row of analysis.accepted) {
      const have = existing.get(row.date);
      if (!have) newRows.push(row);
      else if (have.kind === row.kind && (have.value === row.value_percent || (have.value !== null && row.value_percent !== null && Math.abs(have.value - row.value_percent) < 1e-9))) identicalExisting += 1;
      else conflicts.push({ date: row.date, existing: have.value, incoming: row.value_percent });
    }
  }
  if (conflicts.length > 0) {
    blockers.push(`${conflicts.length} date(s) already hold a different published value (first: ${dmy(conflicts[0].date)}). An upload never changes a published value: use the correction control for a genuine correction, or remove those rows from the file.`);
  }
  if (analysis.accepted.length > 0 && newRows.length === 0 && conflicts.length === 0) warnings.push('Every row in the file is already published with the same value: committing is a no-op.');
  if (analysis.accepted.length === 0 && !analysis.fileRejected && analysis.rejected.length === 0) blockers.push('There is nothing to commit.');
  newRows = newRows.filter((r) => !conflicts.some((c) => c.date === r.date));

  return { version: RISK_FREE_UPLOAD_SERVICE_VERSION, seriesId: input.seriesId, fileSha256, fileBytes: bytes, analysis, newRows, identicalExisting, conflicts, blockers, warnings, verifiedThrough };
}

export type RiskFreeCommitOutcome =
  | { status: 'committed'; batchId: string; inserted: number; identical: number }
  | { status: 'already_committed'; batchId: string; inserted: number; identical: number }
  | { status: 'noop'; identical: number }
  | { status: 'refused'; blockers: string[] };

export interface RiskFreeCommitInput extends RiskFreePlanInput {
  fileName: string;
  attested: boolean;
  attestationText: string;
  /** The hash the operator saw in the preview; must equal the hash of the text being committed. */
  expectedSha256?: string;
  /** True for the first load of the Product Owner's historical files (recorded as the entry kind of every row). */
  firstLoad?: boolean;
}

/** `userClient` MUST be the caller's own session client (never the service-role client): the database function authorises with auth.uid(). */
export async function commitRiskFreeUpload(userClient: SupabaseClient, input: RiskFreeCommitInput): Promise<RiskFreeCommitOutcome> {
  if (input.attested !== true || input.attestationText.trim() !== RISK_FREE_ATTESTATION_TEXT) {
    return { status: 'refused', blockers: ['The attestation is required, and must be the exact statement shown.'] };
  }
  const plan = await planRiskFreeUpload(userClient, input);
  if (input.expectedSha256 && input.expectedSha256 !== plan.fileSha256) {
    return { status: 'refused', blockers: ['The file changed between the preview and the commit. Preview it again.'] };
  }
  if (plan.blockers.length > 0) return { status: 'refused', blockers: plan.blockers };
  if (plan.newRows.length === 0 && plan.verifiedThrough === null) return { status: 'noop', identical: plan.identicalExisting };

  // The database function receives the WHOLE accepted file (identical rows are skipped there and counted), so the file hash
  // recorded in the ledger is the hash of the file the operator actually committed.
  const { data, error } = await userClient.rpc('commit_risk_free_upload', {
    p_series_id: input.seriesId,
    p_file_sha256: plan.fileSha256,
    p_file_name: input.fileName,
    p_rows: plan.analysis.accepted,
    p_attested: true,
    p_attestation_text: RISK_FREE_ATTESTATION_TEXT,
    p_entry_kind: input.firstLoad === true ? 'first_load_csv' : 'admin_upload',
    p_verified_through: plan.verifiedThrough,
  });
  if (error) throw error;
  const out = data as { already_committed: boolean; batch_id: string; inserted: number; identical: number };
  return out.already_committed
    ? { status: 'already_committed', batchId: out.batch_id, inserted: out.inserted, identical: out.identical }
    : { status: 'committed', batchId: out.batch_id, inserted: out.inserted, identical: out.identical };
}
