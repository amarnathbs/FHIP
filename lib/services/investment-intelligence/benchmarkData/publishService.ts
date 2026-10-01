// BENCH-1 Phase 2 - publish / rollback / cancel of a validated import job, and
// the read side (job list, job detail, validation-error download).
//
// PUBLICATION AUTHORITY IS THE DATABASE. publish_benchmark_import() (migration
// 0239) re-authorises the caller, re-checks the checksum, the staging digest
// and the previewed counts, re-validates the entitlement (revocation / expiry
// / scope), re-classifies every staged row against the CURRENT series (stale
// preview and concurrent-import guard), serialises per benchmark and writes
// everything in ONE transaction. This module only translates the database's
// refusals into typed outcomes for the API; it never decides anything itself.
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildValidationErrorCsv, type ValidationIssue } from './fileIngest';

export interface PublishRequest {
  jobId: string;
  expectedSha256: string;
  expectedDigest: string;
  expectedCounts: { new: number; identical: number; correction: number };
  acknowledged: string[];
  /** Same admin staged and publishes: must be explicit; recorded as self_published. */
  selfPublishAck?: boolean;
}

export type RpcFailureKind = 'forbidden' | 'stale' | 'invalid' | 'duplicate' | 'wrong_state' | 'not_found' | 'unavailable';

export interface RpcFailure {
  status: 'failed';
  kind: RpcFailureKind;
  httpStatus: number;
  message: string;
  code: string | null;
}

export type PublishOutcome =
  | { status: 'published'; alreadyPublished: boolean; result: { jobId: string; batchId: string; inserted: number; revived: number; corrected: number; identicalSkipped: number; dateFrom: string; dateTo: string } }
  | RpcFailure;

/** SQLSTATE -> typed failure. Unknown codes are `unavailable` (fail closed, never a success). */
export function mapRpcError(error: { code?: string; message?: string } | null | undefined): RpcFailure {
  const code = error?.code ?? null;
  // The RPC's own exception text is an operator-facing sentence (no table/column names); anything unrecognised is replaced below.
  const message = error?.message ?? 'The database refused the operation.';
  switch (code) {
    case '42501':
      return { status: 'failed', kind: 'forbidden', httpStatus: 403, message, code };
    case '40001':
      return { status: 'failed', kind: 'stale', httpStatus: 409, message, code };
    case '23505':
      return { status: 'failed', kind: 'duplicate', httpStatus: 409, message, code };
    case '22023':
    case '23514':
      return { status: 'failed', kind: 'invalid', httpStatus: 422, message, code };
    case '55000':
      return { status: 'failed', kind: 'wrong_state', httpStatus: 409, message, code };
    case 'P0002':
      return { status: 'failed', kind: 'not_found', httpStatus: 404, message, code };
    default:
      return { status: 'failed', kind: 'unavailable', httpStatus: 503, message: 'The benchmark import service is unavailable.', code };
  }
}

export async function publishBenchmarkImport(supabase: SupabaseClient, req: PublishRequest): Promise<PublishOutcome> {
  const { data, error } = await supabase.rpc('publish_benchmark_import', {
    p_job: req.jobId,
    p: {
      expected_sha256: req.expectedSha256,
      expected_digest: req.expectedDigest,
      expected_counts: req.expectedCounts,
      acknowledged: req.acknowledged,
      self_publish_ack: req.selfPublishAck === true,
    },
  });
  if (error) {
    const failure = mapRpcError(error);
    // A stale preview is recoverable: record it on the job so the Admin list shows "stale - stage again".
    if (failure.kind === 'stale') await supabase.rpc('record_benchmark_import_failure', { p_job: req.jobId, p_code: 'STALE', p_detail: failure.message });
    return failure;
  }
  const r = data as { already_published: boolean; job_id: string; batch_id: string; inserted: number; revived: number; corrected: number; identical_skipped: number; date_from: string; date_to: string };
  return {
    status: 'published',
    alreadyPublished: r.already_published === true,
    result: { jobId: r.job_id, batchId: r.batch_id, inserted: r.inserted, revived: r.revived, corrected: r.corrected, identicalSkipped: r.identical_skipped, dateFrom: r.date_from, dateTo: r.date_to },
  };
}

export type RollbackOutcome = { status: 'rolled_back'; alreadyRolledBack: boolean; restored: number; retracted: number } | RpcFailure;

export async function rollbackBenchmarkImport(supabase: SupabaseClient, jobId: string, reason: string): Promise<RollbackOutcome> {
  const { data, error } = await supabase.rpc('rollback_benchmark_import', { p_job: jobId, p_reason: reason });
  if (error) return mapRpcError(error);
  const r = data as { already_rolled_back: boolean; restored?: number; retracted?: number };
  return { status: 'rolled_back', alreadyRolledBack: r.already_rolled_back === true, restored: r.restored ?? 0, retracted: r.retracted ?? 0 };
}

export async function cancelBenchmarkImport(supabase: SupabaseClient, jobId: string): Promise<{ status: 'cancelled' } | RpcFailure> {
  const { error } = await supabase.rpc('cancel_benchmark_import_job', { p_job: jobId });
  if (error) return mapRpcError(error);
  return { status: 'cancelled' };
}

// ---------------------------------------------------------------- read side ---

export interface ImportJobSummary {
  id: string;
  status: string;
  mode: string;
  shape: string;
  fileName: string;
  fileFormat: string;
  fileSha256: string;
  benchmarkKeys: string[];
  returnVariant: string;
  currencyCode: string;
  historyClass: string;
  rowsTotal: number;
  rowsNew: number;
  rowsIdentical: number;
  rowsCorrection: number;
  rowsRevive: number;
  hardErrorTotal: number;
  warningCount: number;
  requiredAcks: string[];
  eligible: boolean | null;
  stagedAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
  rolledBackAt: string | null;
  expiresAt: string;
  /** True only for the viewer's own jobs; another admin's identifier is never returned (Standard section 9). */
  stagedByMe: boolean;
  publishedByMe: boolean;
  selfPublished: boolean;
  duplicateOf: string | null;
  errorCode: string | null;
  sourceOwner: string;
  sourceReference: string;
  reason: string | null;
}

const JOB_COLUMNS =
  'id, status, mode, shape, file_name, file_format, file_sha256, benchmark_keys, return_variant, currency_code, history_class, rows_total, rows_new, rows_identical, rows_correction, rows_revive, hard_error_total, warning_count, required_acks, eligible, staged_at, validated_at, published_at, rolled_back_at, expires_at, staged_by, published_by, self_published, duplicate_of, error_code, source_owner, source_reference, reason';

type JobRow = Record<string, unknown>;

function toSummary(r: JobRow, userId: string): ImportJobSummary {
  return {
    id: r.id as string,
    status: r.status as string,
    mode: r.mode as string,
    shape: r.shape as string,
    fileName: r.file_name as string,
    fileFormat: r.file_format as string,
    fileSha256: r.file_sha256 as string,
    benchmarkKeys: r.benchmark_keys as string[],
    returnVariant: r.return_variant as string,
    currencyCode: String(r.currency_code).trim(),
    historyClass: r.history_class as string,
    rowsTotal: r.rows_total as number,
    rowsNew: r.rows_new as number,
    rowsIdentical: r.rows_identical as number,
    rowsCorrection: r.rows_correction as number,
    rowsRevive: r.rows_revive as number,
    hardErrorTotal: r.hard_error_total as number,
    warningCount: r.warning_count as number,
    requiredAcks: (r.required_acks as string[]) ?? [],
    eligible: (r.eligible as boolean | null) ?? null,
    stagedAt: r.staged_at as string,
    validatedAt: (r.validated_at as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
    rolledBackAt: (r.rolled_back_at as string | null) ?? null,
    expiresAt: r.expires_at as string,
    stagedByMe: r.staged_by === userId,
    publishedByMe: r.published_by === userId,
    selfPublished: r.self_published === true,
    duplicateOf: (r.duplicate_of as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    sourceOwner: r.source_owner as string,
    sourceReference: r.source_reference as string,
    reason: (r.reason as string | null) ?? null,
  };
}

export async function listImportJobs(supabase: SupabaseClient, userId: string, limit = 30): Promise<ImportJobSummary[]> {
  const { data, error } = await supabase.from('ii_benchmark_import_jobs').select(JOB_COLUMNS).order('staged_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`ii_benchmark_import_jobs: ${error.message}`);
  return ((data ?? []) as unknown as JobRow[]).map((r) => toSummary(r, userId));
}

export interface ImportJobDetail {
  job: ImportJobSummary;
  preview: unknown;
  stagingDigest: string | null;
  eligibility: unknown;
  errors: Array<{ rowNumber: number | null; severity: 'error' | 'warning'; code: string; message: string; rawExcerpt: string | null }>;
  errorsStored: number;
}

export async function getImportJob(supabase: SupabaseClient, userId: string, jobId: string): Promise<ImportJobDetail | null> {
  const { data, error } = await supabase.from('ii_benchmark_import_jobs').select(`${JOB_COLUMNS}, preview, staging_digest, eligibility_detail`).eq('id', jobId).maybeSingle();
  if (error) throw new Error(`ii_benchmark_import_jobs: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as JobRow;
  const { data: errs, error: eErr } = await supabase.from('ii_benchmark_import_errors').select('row_no, severity, code, message, raw_excerpt').eq('job_id', jobId).order('severity', { ascending: true }).order('row_no', { ascending: true }).limit(500);
  if (eErr) throw new Error(`ii_benchmark_import_errors: ${eErr.message}`);
  const errors = ((errs ?? []) as Array<{ row_no: number | null; severity: 'error' | 'warning'; code: string; message: string; raw_excerpt: string | null }>).map((e) => ({ rowNumber: e.row_no, severity: e.severity, code: e.code, message: e.message, rawExcerpt: e.raw_excerpt }));
  return { job: toSummary(row, userId), preview: row.preview ?? null, stagingDigest: (row.staging_digest as string | null) ?? null, eligibility: row.eligibility_detail ?? null, errors, errorsStored: errors.length };
}

/** The validation errors of a job as a formula-injection-safe CSV (Standard section 11). */
export async function buildJobErrorCsv(supabase: SupabaseClient, jobId: string): Promise<string | null> {
  const { data: job, error } = await supabase.from('ii_benchmark_import_jobs').select('id').eq('id', jobId).maybeSingle();
  if (error) throw new Error(`ii_benchmark_import_jobs: ${error.message}`);
  if (!job) return null;
  const { data, error: eErr } = await supabase.from('ii_benchmark_import_errors').select('row_no, severity, code, message, raw_excerpt').eq('job_id', jobId).order('id', { ascending: true }).limit(2000);
  if (eErr) throw new Error(`ii_benchmark_import_errors: ${eErr.message}`);
  const issues: ValidationIssue[] = ((data ?? []) as Array<{ row_no: number | null; severity: 'error' | 'warning'; code: string; message: string; raw_excerpt: string | null }>).map((e) => ({
    rowNumber: e.row_no,
    severity: e.severity,
    code: e.code,
    message: e.message,
    rawExcerpt: e.raw_excerpt ?? undefined,
  }));
  return buildValidationErrorCsv(issues);
}
