// Route-support helpers for the Benchmark Data Admin API (BENCH-1 Phase 2).
//
// Shared zod schemas, response mappers and failure translators so each route
// file stays thin: it calls requireBenchmarkCapability() FIRST, validates its
// input, calls ONE service/RPC under the caller's own session client, and maps
// the outcome. Nothing in this file touches the service-role client (the
// route tests grep every file under benchmark-data/ for it).
//
// SAFE FAILURE (Admin Architecture Standard section 13): a raw database error
// is never returned. RPC refusals are translated by mapRpcError() and their
// message is forwarded ONLY when it is one of the database functions' own
// operator-facing sentences (they all start "benchmark <area>: "); anything
// else - a constraint name, a table name - is replaced by a fixed generic line.
import { z } from 'zod';
import { bad, badValidation } from '@/lib/api';
import { requireBenchmarkCapability, type BenchmarkCapability, type BenchmarkCapabilityFlags } from './guards';
import { DEFAULT_LIMITS } from './fileIngest/types';
import { toEntitlementRecord } from './uploadService';
import { mapRpcError, type RpcFailure, type RpcFailureKind } from './publishService';
import type { CatalogueRowView, EntitlementRightsView, MappingProposalView } from './apiTypes';
import type { User } from '@supabase/supabase-js';

// ------------------------------------------------------------------ guards ---

/**
 * One of several capabilities suffices (cancel: upload, publish or correct).
 * The VIEW guard runs first (401 / 403 for anyone who is not a benchmark
 * operator at all, plus the country gate), then the named flags are checked.
 */
export async function requireAnyBenchmarkCapability(
  caps: readonly Exclude<BenchmarkCapability, 'view'>[]
): Promise<{ user: User | null; flags: BenchmarkCapabilityFlags; forbidden: Response | null }> {
  const base = await requireBenchmarkCapability('view');
  if (base.forbidden || !base.user) return { ...base, forbidden: base.forbidden ?? bad('unauthenticated', 401) };
  if (!caps.some((c) => base.flags[c] === true)) {
    return { user: null, flags: base.flags, forbidden: bad(`Benchmark data ${caps.join(' or ')} access required`, 403) };
  }
  return base;
}

// ------------------------------------------------------------------ errors ---

const SAFE_RPC_MESSAGE = /^benchmark [a-z ]+: /;

const GENERIC_BY_KIND: Record<RpcFailureKind, string> = {
  forbidden: 'You do not have permission to perform this operation.',
  stale: 'The data changed since it was staged; stage the file again.',
  duplicate: 'This conflicts with an existing record.',
  invalid: 'The submitted data is not valid for this operation.',
  wrong_state: 'The record is not in a state that allows this operation.',
  not_found: 'The requested record was not found.',
  unavailable: 'The benchmark import service is unavailable.',
};

/** The message that may be shown to the operator for a database refusal. */
export function safeFailureMessage(f: { kind: RpcFailureKind; message: string }): string {
  return SAFE_RPC_MESSAGE.test(f.message) ? f.message : GENERIC_BY_KIND[f.kind];
}

export function failureResponse(f: RpcFailure): Response {
  return Response.json({ error: safeFailureMessage(f), code: f.kind }, { status: f.httpStatus });
}

/** Translate a PostgREST/Postgres error into a safe response (never the raw message). */
export function dbErrorResponse(error: { code?: string; message?: string }): Response {
  return failureResponse(mapRpcError(error));
}

export const UNAVAILABLE_0239 =
  'Migration 0239 (BENCH-1 Phase 2 benchmark data governance) has not been applied to this database, so the benchmark upload and governance tables do not exist yet. This is reported as unavailable rather than as an empty healthy state.';

/** A missing relation / column: the migration is not applied. */
export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204') return true;
  return /does not exist|schema cache/i.test(error.message ?? '');
}

/** Thrown-by-service variant: the services wrap the message as `table: <postgrest message>`. */
export function isMissingRelationMessage(message: string): boolean {
  return /PGRST205|42P01|42703|does not exist|schema cache/i.test(message);
}

/** Fixed, safe 503 for an unexpected failure inside a service call; the detail is logged server-side only. */
export function serviceFailureResponse(err: unknown, context: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`benchmark-data ${context}:`, message);
  if (isMissingRelationMessage(message)) return Response.json({ error: UNAVAILABLE_0239, code: 'unavailable' }, { status: 503 });
  return Response.json({ error: 'The benchmark data service is unavailable. Please try again shortly.', code: 'unavailable' }, { status: 503 });
}

// ------------------------------------------------------------ input parsing ---

export const uuidSchema = z.string().uuid();

/** A path id must be a uuid: anything else is a 422, never passed to the database. */
export function parseUuidParam(value: string | undefined): { id: string; response: null } | { id: null; response: Response } {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) return { id: null, response: bad('The identifier in the URL is not valid.', 422) };
  return { id: parsed.data, response: null };
}

export const JSON_BODY_MAX_BYTES = 64 * 1024;

/** Reads a small JSON body with a hard size cap (413) and 422 for malformed JSON. */
export async function parseJsonBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<{ data: z.infer<S>; response: null } | { data: null; response: Response }> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > JSON_BODY_MAX_BYTES) return { data: null, response: bad('The request body is too large.', 413) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { data: null, response: bad('The request body could not be read.', 422) };
  }
  if (text.length > JSON_BODY_MAX_BYTES) return { data: null, response: bad('The request body is too large.', 413) };
  let raw: unknown;
  try {
    raw = text.length === 0 ? null : JSON.parse(text);
  } catch {
    return { data: null, response: bad('The request body must be valid JSON.', 422) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { data: null, response: badValidation(parsed.error, 422) };
  return { data: parsed.data, response: null };
}

/** Reads the request body up to `cap` bytes; null = the cap was exceeded (nothing beyond it is buffered). */
export async function readBodyCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Multipart overhead allowance on top of the file limit (the `params` JSON part and boundaries). */
export const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export type UploadedFile = { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };

/** Parse a multipart upload with the byte limit enforced BEFORE the body is fully buffered. */
export async function readMultipartUpload(req: Request): Promise<{ form: FormData; file: UploadedFile; response: null } | { form: null; file: null; response: Response }> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType)) return { form: null, file: null, response: bad('The upload must be multipart/form-data.', 415) };
  const bytes = await readBodyCapped(req, DEFAULT_LIMITS.maxBytes + MULTIPART_OVERHEAD_BYTES);
  if (bytes === null) return { form: null, file: null, response: bad(`The file is larger than the ${DEFAULT_LIMITS.maxBytes} byte upload limit.`, 413) };
  let form: FormData;
  try {
    form = await new Response(bytes as unknown as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { form: null, file: null, response: bad('The multipart body could not be read.', 422) };
  }
  const f = form.get('file');
  if (!f || typeof f === 'string' || typeof (f as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    return { form: null, file: null, response: bad('A "file" part is required.', 422) };
  }
  const file = f as unknown as UploadedFile;
  if (file.size > DEFAULT_LIMITS.maxBytes) return { form: null, file: null, response: bad(`The file is larger than the ${DEFAULT_LIMITS.maxBytes} byte upload limit.`, 413) };
  return { form, file, response: null };
}

// ----------------------------------------------------------------- schemas ---

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');
const nullableDate = isoDateString.nullable().optional();
const boolDefaultFalse = z.boolean().optional().default(false);
const shortText = (max: number) => z.string().trim().max(max);

export const BENCHMARK_KEY_PATTERN = /^[A-Z0-9_]{3,64}$/;
export const benchmarkKeySchema = z.string().regex(BENCHMARK_KEY_PATTERN);

const returnVariantSchema = z.enum(['price', 'total_return', 'net_total_return']);
const historyClassSchema = z.enum(['live', 'backtested', 'mixed', 'unknown']);

/** `params` part of POST .../upload. Mirrors StageUploadRequestParams (apiTypes.ts). */
export const stageParamsSchema = z
  .object({
    shape: z.enum(['single', 'multi', 'provider_export']),
    mode: z.enum(['new_history', 'correction']),
    benchmarkKey: benchmarkKeySchema.optional(),
    providerLayoutId: z.string().max(100).optional(),
    columnMap: z
      .object({ date: z.string().max(200).optional(), value: z.string().max(200).optional(), benchmarkKey: z.string().max(200).optional(), indexName: z.string().max(200).optional() })
      .strict()
      .optional(),
    indexNameToKey: z.record(z.string().max(200), benchmarkKeySchema).refine((r) => Object.keys(r).length <= 200, 'too many entries').optional(),
    returnVariant: returnVariantSchema,
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    historyClass: historyClassSchema,
    dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'DD MMM YYYY', 'excel_1900', 'excel_1904']),
    numberLocale: z.enum(['plain', 'en', 'in', 'eu']),
    sheetName: z.string().min(1).max(255).optional(),
    headerRow: z.number().int().min(1).max(1000).optional(),
    includeHiddenRows: z.boolean().optional(),
    sourceOwner: shortText(200).min(2),
    sourceReference: shortText(1000).min(5),
    originalFileName: z.string().max(255).optional(),
    dataAsOf: nullableDate,
    reason: z.string().trim().max(1000).nullable().optional(),
    entitlementIds: z.record(benchmarkKeySchema, uuidSchema).refine((r) => Object.keys(r).length <= 50, 'too many entries').optional(),
  })
  .strict()
  .refine((p) => p.mode !== 'correction' || (p.reason ?? '').trim().length >= 20, { message: 'A correction needs a reason of at least 20 characters.', path: ['reason'] });

export const publishBodySchema = z
  .object({
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    expectedDigest: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
    expectedCounts: z
      .object({ new: z.number().int().min(0).max(10_000_000), identical: z.number().int().min(0).max(10_000_000), correction: z.number().int().min(0).max(10_000_000) })
      .strict(),
    acknowledged: z.array(z.string().min(1).max(100)).max(50),
    selfPublishAck: z.boolean().optional(),
  })
  .strict();

export const rollbackBodySchema = z.object({ reason: z.string().trim().min(20).max(1000) }).strict();

export const catalogueBodySchema = z
  .object({
    benchmarkKey: benchmarkKeySchema,
    label: shortText(200).min(2).optional(),
    benchmarkCategory: z.enum(['index', 'category_average', 'custom']).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    returnType: z.enum(['TRI', 'PRI', 'DEBT_INDEX', 'COMMODITY_GOLD', 'OTHER']),
    returnVariant: returnVariantSchema,
    frequency: shortText(40).optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    officialName: shortText(300).min(2),
    ownerName: shortText(300).min(2),
    officialIdentifier: shortText(100).nullable().optional(),
    assetClass: z.enum(['equity', 'debt', 'hybrid', 'gold', 'silver', 'commodity', 'international_equity', 'money_market', 'other']),
    baseDate: nullableDate,
    baseValue: z.number().positive().max(1e12).nullable().optional(),
    launchDate: nullableDate,
    historyStartDate: nullableDate,
    historyClass: historyClassSchema.optional(),
    backtestedThrough: nullableDate,
    calendarCode: shortText(40).nullable().optional(),
    methodologyUrl: z.string().url().max(1000).nullable().optional(),
    sourceUrl: z.string().url().max(1000).nullable().optional(),
    evidenceRef: shortText(1000).min(5),
    evidenceRetrievedAt: isoDateString,
  })
  .strict();

export const noteBodySchema = z.object({ note: z.string().trim().min(10).max(1000) }).strict();

export const entitlementProposalSchema = z
  .object({
    benchmarkId: uuidSchema,
    sourceId: uuidSchema.nullable().optional(),
    kind: z.enum(['public_use_permission', 'commercial_licence']),
    returnVariant: returnVariantSchema,
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    rights: z
      .object({
        ingestManual: boolDefaultFalse,
        automation: boolDefaultFalse,
        storage: boolDefaultFalse,
        calculation: boolDefaultFalse,
        customerDisplay: boolDefaultFalse,
        reportExport: boolDefaultFalse,
      })
      .strict(),
    dataFrom: nullableDate,
    dataTo: nullableDate,
    validFrom: isoDateString,
    validTo: nullableDate,
    postExpiryStorage: z.enum(['retain', 'delete', 'unknown']).optional(),
    postExpiryCalculation: z.boolean().optional(),
    postExpiryDisplay: z.boolean().optional(),
    evidenceReference: shortText(1000).min(5),
    evidenceUrl: z.string().url().max(1000).nullable().optional(),
    evidenceDocumentDate: nullableDate,
    evidenceRetrievedAt: nullableDate,
    attributionText: shortText(500).nullable().optional(),
    notes: shortText(2000).nullable().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // Mirrors the database CHECK constraints so an obviously invalid proposal is refused early (the database still enforces them).
    if (p.kind === 'public_use_permission' && (!p.evidenceUrl || !p.evidenceDocumentDate || !p.evidenceRetrievedAt)) {
      ctx.addIssue({ code: 'custom', path: ['evidenceUrl'], message: 'A public-use permission needs a document URL, the document date and the retrieval date.' });
    }
    const r = p.rights;
    if ((r.calculation && !r.storage) || (r.customerDisplay && !r.calculation) || (r.reportExport && !r.customerDisplay) || (r.automation && !r.storage) || (r.ingestManual && !r.storage)) {
      ctx.addIssue({ code: 'custom', path: ['rights'], message: 'Rights must be coherent: ingestion, automation and calculation need storage; display needs calculation; export needs display.' });
    }
    if (p.validTo && p.validTo < p.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'validTo is before validFrom.' });
    if (p.dataFrom && p.dataTo && p.dataTo < p.dataFrom) ctx.addIssue({ code: 'custom', path: ['dataTo'], message: 'dataTo is before dataFrom.' });
  });

export const entitlementApproveSchema = z.object({ note: z.string().trim().min(10).max(1000), selfApprovalAck: z.boolean().optional() }).strict();
export const entitlementRevokeSchema = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

export const mappingProposalSchema = z
  .object({
    instrumentId: uuidSchema,
    benchmarkId: uuidSchema.nullable().optional(),
    proposedBenchmarkName: shortText(300).min(2),
    relationshipType: z.enum(['primary', 'secondary', 'category_average']).optional(),
    effectiveFrom: isoDateString,
    effectiveTo: nullableDate,
    evidenceSource: z.enum(['amc_sid', 'amc_kim', 'amc_factsheet', 'amc_addendum', 'amfi_disclosure', 'other']),
    evidenceUrl: z.string().url().min(8).max(1000),
    evidenceTitle: shortText(300).nullable().optional(),
    evidenceDocumentDate: isoDateString,
    evidenceRetrievedAt: isoDateString,
    evidenceExcerpt: z.string().trim().max(400).nullable().optional(),
    resolutionMethod: z.enum(['deterministic_exact', 'identifier_match', 'admin_judgement']),
    confidence: z.enum(['high', 'medium', 'low']),
    ambiguityReason: shortText(500).nullable().optional(),
  })
  .strict()
  .refine((p) => !p.effectiveTo || p.effectiveTo >= p.effectiveFrom, { message: 'effectiveTo is before effectiveFrom.', path: ['effectiveTo'] });

export const mappingReviewSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(10).max(1000), closePrevious: z.boolean().optional() }).strict();

export const ingestionModeSchema = z
  .object({
    mode: z.enum(['disabled', 'manual_import', 'automated']),
    sourceKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).nullable().optional(),
    adapterId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).nullable().optional(),
    automationEnabled: z.boolean(),
    publicationLagDays: z.number().int().min(0).max(30).optional(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict()
  .refine((b) => !b.automationEnabled || b.mode === 'automated', { message: 'Automation can only be enabled in automated mode.', path: ['automationEnabled'] });

// ------------------------------------------------------------------ mappers ---

export const CATALOGUE_COLUMNS =
  'id, benchmark_key, benchmark_label, official_name, owner_name, official_identifier, asset_class, return_type, return_variant, currency_code, country_code, base_date, launch_date, history_start_date, history_class, backtested_through, methodology_url, source_url, evidence_ref, evidence_retrieved_at, catalogue_status, lifecycle_status, licence_status';

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function toCatalogueRowView(r: Row): CatalogueRowView {
  return {
    id: r.id as string,
    benchmarkKey: r.benchmark_key as string,
    label: (r.benchmark_label as string) ?? (r.benchmark_key as string),
    officialName: s(r.official_name),
    ownerName: s(r.owner_name),
    officialIdentifier: s(r.official_identifier),
    assetClass: s(r.asset_class),
    returnType: s(r.return_type),
    returnVariant: s(r.return_variant) as CatalogueRowView['returnVariant'],
    currencyCode: r.currency_code ? String(r.currency_code).trim() : null,
    countryCode: r.country_code ? String(r.country_code).trim() : null,
    baseDate: s(r.base_date),
    launchDate: s(r.launch_date),
    historyStartDate: s(r.history_start_date),
    historyClass: ((r.history_class as string) ?? 'unknown') as CatalogueRowView['historyClass'],
    backtestedThrough: s(r.backtested_through),
    methodologyUrl: s(r.methodology_url),
    sourceUrl: s(r.source_url),
    evidenceRef: s(r.evidence_ref),
    evidenceRetrievedAt: s(r.evidence_retrieved_at),
    catalogueStatus: ((r.catalogue_status as string) ?? 'draft') as CatalogueRowView['catalogueStatus'],
    lifecycleStatus: (r.lifecycle_status as string) ?? 'active',
    licenceStatusSummary: (r.licence_status as string) ?? 'unknown',
  };
}

export const ENTITLEMENT_VIEW_COLUMNS =
  'id, benchmark_id, entitlement_kind, status, return_variant, currency_code, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, post_expiry_calculation, post_expiry_display, evidence_reference, evidence_url, created_by, approved_at';

/** Another admin's identifier is never returned (Standard section 9): only `proposedByMe`. */
export function toEntitlementRightsView(r: Row, userId: string): EntitlementRightsView {
  return {
    entitlementId: r.id as string,
    kind: r.entitlement_kind as EntitlementRightsView['kind'],
    status: r.status as EntitlementRightsView['status'],
    rights: {
      ingestManual: r.allow_manual_ingest === true,
      automation: r.allow_automation === true,
      storage: r.allow_storage === true,
      calculation: r.allow_calculation === true,
      customerDisplay: r.allow_customer_display === true,
      reportExport: r.allow_report_export === true,
    },
    dataFrom: s(r.data_from),
    dataTo: s(r.data_to),
    validFrom: r.valid_from as string,
    validTo: s(r.valid_to),
    postExpiryStorage: ((r.post_expiry_storage as string) ?? 'unknown') as EntitlementRightsView['postExpiryStorage'],
    evidenceReference: r.evidence_reference as string,
    evidenceUrl: s(r.evidence_url),
    proposedByMe: r.created_by === userId,
    approvedAt: s(r.approved_at),
  };
}

export { toEntitlementRecord };

export const MAPPING_COLUMNS =
  'id, instrument_id, benchmark_id, proposed_benchmark_name, relationship_type, effective_from, effective_to, evidence_source, evidence_url, evidence_title, evidence_document_date, evidence_retrieved_at, evidence_excerpt, resolution_method, confidence, ambiguity_reason, status, auto_published, review_note';

export function toMappingProposalView(r: Row, instrumentName: string | null, benchmarkKey: string | null): MappingProposalView {
  return {
    id: r.id as string,
    instrumentId: r.instrument_id as string,
    instrumentName,
    benchmarkKey,
    proposedBenchmarkName: r.proposed_benchmark_name as string,
    relationshipType: r.relationship_type as MappingProposalView['relationshipType'],
    effectiveFrom: r.effective_from as string,
    effectiveTo: s(r.effective_to),
    evidenceSource: r.evidence_source as string,
    evidenceUrl: r.evidence_url as string,
    evidenceTitle: s(r.evidence_title),
    evidenceDocumentDate: r.evidence_document_date as string,
    evidenceRetrievedAt: r.evidence_retrieved_at as string,
    evidenceExcerpt: s(r.evidence_excerpt),
    resolutionMethod: r.resolution_method as string,
    confidence: r.confidence as string,
    ambiguityReason: s(r.ambiguity_reason),
    status: r.status as MappingProposalView['status'],
    autoPublished: r.auto_published === true,
    reviewNote: s(r.review_note),
  };
}

// ---------------------------------------------------------------- CSV output ---

/**
 * Safe CSV download (Standard section 11): attachment, no-store, nosniff.
 * The CALLER is responsible for neutralising cell contents (buildValidationErrorCsv and
 * the static templates already do); this only sets the transport headers.
 */
export function csvAttachment(csv: string, fileName: string): Response {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
