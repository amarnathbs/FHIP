// BENCH-1 Phase 2 - the ONE stage -> validate pipeline for historical benchmark
// uploads (CSV / XLSX; single-benchmark, multi-benchmark and recognised
// provider-export shapes). Publication is a SEPARATE step (publishService.ts):
// the browser's preview payload is never the publish authority - the server
// persists the validated rows in ii_benchmark_import_rows and publication works
// from THOSE rows, bound to the file checksum, the staging digest and the
// previewed counts (migration 0241).
//
// Everything here runs under the CALLER'S OWN session client (never the
// service-role client): every RPC authorises with auth.uid() inside the
// database, so a caller who bypasses the API route is refused identically.
//
// The raw uploaded file is NEVER stored. Only its SHA-256, size, name and the
// normalised, validated rows are persisted (retention: unpublished staging
// copies expire after 14 days; copies for published jobs are purged after 90).
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import {
  readUploadToTable,
  validateUpload,
  VALIDATOR_VERSION,
  type CatalogueEntryLite,
  type Problem,
  type SheetInfo,
  type StagedRow,
  type UploadParams,
  type ValidationIssue,
  type ValidationResult,
} from './fileIngest';
import { actionAllowed, type EntitlementRecord } from './entitlements';

export const STAGE_CHUNK_SIZE = 2000;
export const PREVIEW_ISSUE_CAP = 100;
export const PREVIEW_WARNING_CAP = 50;
export const PREVIEW_CORRECTION_SAMPLE = 50;

export interface UploadMeta {
  sourceOwner: string;
  /** Original source URL or delivery reference (required). */
  sourceReference: string;
  originalFileName?: string;
  dataAsOf?: string | null;
  /** Required for corrections (>= 20 characters). */
  reason?: string | null;
  /** benchmark_key -> entitlement id chosen by the operator. Omit to auto-select a unique eligible record. */
  entitlementIds?: Record<string, string>;
  sourceId?: string | null;
}

export interface StageUploadInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  params: UploadParams;
  meta: UploadMeta;
  /** The caller's "today" (YYYY-MM-DD); injected so tests are deterministic. */
  todayIso: string;
}

export interface JobPreview {
  jobId: string;
  fileSha256: string;
  fileBytes: number;
  fileKind: 'csv' | 'xlsx';
  validatorVersion: string;
  layoutId: string;
  columnMapping: Record<string, string>;
  disclosure: ValidationResult['disclosure'];
  params: {
    shape: UploadParams['shape'];
    mode: UploadParams['mode'];
    returnVariant: UploadParams['returnVariant'];
    currencyCode: string;
    historyClass: UploadParams['historyClass'];
    dateFormat: UploadParams['dateFormat'];
    numberLocale: UploadParams['numberLocale'];
  };
  selectedBenchmarks: string[];
  source: { owner: string; reference: string; originalFileName: string; dataAsOf: string | null };
  counts: { rowsTotal: number; rowsValid: number; rowsInvalid: number; rowsExcluded: number; duplicatesCollapsed: number };
  mutation: { new: number; revive: number; identical: number; correction: number };
  /** Exact proposed publication scope, per benchmark. */
  scope: Array<{ benchmarkKey: string; earliestDate: string | null; latestDate: string | null; newRows: number; identicalRows: number; correctionRows: number; gaps: Array<{ from: string; to: string; weekdaysMissing: number }> }>;
  hardErrorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
  issuesTruncated: boolean;
  corrections: Array<{ benchmarkKey: string; date: string; before: number; after: number }>;
  requiredAcknowledgements: string[];
  eligibility: Record<string, { eligible: boolean; entitlementId: string | null; from?: string; to?: string }>;
  eligible: boolean;
  stagingDigest: string;
  /** Why publication is blocked right now (empty = ready for an authorised publisher). */
  blockers: string[];
}

export type StageUploadOutcome =
  | { status: 'rejected'; stage: 'inspection' | 'sheet' | 'layout' | 'parameters' | 'persist'; problems: Problem[]; issues?: ValidationIssue[]; sheets?: SheetInfo[]; fileSha256: string }
  | { status: 'staged'; jobId: string; preview: JobPreview; canPublish: boolean };

export function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

interface CatalogueRow {
  id: string;
  benchmark_key: string;
  return_variant: string | null;
  currency_code: string | null;
  lifecycle_status: string | null;
}

async function loadCatalogue(supabase: SupabaseClient): Promise<{ lite: Map<string, CatalogueEntryLite>; idByKey: Map<string, string> }> {
  const { data, error } = await supabase.from('ii_benchmarks').select('id, benchmark_key, return_variant, currency_code, lifecycle_status').limit(5000);
  if (error) throw new Error(`ii_benchmarks: ${error.message}`);
  const lite = new Map<string, CatalogueEntryLite>();
  const idByKey = new Map<string, string>();
  for (const r of (data ?? []) as CatalogueRow[]) {
    idByKey.set(r.benchmark_key, r.id);
    // A catalogue row without a declared variant/currency cannot be matched exactly; it is not offered at all.
    if (!r.return_variant || !r.currency_code) continue;
    lite.set(r.benchmark_key, {
      benchmarkKey: r.benchmark_key,
      returnVariant: r.return_variant as CatalogueEntryLite['returnVariant'],
      currencyCode: String(r.currency_code).trim(),
      isActive: r.lifecycle_status === 'active',
    });
  }
  return { lite, idByKey };
}

async function loadExisting(supabase: SupabaseClient, idByKey: Map<string, string>, ranges: Map<string, { from: string; to: string }>): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const [key, range] of ranges) {
    const id = idByKey.get(key);
    if (!id) continue;
    const rows = await fetchAllRows<{ series_date: string; value: number | string; quality_status: string }>(() =>
      supabase
        .from('ii_benchmark_series')
        .select('series_date, value, quality_status')
        .eq('benchmark_id', id)
        .gte('series_date', range.from)
        .lte('series_date', range.to)
        .order('series_date', { ascending: true })
    );
    const m = new Map<string, number>();
    for (const r of rows) if (r.quality_status !== 'superseded') m.set(r.series_date, Number(r.value));
    out.set(key, m);
  }
  return out;
}

interface EntitlementRow {
  id: string;
  benchmark_id: string;
  entitlement_kind: string;
  status: string;
  return_variant: string;
  currency_code: string;
  allow_manual_ingest: boolean;
  allow_automation: boolean;
  allow_storage: boolean;
  allow_calculation: boolean;
  allow_customer_display: boolean;
  allow_report_export: boolean;
  data_from: string | null;
  data_to: string | null;
  valid_from: string;
  valid_to: string | null;
  post_expiry_storage: string;
  post_expiry_calculation: boolean;
  post_expiry_display: boolean;
}

export function toEntitlementRecord(r: EntitlementRow): EntitlementRecord {
  return {
    id: r.id,
    benchmarkId: r.benchmark_id,
    kind: r.entitlement_kind as EntitlementRecord['kind'],
    status: r.status as EntitlementRecord['status'],
    returnVariant: r.return_variant as EntitlementRecord['returnVariant'],
    currencyCode: String(r.currency_code).trim(),
    allowManualIngest: r.allow_manual_ingest,
    allowAutomation: r.allow_automation,
    allowStorage: r.allow_storage,
    allowCalculation: r.allow_calculation,
    allowCustomerDisplay: r.allow_customer_display,
    allowReportExport: r.allow_report_export,
    dataFrom: r.data_from,
    dataTo: r.data_to,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    postExpiryStorage: r.post_expiry_storage as EntitlementRecord['postExpiryStorage'],
    postExpiryCalculation: r.post_expiry_calculation,
    postExpiryDisplay: r.post_expiry_display,
  };
}

const ENTITLEMENT_COLUMNS =
  'id, benchmark_id, entitlement_kind, status, return_variant, currency_code, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, post_expiry_calculation, post_expiry_display';

export async function loadEntitlementRecords(supabase: SupabaseClient, benchmarkIds: string[]): Promise<EntitlementRecord[]> {
  if (benchmarkIds.length === 0) return [];
  const { data, error } = await supabase.from('ii_benchmark_entitlements').select(ENTITLEMENT_COLUMNS).in('benchmark_id', benchmarkIds).eq('status', 'approved');
  if (error) throw new Error(`ii_benchmark_entitlements: ${error.message}`);
  return ((data ?? []) as EntitlementRow[]).map(toEntitlementRecord);
}

/**
 * Pick the entitlement a publish will be bound to, per benchmark: the operator's
 * explicit choice (must still grant ingest + storage for the staged range), else
 * the single eligible record. Never guesses between several.
 */
export function chooseEntitlements(
  records: readonly EntitlementRecord[],
  idByKey: Map<string, string>,
  variantByKey: Map<string, { returnVariant: string; currencyCode: string }>,
  ranges: Map<string, { from: string; to: string }>,
  explicit: Record<string, string> | undefined,
  todayIso: string
): { refs: Record<string, string>; unresolved: Array<{ benchmarkKey: string; reason: string }> } {
  const refs: Record<string, string> = {};
  const unresolved: Array<{ benchmarkKey: string; reason: string }> = [];
  for (const [key, range] of ranges) {
    const benchmarkId = idByKey.get(key);
    const ident = variantByKey.get(key);
    if (!benchmarkId || !ident) {
      unresolved.push({ benchmarkKey: key, reason: 'The benchmark is not in the catalogue with a declared variant and currency.' });
      continue;
    }
    const identity = { benchmarkId, returnVariant: ident.returnVariant as EntitlementRecord['returnVariant'], currencyCode: ident.currencyCode };
    const eligible = records.filter((e) => e.benchmarkId === benchmarkId && actionAllowed(identity, [e], 'publish_manual', todayIso, { dataFrom: range.from, dataTo: range.to }).allowed);
    const wanted = explicit?.[key];
    if (wanted) {
      if (eligible.some((e) => e.id === wanted)) refs[key] = wanted;
      else unresolved.push({ benchmarkKey: key, reason: 'The selected entitlement does not grant manual ingestion and storage for this benchmark and date range.' });
      continue;
    }
    if (eligible.length === 1) refs[key] = eligible[0].id;
    else if (eligible.length === 0) unresolved.push({ benchmarkKey: key, reason: 'No approved, in-term entitlement grants manual ingestion and storage for this benchmark and date range.' });
    else unresolved.push({ benchmarkKey: key, reason: 'More than one eligible entitlement exists; choose one explicitly.' });
  }
  return { refs, unresolved };
}

function rangesOf(staged: readonly StagedRow[]): Map<string, { from: string; to: string }> {
  const m = new Map<string, { from: string; to: string }>();
  for (const r of staged) {
    const cur = m.get(r.benchmarkKey);
    if (!cur) m.set(r.benchmarkKey, { from: r.date, to: r.date });
    else {
      if (r.date < cur.from) cur.from = r.date;
      if (r.date > cur.to) cur.to = r.date;
    }
  }
  return m;
}

function paramsForPreview(p: UploadParams, usedDateFormat?: UploadParams['dateFormat']): JobPreview['params'] {
  return { shape: p.shape, mode: p.mode, returnVariant: p.returnVariant, currencyCode: p.currencyCode, historyClass: p.historyClass, dateFormat: usedDateFormat ?? p.dateFormat, numberLocale: p.numberLocale };
}

export function buildPreviewIssueSample(issues: readonly ValidationIssue[]): { sample: ValidationIssue[]; truncated: boolean } {
  const errors = issues.filter((i) => i.severity === 'error').slice(0, PREVIEW_ISSUE_CAP);
  const warnings = issues.filter((i) => i.severity === 'warning').slice(0, PREVIEW_WARNING_CAP);
  const total = issues.length;
  return { sample: [...errors, ...warnings], truncated: total > errors.length + warnings.length };
}

/** Chunk helper (exported for tests). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

export async function stageBenchmarkUpload(supabase: SupabaseClient, input: StageUploadInput): Promise<StageUploadOutcome> {
  const fileSha256 = sha256Bytes(input.bytes);
  const { params, meta } = input;

  // Required metadata the database also enforces (so a direct RPC call cannot skip it).
  const metaProblems: Problem[] = [];
  if (!meta.sourceOwner || meta.sourceOwner.trim().length < 2) metaProblems.push({ code: 'SOURCE_OWNER_REQUIRED', message: 'The source owner / provider is required.' });
  if (!meta.sourceReference || meta.sourceReference.trim().length < 5) metaProblems.push({ code: 'SOURCE_REFERENCE_REQUIRED', message: 'The original source URL or delivery reference is required.' });
  if (params.mode === 'correction' && (!meta.reason || meta.reason.trim().length < 20)) metaProblems.push({ code: 'CORRECTION_REASON_REQUIRED', message: 'A correction needs a reason of at least 20 characters.' });
  if (params.shape !== 'multi' && !params.benchmarkKey) metaProblems.push({ code: 'BENCHMARK_REQUIRED', message: 'Choose the existing catalogue benchmark this file belongs to.' });
  if (metaProblems.length > 0) return { status: 'rejected', stage: 'parameters', problems: metaProblems, fileSha256 };

  const read = readUploadToTable({ fileName: input.fileName, declaredMime: input.declaredMime, bytes: input.bytes, params });
  if (!read.ok) return { status: 'rejected', stage: read.stage === 'sheet' ? 'sheet' : 'inspection', problems: read.problems, sheets: read.sheets, fileSha256 };

  const { lite, idByKey } = await loadCatalogue(supabase);

  // Pass 1: learn which benchmarks and date ranges the file really contains.
  const pass1 = validateUpload(read.table, params, { todayIso: input.todayIso, catalogue: lite, existing: new Map() });
  const ranges = rangesOf(pass1.staged);
  const existing = await loadExisting(supabase, idByKey, ranges);

  // Entitlements for exactly the benchmarks present.
  const benchmarkIds = [...ranges.keys()].map((k) => idByKey.get(k)).filter((x): x is string => !!x);
  const records = await loadEntitlementRecords(supabase, benchmarkIds);
  const variantByKey = new Map([...lite].map(([k, v]) => [k, { returnVariant: v.returnVariant, currencyCode: v.currencyCode }]));
  const chosen = chooseEntitlements(records, idByKey, variantByKey, ranges, meta.entitlementIds, input.todayIso);
  const singleScope = ranges.size === 1 ? records.find((r) => r.id === Object.values(chosen.refs)[0]) : undefined;

  // Pass 2: the real validation, against what is published and the entitlement scope.
  const validation = validateUpload(read.table, params, {
    todayIso: input.todayIso,
    catalogue: lite,
    existing,
    entitlementDateScope: singleScope ? { from: singleScope.dataFrom ?? undefined, to: singleScope.dataTo ?? undefined } : null,
  });

  const keys = [...new Set([...validation.staged.map((s) => s.benchmarkKey), ...(params.benchmarkKey ? [params.benchmarkKey] : [])])].filter((k) => idByKey.has(k));
  if (keys.length === 0) {
    // Nothing identifies a catalogue benchmark: nothing to persist against. Return the issues for display / error download.
    return { status: 'rejected', stage: 'layout', problems: validation.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message, rowNumber: i.rowNumber ?? undefined })), issues: validation.issues, fileSha256 };
  }

  const entitlementRefs: Record<string, string> = {};
  for (const k of keys) if (chosen.refs[k]) entitlementRefs[k] = chosen.refs[k];

  const { data: created, error: createErr } = await supabase.rpc('create_benchmark_import_job', {
    p: {
      mode: params.mode,
      shape: params.shape,
      layout_id: validation.disclosure.layoutId,
      file_format: read.kind,
      file_name: meta.originalFileName ?? input.fileName,
      file_sha256: fileSha256,
      file_bytes: input.bytes.byteLength,
      sheet_name: params.sheetName ?? null,
      source_owner: meta.sourceOwner.trim(),
      source_reference: meta.sourceReference.trim(),
      source_id: meta.sourceId ?? null,
      benchmark_keys: keys,
      return_variant: params.returnVariant,
      currency_code: params.currencyCode,
      history_class: params.historyClass,
      date_format: validation.disclosure.dateFormat ?? params.dateFormat ?? null,
      number_locale: params.numberLocale,
      data_as_of: meta.dataAsOf ?? null,
      reason: meta.reason ?? null,
      validator_version: VALIDATOR_VERSION,
      entitlement_refs: entitlementRefs,
    },
  });
  if (createErr) {
    return { status: 'rejected', stage: 'persist', problems: [{ code: createErr.code ?? 'CREATE_FAILED', message: createErr.message }], issues: validation.issues, fileSha256 };
  }
  const jobId = created as unknown as string;

  const failJob = async (code: string, detail: string) => {
    await supabase.rpc('record_benchmark_import_failure', { p_job: jobId, p_code: code, p_detail: detail });
  };

  try {
    const stagedForDb = validation.staged.map((s) => ({ row_no: s.rowNumber, benchmark_key: s.benchmarkKey, series_date: s.date, value: s.valueText }));
    const errorsForDb = validation.issues.map((i) => ({ row_no: i.rowNumber, severity: i.severity, code: i.code, message: i.message, raw_excerpt: i.rawExcerpt ?? null }));
    const rowChunks = stagedForDb.length > 0 ? chunk(stagedForDb, STAGE_CHUNK_SIZE) : [[]];
    for (let i = 0; i < rowChunks.length; i++) {
      // Errors are attached to the first chunk only (the database caps them at 2000).
      const { error } = await supabase.rpc('stage_benchmark_import_rows', { p_job: jobId, p_rows: rowChunks[i], p_errors: i === 0 ? errorsForDb : [] });
      if (error) {
        await failJob('STAGE_CHUNK_FAILED', error.message);
        return { status: 'rejected', stage: 'persist', problems: [{ code: error.code ?? 'STAGE_FAILED', message: `Staging failed on chunk ${i + 1} of ${rowChunks.length}: ${error.message}` }], issues: validation.issues, fileSha256 };
      }
    }
  } catch (e) {
    await failJob('STAGE_EXCEPTION', e instanceof Error ? e.message : String(e));
    throw e;
  }

  const warningCount = validation.issues.filter((i) => i.severity === 'warning').length;
  const { sample, truncated } = buildPreviewIssueSample(validation.issues);
  const corrections = validation.staged
    .filter((s) => s.classification === 'correction' && s.existing !== null)
    .slice(0, PREVIEW_CORRECTION_SAMPLE)
    .map((s) => ({ benchmarkKey: s.benchmarkKey, date: s.date, before: s.existing as number, after: s.value }));

  const { data: fin, error: finErr } = await supabase.rpc('finalize_benchmark_import_job', {
    p_job: jobId,
    p: {
      hard_error_count: validation.hardErrorCount,
      rows_total: validation.rowsTotal,
      rows_invalid: validation.rowsInvalid,
      warning_count: warningCount,
      required_acks: validation.requiredAcknowledgements,
      preview: { disclosure: validation.disclosure, scope: validation.perBenchmark, corrections, layoutId: validation.disclosure.layoutId },
    },
  });
  if (finErr) {
    await failJob('FINALIZE_FAILED', finErr.message);
    return { status: 'rejected', stage: 'persist', problems: [{ code: finErr.code ?? 'FINALIZE_FAILED', message: finErr.message }], issues: validation.issues, fileSha256 };
  }
  const f = fin as unknown as {
    staging_digest: string;
    rows_new: number;
    rows_identical: number;
    rows_correction: number;
    rows_revive: number;
    hard_error_total: number;
    eligible: boolean;
    eligibility: JobPreview['eligibility'];
  };

  const blockers: string[] = [];
  if (f.hard_error_total > 0) blockers.push(`${f.hard_error_total} hard validation error(s) remain; nothing can be published until the file is corrected and uploaded again.`);
  if (!f.eligible) {
    const names = Object.entries(f.eligibility ?? {}).filter(([, v]) => !v.eligible).map(([k]) => k);
    blockers.push(`No approved entitlement permits publication for: ${names.length ? names.join(', ') : 'this upload'}. A file upload does not itself establish usage permission.`);
  }
  for (const u of chosen.unresolved) if (!blockers.some((b) => b.includes(u.benchmarkKey))) blockers.push(`${u.benchmarkKey}: ${u.reason}`);
  if (f.rows_new + f.rows_revive + f.rows_correction === 0 && f.hard_error_total === 0) blockers.push('Every valid row is already published with the same value: there is nothing to publish.');

  const preview: JobPreview = {
    jobId,
    fileSha256,
    fileBytes: input.bytes.byteLength,
    fileKind: read.kind,
    validatorVersion: VALIDATOR_VERSION,
    layoutId: validation.disclosure.layoutId,
    columnMapping: validation.disclosure.columnMapping,
    disclosure: validation.disclosure,
    params: paramsForPreview(params, validation.disclosure.dateFormat),
    selectedBenchmarks: keys,
    source: { owner: meta.sourceOwner.trim(), reference: meta.sourceReference.trim(), originalFileName: meta.originalFileName ?? input.fileName, dataAsOf: meta.dataAsOf ?? null },
    counts: { rowsTotal: validation.rowsTotal, rowsValid: validation.rowsValid, rowsInvalid: validation.rowsInvalid, rowsExcluded: validation.rowsExcluded, duplicatesCollapsed: validation.duplicatesCollapsed },
    mutation: { new: f.rows_new, revive: f.rows_revive, identical: f.rows_identical, correction: f.rows_correction },
    scope: validation.perBenchmark,
    hardErrorCount: f.hard_error_total,
    warningCount,
    issues: sample,
    issuesTruncated: truncated,
    corrections,
    requiredAcknowledgements: validation.requiredAcknowledgements,
    eligibility: f.eligibility ?? {},
    eligible: f.eligible,
    stagingDigest: f.staging_digest,
    blockers,
  };
  return { status: 'staged', jobId, preview, canPublish: blockers.length === 0 };
}
