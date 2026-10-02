// Market Index Data - inspect a file BEFORE staging (type, size, sheets). Persists nothing.
// Capability `upload`; caller's own session; no service-role client.
import { bad, ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { DEFAULT_LIMITS, inspectUpload, listWorkbookSheets } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { sha256Bytes } from '@/lib/services/investment-intelligence/benchmarkData/uploadService';
import { guarded } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

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
    return bad('Expected multipart/form-data with a file.', 422);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('A file is required.', 422);
  if (file.size > DEFAULT_LIMITS.maxBytes) return bad(`The file is larger than ${DEFAULT_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspected = inspectUpload({ fileName: file.name, declaredMime: file.type || null, bytes });
  const sheets = inspected.ok && inspected.kind === 'xlsx' ? listWorkbookSheets(bytes) : null;
  return ok({ kind: inspected.kind, ok: inspected.ok, problems: inspected.problems, sheets: sheets?.sheets, date1904: sheets?.date1904, fileSha256: sha256Bytes(bytes), bytes: bytes.byteLength });
});
