// Resources Bulk Upload -- staging (database). Server-only.
//
// Division of labour (Admin Architecture Standard sections 2, 4, 6):
//   * READS of reference data and existing content use the CALLER'S request-scoped client,
//     so RLS applies exactly as it does everywhere else in Resources.
//   * WRITES to the staging tables use the SERVICE-ROLE client, but only after the route has
//     verified the bulk-import capability. No API role holds a write grant on those tables, so a
//     browser can never write or alter staged data: the browser's preview payload is NOT apply
//     authority -- the staged rows are, and only this module writes them.
//   * APPLY is the SECURITY DEFINER database function, called with the caller's own session, so the
//     capability, the ownership of the run and the forced draft/private state are enforced in the
//     database whatever this code does.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';
import { getImportAdapter } from './adapters';
import { parseImportFile } from './parser';
import { collectLookupKeys, flattenIssues, summariseOutcome, validateImportTable } from './validation';
import {
  STAGING_RETENTION_DAYS,
  type ImportContentType,
  type ImportIssue,
  type ImportReferenceData,
  type RunStatus,
  type ValidatedRow,
  type ValidationOutcome,
} from './types';

export interface RunRecord {
  id: string;
  content_type: ImportContentType;
  uploaded_by: string | null;
  file_name: string;
  file_sha256: string;
  template_version: string | null;
  status: RunStatus;
  row_count: number;
  valid_count: number;
  warning_count: number;
  error_count: number;
  normalized_digest: string | null;
  file_issues: ImportIssue[];
  created_post_count: number;
  failure_code: string | null;
  failure_message_safe: string | null;
  created_at: string;
  validated_at: string | null;
  applied_at: string | null;
  expires_at: string;
}

export interface StagedRowRecord {
  row_number: number;
  external_id: string | null;
  slug: string | null;
  title: string | null;
  display: Record<string, unknown>;
  validation_errors: ImportIssue[];
  validation_warnings: ImportIssue[];
  result_post_id: string | null;
  result_status: 'staged' | 'created';
}

const RUN_COLUMNS =
  'id, content_type, uploaded_by, file_name, file_sha256, template_version, status, row_count, valid_count, warning_count, error_count, normalized_digest, file_issues, created_post_count, failure_code, failure_message_safe, created_at, validated_at, applied_at, expires_at';

export function safeFileName(raw: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200) || 'upload';
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Deterministic digest of what was previewed (audit evidence; apply authority is the staged rows themselves). */
export function normalisedDigest(rows: ValidatedRow[]): string {
  const h = createHash('sha256');
  for (const r of rows) h.update(JSON.stringify([r.rowNumber, r.payload, r.errors.map((e) => e.code)]));
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Reference data: a CONSTANT number of queries however many rows the file has.
// ---------------------------------------------------------------------------
export interface QueryCounter {
  queries: number;
}

export async function loadReferenceData(
  user: SupabaseClient,
  keys: { slugs: string[]; externalIds: string[]; urls: string[] },
  counter?: QueryCounter
): Promise<ImportReferenceData> {
  const tick = () => {
    if (counter) counter.queries += 1;
  };
  tick();
  tick();
  tick();
  tick();
  tick();
  const [cats, tags, authors, ctas, lookup] = await Promise.all([
    user.from('resource_categories').select('id, name, slug').eq('is_active', true).limit(5000),
    user.from('resource_tags').select('id, name, slug').eq('is_active', true).limit(5000),
    user.from('resource_authors').select('id, display_name, slug').eq('is_active', true).limit(5000),
    user.from('resource_ctas').select('id, name, label').eq('is_active', true).limit(5000),
    user.rpc('resource_content_import_lookup', {
      p_slugs: keys.slugs,
      p_content_ids: Array.from(new Set(keys.externalIds.flatMap((e) => [e, e.toLowerCase()]))),
      p_source_urls: keys.urls,
    }),
  ]);
  for (const r of [cats, tags, authors, ctas, lookup]) if (r.error) throw r.error;
  const l = (lookup.data ?? { slugs: [], content_ids: [], post_ids: [], sources: [] }) as { slugs: string[]; content_ids: string[]; post_ids: string[]; sources: { id: string; source_name: string; document_title: string | null; url: string | null }[] };
  return {
    categories: (cats.data ?? []) as ImportReferenceData['categories'],
    tags: (tags.data ?? []) as ImportReferenceData['tags'],
    authors: (authors.data ?? []) as ImportReferenceData['authors'],
    ctas: (ctas.data ?? []) as ImportReferenceData['ctas'],
    sources: l.sources,
    existingSlugs: new Set(l.slugs),
    existingContentIds: new Set(l.content_ids),
    existingPostIds: new Set(l.post_ids.map((x) => x.toLowerCase())),
  };
}

// ---------------------------------------------------------------------------
// Upload -> stage
// ---------------------------------------------------------------------------
export interface UploadParams {
  user: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  contentType: ImportContentType;
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  now?: Date;
}

export interface UploadResult {
  runId: string;
  status: RunStatus;
  fileIssues: ImportIssue[];
  summary: { rowCount: number; validCount: number; warningCount: number; errorCount: number };
  metrics: { parseMs: number; resolveMs: number; validateMs: number; stageMs: number; dbQueries: number };
}

async function insertRun(admin: SupabaseClient, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('resource_content_import_runs').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

const ROW_CHUNK = 50;

export async function processUpload(p: UploadParams): Promise<UploadResult> {
  const counter: QueryCounter = { queries: 0 };
  const now = p.now ?? new Date();
  const adapter = getImportAdapter(p.contentType);
  const fileName = safeFileName(p.fileName);
  const expiresAt = new Date(now.getTime() + STAGING_RETENTION_DAYS * 86_400_000).toISOString();

  // Opportunistic retention: clear expired, never-applied staging rows. Failure never blocks an upload.
  counter.queries += 1;
  await Promise.resolve(p.admin.rpc('purge_expired_resource_content_import_staging')).catch(() => undefined);

  const t0 = Date.now();
  const parsed = parseImportFile({ fileName, declaredMime: p.declaredMime, bytes: p.bytes }, adapter.schema);
  const parseMs = Date.now() - t0;

  const reject = async (issues: ImportIssue[], sha: string | null): Promise<UploadResult> => {
    counter.queries += 1;
    const runId = await insertRun(p.admin, {
      content_type: p.contentType,
      uploaded_by: p.userId,
      file_name: fileName,
      file_sha256: sha ?? '0'.repeat(64),
      template_version: null,
      status: 'rejected',
      row_count: 0,
      valid_count: 0,
      warning_count: 0,
      error_count: 0,
      file_issues: issues,
      failure_code: issues[0]?.code ?? 'FILE_PARSE_ERROR',
      failure_message_safe: (issues[0]?.message ?? 'The file could not be read.').slice(0, 500),
      validated_at: now.toISOString(),
      expires_at: expiresAt,
    });
    await logResourceAudit(p.admin, {
      entity_type: 'resource_content_import_run',
      entity_id: runId,
      action: 'rejected',
      actor_user_id: p.userId,
      metadata: { content_type: p.contentType, file_name: fileName, file_sha256: sha, failure_code: issues[0]?.code ?? null },
    });
    return { runId, status: 'rejected', fileIssues: issues, summary: { rowCount: 0, validCount: 0, warningCount: 0, errorCount: 0 }, metrics: { parseMs, resolveMs: 0, validateMs: 0, stageMs: 0, dbQueries: counter.queries } };
  };

  if (!parsed.ok) return reject(parsed.issues, parsed.fileSha256);

  // Same successful file again -> refuse up front (the database also guarantees it at apply).
  counter.queries += 1;
  const dupe = await p.admin.from('resource_content_import_runs').select('id').eq('content_type', p.contentType).eq('file_sha256', parsed.fileSha256).eq('status', 'applied').limit(1);
  if (dupe.error) throw dupe.error;
  if ((dupe.data ?? []).length > 0) {
    return reject([{ row: null, field: null, code: 'FILE_ALREADY_APPLIED', message: 'This exact file was already applied. Nothing was created a second time. If you changed the file, upload the changed version.', severity: 'error' }], parsed.fileSha256);
  }

  const t1 = Date.now();
  const keys = collectLookupKeys(parsed.table);
  const refs = await loadReferenceData(p.user, keys, counter);
  const resolveMs = Date.now() - t1;

  const t2 = Date.now();
  const outcome: ValidationOutcome = validateImportTable(parsed.table, parsed.cellIssues, adapter.hooks, refs, todayUtc(now));
  const validateMs = Date.now() - t2;
  const summary = summariseOutcome(outcome);

  const t3 = Date.now();
  counter.queries += 1;
  const runId = await insertRun(p.admin, {
    content_type: p.contentType,
    uploaded_by: p.userId,
    file_name: fileName,
    file_sha256: parsed.fileSha256,
    template_version: adapter.schema.templateVersion,
    status: summary.errorCount === 0 ? 'ready' : 'has_errors',
    row_count: summary.rowCount,
    valid_count: summary.validCount,
    warning_count: summary.warningCount,
    error_count: summary.errorCount,
    normalized_digest: normalisedDigest(outcome.rows),
    file_issues: outcome.fileIssues,
    validated_at: now.toISOString(),
    expires_at: expiresAt,
  });
  for (let i = 0; i < outcome.rows.length; i += ROW_CHUNK) {
    const chunk = outcome.rows.slice(i, i + ROW_CHUNK).map((r) => ({
      import_run_id: runId,
      row_number: r.rowNumber,
      external_id: r.display.external_id,
      slug: r.display.slug,
      title: r.display.title ? r.display.title.slice(0, 300) : null,
      display: r.display,
      normalized_payload: r.payload ?? {},
      validation_errors: r.errors,
      validation_warnings: r.warnings,
    }));
    counter.queries += 1;
    const ins = await p.admin.from('resource_content_import_rows').insert(chunk);
    if (ins.error) {
      // Never leave a half-staged run that looks usable.
      await p.admin.from('resource_content_import_runs').delete().eq('id', runId);
      throw ins.error;
    }
  }
  const stageMs = Date.now() - t3;

  await logResourceAudit(p.admin, {
    entity_type: 'resource_content_import_run',
    entity_id: runId,
    action: 'uploaded',
    actor_user_id: p.userId,
    metadata: { content_type: p.contentType, file_name: fileName, file_sha256: parsed.fileSha256, template_version: adapter.schema.templateVersion, row_count: summary.rowCount, error_count: summary.errorCount },
  });

  return {
    runId,
    status: summary.errorCount === 0 ? 'ready' : 'has_errors',
    fileIssues: outcome.fileIssues,
    summary,
    metrics: { parseMs, resolveMs, validateMs, stageMs, dbQueries: counter.queries },
  };
}

// ---------------------------------------------------------------------------
// Reads (caller's own client: RLS decides what is visible)
// ---------------------------------------------------------------------------
export async function getRun(user: SupabaseClient, runId: string): Promise<RunRecord | null> {
  const { data, error } = await user.from('resource_content_import_runs').select(RUN_COLUMNS).eq('id', runId).maybeSingle();
  if (error) throw error;
  return (data as RunRecord | null) ?? null;
}

export async function listRuns(user: SupabaseClient, limit = 25): Promise<(RunRecord & { uploader_label?: string })[]> {
  const { data, error } = await user.from('resource_content_import_runs').select(RUN_COLUMNS).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;
  return (data ?? []) as RunRecord[];
}

export async function getRunRows(user: SupabaseClient, runId: string): Promise<StagedRowRecord[]> {
  const { data, error } = await user
    .from('resource_content_import_rows')
    .select('row_number, external_id, slug, title, display, validation_errors, validation_warnings, result_post_id, result_status')
    .eq('import_run_id', runId)
    .order('row_number', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as StagedRowRecord[];
}

export async function getRowDetail(user: SupabaseClient, runId: string, rowNumber: number): Promise<(StagedRowRecord & { normalized_payload: Record<string, unknown> }) | null> {
  const { data, error } = await user
    .from('resource_content_import_rows')
    .select('row_number, external_id, slug, title, display, normalized_payload, validation_errors, validation_warnings, result_post_id, result_status')
    .eq('import_run_id', runId)
    .eq('row_number', rowNumber)
    .maybeSingle();
  if (error) throw error;
  return (data as (StagedRowRecord & { normalized_payload: Record<string, unknown> }) | null) ?? null;
}

/** Every issue of one run (file-level + row-level), for the downloadable results file. */
export function issuesOfRun(run: RunRecord, rows: StagedRowRecord[]): ImportIssue[] {
  const all: ImportIssue[] = [...(run.file_issues ?? [])];
  for (const r of rows) all.push(...(r.validation_errors ?? []), ...(r.validation_warnings ?? []));
  return all;
}

export { flattenIssues };

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
export type ApplyOutcome =
  | { ok: true; alreadyApplied: boolean; created: number; postIds: string[]; runId: string }
  | { ok: false; code: string; message: string; status: number };

const CODE_RE = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/;

const SAFE_MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_AUTHENTICATED: { status: 401, message: 'Sign in to continue.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to apply this import.' },
  IMPORT_NOT_READY: { status: 409, message: 'This import is not ready to apply. It may have errors, may already be applied, or may have expired. Upload the file again.' },
  FILE_ALREADY_APPLIED: { status: 409, message: 'This exact file was already applied. Nothing was created.' },
  STALE_PREVIEW: { status: 409, message: 'Something changed after the preview was prepared (for example, another item now uses the same slug). Nothing was created. Upload the file again to get a fresh preview.' },
  APPLY_FAILED: { status: 500, message: 'The import could not be completed. Nothing was created. Try again, or upload the file again.' },
};

export function parseApplyError(raw: string): { code: string; message: string; status: number } {
  const m = CODE_RE.exec(raw.trim());
  const code = m ? m[1] : 'APPLY_FAILED';
  const known = SAFE_MESSAGES[code];
  if (!known) return { code: 'APPLY_FAILED', ...SAFE_MESSAGES.APPLY_FAILED };
  return { code, ...known };
}

export async function applyRun(user: SupabaseClient, admin: SupabaseClient, runId: string, actorUserId: string): Promise<ApplyOutcome> {
  const { data, error } = await user.rpc('apply_resource_content_import', { p_run_id: runId });
  if (error) {
    const parsed = parseApplyError(error.message ?? '');
    // Failures roll back inside the database; record the outcome on the run for the history screen.
    if (parsed.code === 'STALE_PREVIEW') {
      await admin.from('resource_content_import_runs').update({ status: 'stale', failure_code: parsed.code, failure_message_safe: parsed.message }).eq('id', runId).neq('status', 'applied');
    } else if (parsed.code === 'APPLY_FAILED' || parsed.code === 'FILE_ALREADY_APPLIED') {
      await admin.from('resource_content_import_runs').update({ failure_code: parsed.code, failure_message_safe: parsed.message }).eq('id', runId).neq('status', 'applied');
    }
    if (parsed.code !== 'NOT_AUTHENTICATED' && parsed.code !== 'FORBIDDEN') {
      await logResourceAudit(admin, { entity_type: 'resource_content_import_run', entity_id: runId, action: 'apply_failed', actor_user_id: actorUserId, metadata: { failure_code: parsed.code } });
    }
    return { ok: false, ...parsed };
  }
  const v = (data ?? {}) as { ok?: boolean; already_applied?: boolean; created?: number; post_ids?: string[]; run_id?: string };
  if (!v.ok) return { ok: false, ...parseApplyError('APPLY_FAILED: unexpected result') };
  return { ok: true, alreadyApplied: v.already_applied === true, created: v.created ?? 0, postIds: v.post_ids ?? [], runId: v.run_id ?? runId };
}
