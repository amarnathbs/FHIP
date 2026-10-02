// Shared helpers for the Market Index Data Admin API routes. Every route is thin:
// guard (capability, FIRST) -> validate -> one service/RPC call under the
// CALLER'S session client -> typed response. The service-role client is never
// imported by any route file (a static test enforces this).
import { z } from 'zod';
import { bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { requireBenchmarkCapability, type BenchmarkCapability } from './guards';
import { mapRpcError } from './publishService';

export const UuidSchema = z.string().uuid();

export const VariantSchema = z.enum(['price', 'total_return', 'net_total_return']);

export function rpcFailureResponse(error: { code?: string; message?: string }): Response {
  const f = mapRpcError(error);
  return Response.json({ error: f.message, code: f.kind }, { status: f.httpStatus });
}

export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || error.code === 'PGRST202' || /does not exist|schema cache|Could not find the function/i.test(error.message ?? '')));
}

export async function guarded(cap: BenchmarkCapability) {
  const r = await requireBenchmarkCapability(cap);
  if (r.forbidden || !r.user) return { ok: false as const, response: r.forbidden ?? bad('unauthenticated', 401) };
  return { ok: true as const, user: r.user, flags: r.flags, supabase: await createClient() };
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: badValidation(parsed.error, 422) };
  return { ok: true, data: parsed.data };
}

export async function idParam(params: Promise<{ id: string }>): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const { id } = await params;
  const p = UuidSchema.safeParse(id);
  return p.success ? { ok: true, id: p.data } : { ok: false, response: bad('Invalid id', 422) };
}

export const csvResponse = (body: string, filename: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

const KEY = /^[A-Z0-9_]{3,64}$/;

export const CatalogueBody = z.object({
  benchmark_key: z.string().regex(KEY),
  official_name: z.string().min(2).max(200),
  benchmark_label: z.string().min(2).max(200).optional(),
  owner_name: z.string().min(2).max(200),
  official_identifier: z.string().max(100).nullish(),
  asset_class: z.enum(['equity', 'debt', 'hybrid', 'gold', 'silver', 'commodity', 'international_equity', 'money_market', 'other']),
  country_code: z.string().length(2).nullish(),
  currency_code: z.string().length(3),
  return_type: z.enum(['TRI', 'PRI', 'DEBT_INDEX', 'COMMODITY_GOLD', 'OTHER']).nullish(),
  return_variant: VariantSchema,
  base_date: z.string().date().nullish(),
  base_value: z.number().positive().nullish(),
  launch_date: z.string().date().nullish(),
  history_start_date: z.string().date().nullish(),
  history_class: z.enum(['live', 'backtested', 'mixed', 'unknown']).default('unknown'),
  backtested_through: z.string().date().nullish(),
  calendar_code: z.string().max(40).nullish(),
  methodology_url: z.string().url().max(500).nullish(),
  source_url: z.string().url().max(500).nullish(),
  evidence_ref: z.string().min(5).max(500),
  evidence_retrieved_at: z.string().date(),
  frequency: z.enum(['daily', 'business_daily', 'monthly']).optional(),
  benchmark_category: z.enum(['index', 'category_average', 'custom']).optional(),
});

export const EntitlementBody = z.object({
  benchmark_id: UuidSchema,
  source_id: UuidSchema.nullish(),
  entitlement_kind: z.enum(['public_use_permission', 'commercial_licence']),
  return_variant: VariantSchema,
  currency_code: z.string().length(3),
  allow_manual_ingest: z.boolean().default(false),
  allow_automation: z.boolean().default(false),
  allow_storage: z.boolean().default(false),
  allow_calculation: z.boolean().default(false),
  allow_customer_display: z.boolean().default(false),
  allow_report_export: z.boolean().default(false),
  data_from: z.string().date().nullish(),
  data_to: z.string().date().nullish(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullish(),
  post_expiry_storage: z.enum(['retain', 'delete', 'unknown']).default('unknown'),
  post_expiry_calculation: z.boolean().default(false),
  post_expiry_display: z.boolean().default(false),
  evidence_reference: z.string().min(5).max(500),
  evidence_url: z.string().url().max(500).nullish(),
  evidence_document_date: z.string().date().nullish(),
  evidence_retrieved_at: z.string().date().nullish(),
  attribution_text: z.string().max(500).nullish(),
  notes: z.string().max(1000).nullish(),
});

export const MappingBody = z.object({
  instrument_id: UuidSchema,
  benchmark_id: UuidSchema.nullish(),
  proposed_benchmark_name: z.string().min(2).max(200),
  relationship_type: z.enum(['primary', 'secondary', 'category_average']).default('primary'),
  effective_from: z.string().date(),
  effective_to: z.string().date().nullish(),
  evidence_source: z.enum(['amc_sid', 'amc_kim', 'amc_factsheet', 'amc_addendum', 'amfi_disclosure', 'other']),
  evidence_url: z.string().url().max(500),
  evidence_title: z.string().max(300).nullish(),
  evidence_document_date: z.string().date(),
  evidence_retrieved_at: z.string().date(),
  evidence_excerpt: z.string().max(400).nullish(),
  resolution_method: z.enum(['deterministic_exact', 'identifier_match', 'admin_judgement']),
  confidence: z.enum(['high', 'medium', 'low']),
  ambiguity_reason: z.string().max(400).nullish(),
});

export const PublishBody = z.object({
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expectedCounts: z.object({ new: z.number().int().min(0), identical: z.number().int().min(0), correction: z.number().int().min(0) }),
  acknowledged: z.array(z.string().max(40)).max(10).default([]),
  selfPublishAck: z.boolean().optional(),
});

export const StageParams = z
  .object({
    shape: z.enum(['single', 'multi', 'provider_export']),
    mode: z.enum(['new_history', 'correction']),
    benchmarkKey: z.string().regex(KEY).optional(),
    providerLayoutId: z.string().max(60).optional(),
    columnMap: z.object({ date: z.string().max(100).optional(), value: z.string().max(100).optional(), benchmarkKey: z.string().max(100).optional(), indexName: z.string().max(100).optional() }).optional(),
    indexNameToKey: z.record(z.string().max(200), z.string().regex(KEY)).optional(),
    returnVariant: VariantSchema,
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    historyClass: z.enum(['live', 'backtested', 'mixed', 'unknown']),
    dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'DD MMM YYYY', 'excel_1900', 'excel_1904']),
    numberLocale: z.enum(['plain', 'en', 'in', 'eu']),
    sheetName: z.string().max(100).optional(),
    headerRow: z.number().int().min(1).max(1000).optional(),
    includeHiddenRows: z.boolean().optional(),
    sourceOwner: z.string().min(2).max(200),
    sourceReference: z.string().min(5).max(500),
    originalFileName: z.string().max(255).optional(),
    dataAsOf: z.string().date().nullish(),
    reason: z.string().max(1000).nullish(),
    entitlementIds: z.record(z.string(), UuidSchema).optional(),
  })
  .refine((v) => v.mode !== 'correction' || (v.reason ?? '').trim().length >= 20, { message: 'A correction needs a reason of at least 20 characters.', path: ['reason'] });
