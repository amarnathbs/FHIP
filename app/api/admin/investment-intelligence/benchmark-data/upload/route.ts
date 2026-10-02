// Benchmark Data - stage + validate an upload (CSV / XLSX).
//
// ADMIN ARCHITECTURE STANDARD. Capability `upload` (admin_users.can_upload_market_index_data,
// enforced again in the database by create_benchmark_import_job / stage / finalize). Runs under
// the CALLER'S session client; the service-role client is never used here. Persists only the
// validated, normalised rows + checksum (never the raw file). Publication is a separate,
// separately-permissioned step. Section 9: global reference data only, no user data.
import { bad } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { DEFAULT_LIMITS } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { stageBenchmarkUpload } from '@/lib/services/investment-intelligence/benchmarkData/uploadService';
import { guarded, StageParams } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { badValidation } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('upload');
  if (!g.ok) return g.response;

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > DEFAULT_LIMITS.maxBytes + 64 * 1024) return bad(`The file is larger than ${DEFAULT_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad('Expected multipart/form-data with a file and params.', 422);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('A file is required.', 422);
  if (file.size > DEFAULT_LIMITS.maxBytes) return bad(`The file is larger than ${DEFAULT_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  let rawParams: unknown;
  try {
    rawParams = JSON.parse(String(form.get('params') ?? ''));
  } catch {
    return bad('params must be valid JSON.', 422);
  }
  const parsed = StageParams.safeParse(rawParams);
  if (!parsed.success) return badValidation(parsed.error, 422);
  const p = parsed.data;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const outcome = await stageBenchmarkUpload(g.supabase, {
    fileName: file.name,
    declaredMime: file.type || null,
    bytes,
    todayIso: new Date().toISOString().slice(0, 10),
    params: {
      shape: p.shape,
      mode: p.mode,
      benchmarkKey: p.benchmarkKey,
      providerLayoutId: p.providerLayoutId,
      columnMap: p.columnMap,
      indexNameToKey: p.indexNameToKey,
      returnVariant: p.returnVariant,
      currencyCode: p.currencyCode,
      historyClass: p.historyClass,
      dateFormat: p.dateFormat,
      numberLocale: p.numberLocale,
      sheetName: p.sheetName,
      headerRow: p.headerRow,
      includeHiddenRows: p.includeHiddenRows,
    },
    meta: { sourceOwner: p.sourceOwner, sourceReference: p.sourceReference, originalFileName: p.originalFileName ?? file.name, dataAsOf: p.dataAsOf ?? null, reason: p.reason ?? null, entitlementIds: p.entitlementIds },
  });
  // A validation rejection is a normal, displayable outcome (200 with status 'rejected'); auth/size/body errors above are real HTTP errors.
  return Response.json({ data: outcome });
});
