// Planning Benchmarks - staged upload: status/history (GET) and stage a file (POST). Finding F5.
//
// ADMIN ARCHITECTURE STANDARD - applicability, stated:
//   Capabilities : planningBenchmarkUpload (admin_users.can_upload_planning_benchmarks) for POST, and
//                  view = upload OR activate for GET. Separately named (migration 0270); NOT implied by
//                  Super Admin or by any Market Index capability (section 2).
//   Four layers  : (1) DB   - stage_planning_benchmark_upload checks auth.uid() and the capability itself,
//                             RLS on the three tables;
//                  (2) API  - requireAdmin() then the capability guard below, on EVERY verb, before the body;
//                  (3) page - /admin/benchmarks/upload redirects a caller without the capability;
//                  (4) nav  - the Upload tab follows /api/admin/me flags (UX only).
//   Denial       : explicit 401 / 403 (503 when the feature or the permission read is unavailable), never a
//                  200 with an empty body (section 4, 13).
//   Section 9    : global reference data only, no user data. The history returns only whether a batch was
//                  staged by the caller, never another admin's identifier.
//   Section 11   : no export of stored data. Runs under the CALLER'S session client; the service-role
//                  client is deliberately not used anywhere in this file.
import { z } from 'zod';
import { bad, badValidation, ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { stagePlanningBenchmarkUpload } from '@/lib/planning-benchmarks/uploadService';
import { KIND_LABEL, KIND_PURPOSE, TEMPLATE_VERSION, UPLOAD_KINDS, UPLOAD_LIMITS, UPLOAD_RULES } from '@/lib/planning-benchmarks/uploadSchema';
import { todayIsoUtc } from '@/lib/planning-benchmarks/dates';

export const dynamic = 'force-dynamic';

const UNAVAILABLE = 'Migration 0270 has not been applied to this database, so the upload tables do not exist yet. This is reported as unavailable, not as an empty healthy state.';

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || /does not exist|schema cache/i.test(error.message ?? '')));
}

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;

  const { data, error } = await g.supabase
    .from('benchmark_upload_batches')
    .select('id, kind, dataset_name, dataset_version, file_name, status, row_count, counts, staged_by, staged_at, expires_at, activated_at, self_activated, discarded_at')
    .order('staged_at', { ascending: false })
    .limit(30);
  if (error) {
    if (isMissingRelation(error)) return ok({ state: 'unavailable', reason: UNAVAILABLE });
    return Response.json({ error: 'The upload history could not be read. Nothing was changed.', code: 'DEPENDENCY_UNAVAILABLE' }, { status: 503 });
  }
  return ok({
    state: 'ok',
    capabilities: { upload: g.flags.upload, activate: g.flags.activate },
    limits: { maxBytes: UPLOAD_LIMITS.maxBytes, maxRows: UPLOAD_LIMITS.maxRows },
    kinds: UPLOAD_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k], purpose: KIND_PURPOSE[k], templateVersion: TEMPLATE_VERSION[k] })),
    rules: UPLOAD_RULES,
    batches: (data ?? []).map((b) => {
      const { staged_by, ...rest } = b as Record<string, unknown> & { staged_by: string | null };
      // Section 9: another admin's identifier is never returned.
      return { ...rest, stagedByMe: staged_by === g.user.id };
    }),
  });
});

const Params = z.object({
  kind: z.enum(UPLOAD_KINDS),
  sheetName: z.string().min(1).max(100).optional(),
  includeHiddenRows: z.boolean().optional(),
});

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('upload');
  if (!g.ok) return g.response;

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > UPLOAD_LIMITS.maxBytes + 64 * 1024) return bad(`The file is larger than ${UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad('Expected multipart/form-data with a file and params.', 422);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('A file is required.', 422);
  if (file.size > UPLOAD_LIMITS.maxBytes) return bad(`The file is larger than ${UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  let rawParams: unknown;
  try {
    rawParams = JSON.parse(String(form.get('params') ?? ''));
  } catch {
    return bad('params must be valid JSON.', 422);
  }
  const parsed = Params.safeParse(rawParams);
  if (!parsed.success) return badValidation(parsed.error, 422);

  const bytes = new Uint8Array(await file.arrayBuffer());
  return failClosed(
    () =>
      stagePlanningBenchmarkUpload(g.supabase, {
        fileName: file.name,
        declaredMime: file.type || null,
        bytes,
        kind: parsed.data.kind,
        sheetName: parsed.data.sheetName,
        includeHiddenRows: parsed.data.includeHiddenRows,
        todayIso: todayIsoUtc(),
      }),
    // A validation rejection or a sheet request is a normal, displayable outcome (200 with a status);
    // authorisation, size and body errors above are real HTTP errors.
    (outcome) => Response.json({ data: outcome })
  );
});
