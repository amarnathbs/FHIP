// Planning Benchmarks staged upload - the orchestration the API routes call (server-side).
//
// Everything runs under the CALLER'S OWN session client: the database RPCs authorise with auth.uid() and the
// capability themselves, so a caller who bypasses the route is refused identically. The service-role client
// is not imported here (a static test enforces it). The raw uploaded file is never stored: only its SHA-256,
// size, name and the validated, normalised rows.
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SheetInfo } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { readUploadFile, validateUploadTable, type UploadIssue } from './uploadValidate';
import { TEMPLATE_VERSION, UPLOAD_LIMITS, type UploadKind } from './uploadSchema';

export interface StageInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  kind: UploadKind;
  sheetName?: string;
  includeHiddenRows?: boolean;
  todayIso: string;
}

export type StageOutcome =
  | { status: 'rejected'; stage: 'inspection' | 'validation'; problems: Array<{ code: string; message: string }>; issues: UploadIssue[]; errorCount: number; warningCount: number; issuesTruncated: boolean; fileSha256: string }
  | { status: 'needs_sheet'; sheets: SheetInfo[]; problems: Array<{ code: string; message: string }>; fileSha256: string }
  | { status: 'staged' | 'already_staged'; batchId: string; counts: Record<string, number> | null; warnings: UploadIssue[]; warningCount: number; fileSha256: string };

export function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export class UploadDependencyError extends Error {}

export async function stagePlanningBenchmarkUpload(supabase: SupabaseClient, input: StageInput): Promise<StageOutcome> {
  const fileSha256 = sha256Bytes(input.bytes);
  const read = readUploadFile({ fileName: input.fileName, declaredMime: input.declaredMime, bytes: input.bytes, sheetName: input.sheetName, includeHiddenRows: input.includeHiddenRows });
  if (!read.ok) {
    if (read.stage === 'sheet') return { status: 'needs_sheet', sheets: read.sheets ?? [], problems: read.problems, fileSha256 };
    return { status: 'rejected', stage: 'inspection', problems: read.problems, issues: [], errorCount: read.problems.length, warningCount: 0, issuesTruncated: false, fileSha256 };
  }

  const { data: metrics, error: mErr } = await supabase.from('benchmark_metric_definitions').select('metric_code, unit').limit(2000);
  if (mErr || !metrics) throw new UploadDependencyError('metric definitions could not be read');
  const metricUnits = new Map<string, string>((metrics as Array<{ metric_code: string; unit: string }>).map((m) => [m.metric_code, m.unit]));

  const v = validateUploadTable(read.table, input.kind, { todayIso: input.todayIso, metricUnits });
  if (v.errorCount > 0) {
    const shown = v.issues.slice(0, UPLOAD_LIMITS.maxIssuesReturned);
    return { status: 'rejected', stage: 'validation', problems: [], issues: shown, errorCount: v.errorCount, warningCount: v.warningCount, issuesTruncated: v.issues.length > shown.length, fileSha256 };
  }

  const payload = {
    kind: input.kind,
    dataset_name: v.datasetName,
    dataset_version: v.datasetVersion,
    file_name: input.fileName.slice(0, 255),
    file_sha256: fileSha256,
    file_bytes: input.bytes.length,
    template_version: TEMPLATE_VERSION[input.kind],
    rows: v.rows,
  };
  const { data, error } = await supabase.rpc('stage_planning_benchmark_upload', { p: payload });
  if (error) throw new RpcFailure(error);
  const out = data as { status: 'staged' | 'already_staged'; batch_id: string; counts?: Record<string, number> };
  if (!out || typeof out.batch_id !== 'string' || (out.status !== 'staged' && out.status !== 'already_staged')) throw new UploadDependencyError('unexpected stage reply');
  return {
    status: out.status,
    batchId: out.batch_id,
    counts: out.counts ?? null,
    warnings: v.issues.filter((i) => i.severity === 'warning').slice(0, UPLOAD_LIMITS.maxIssuesReturned),
    warningCount: v.warningCount,
    fileSha256,
  };
}

export class RpcFailure extends Error {
  constructor(public readonly error: { code?: string; message?: string }) {
    super(error.message ?? 'rpc failed');
  }
}

// ------------------------------------------------------------------------ RPC error mapping ---

const PREFIX = /^PB_E_([A-Z_]+):\s*([\s\S]*)$/;

/**
 * Maps a database error to an HTTP status and a SAFE message. Messages the migration raises start with
 * PB_E_<CODE> and are curated sentences (they never carry engine text), so they are forwarded without the
 * prefix. Anything else is replaced by a generic sentence: raw database text never reaches the client.
 */
export function mapRpcError(error: { code?: string; message?: string } | null | undefined): { status: number; code: string; message: string } {
  const raw = error?.message ?? '';
  const m = PREFIX.exec(raw);
  if (m) {
    const text = m[2].trim();
    const message = text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
    const table: Record<string, [number, string]> = {
      DENIED: [403, 'FORBIDDEN'],
      SELF: [403, 'SELF_ACTIVATION_NOT_ACKNOWLEDGED'],
      NOT_FOUND: [404, 'NOT_FOUND'],
      DUPLICATE: [409, 'DUPLICATE'],
      STATE: [409, 'CONFLICT'],
      EXPIRED: [409, 'EXPIRED'],
      STALE: [409, 'STALE'],
      BINDING: [422, 'BINDING_MISMATCH'],
      INPUT: [422, 'VALIDATION_FAILED'],
      ROWS: [422, 'VALIDATION_FAILED'],
      DATASET: [422, 'VALIDATION_FAILED'],
      CONFLICT: [422, 'ROW_CONFLICT'],
      NOT_READY: [422, 'DATASET_NOT_READY'],
    };
    const [status, code] = table[m[1]] ?? [422, 'VALIDATION_FAILED'];
    return { status, code, message };
  }
  const code = error?.code ?? '';
  if (code === '42501') return { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to do this.' };
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01' || code === '42703' || /does not exist|schema cache|Could not find the function/i.test(raw)) {
    return { status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'The planning benchmark upload feature is not installed on this database yet. Nothing was changed.' };
  }
  if (code.startsWith('08') || code === '57014' || code === '55000') return { status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'This service is temporarily unavailable. Nothing was changed. Please try again shortly.' };
  if (code === '23505') return { status: 409, code: 'CONFLICT', message: 'This already exists or conflicts with an existing record.' };
  if (code === '23503' || code === '23502' || code === '23514' || code === '22P02' || code === '22023' || code === '22007' || code === '22008') {
    return { status: 422, code: 'VALIDATION_FAILED', message: 'The submitted data is invalid. Nothing was changed.' };
  }
  console.error('planning benchmark upload - unexpected database error:', error);
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Nothing was changed. Please try again.' };
}

export function rpcFailureResponse(err: { code?: string; message?: string } | null | undefined): Response {
  const f = mapRpcError(err);
  return Response.json({ error: f.message, code: f.code }, { status: f.status });
}

// -------------------------------------------------------------------------------- other RPCs ---

export async function getPlanningBenchmarkUpload(supabase: SupabaseClient, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('get_planning_benchmark_upload', { p_batch: id });
  if (error) throw new RpcFailure(error);
  if (!data || typeof data !== 'object' || !('batch' in (data as object))) throw new UploadDependencyError('unexpected get reply');
  return data as Record<string, unknown>;
}

export interface ActivateInput {
  expectedSha256: string;
  expectedDigest: string;
  expectedCounts: Record<string, number>;
  selfActivationAck: boolean;
}

export async function activatePlanningBenchmarkUpload(supabase: SupabaseClient, id: string, input: ActivateInput): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('activate_planning_benchmark_upload', {
    p_batch: id,
    p: { expected_sha256: input.expectedSha256, expected_digest: input.expectedDigest, expected_counts: input.expectedCounts, self_activation_ack: input.selfActivationAck },
  });
  if (error) throw new RpcFailure(error);
  const out = data as { status?: string } | null;
  if (!out || (out.status !== 'activated' && out.status !== 'already_activated')) throw new UploadDependencyError('unexpected activate reply');
  return out as Record<string, unknown>;
}

export async function discardPlanningBenchmarkUpload(supabase: SupabaseClient, id: string, reason: string | null): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('discard_planning_benchmark_upload', { p_batch: id, p_reason: reason });
  if (error) throw new RpcFailure(error);
  const out = data as { status?: string } | null;
  if (!out || (out.status !== 'discarded' && out.status !== 'already_discarded')) throw new UploadDependencyError('unexpected discard reply');
  return out as Record<string, unknown>;
}
