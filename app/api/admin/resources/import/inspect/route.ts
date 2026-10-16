import { bad, ok } from '@/lib/api';
import { guardBulkImport } from '@/lib/resources/import/access';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { listUploadSheets, sha256Hex } from '@/lib/resources/import/file-security';
import { IMPORT_LIMITS, isImportContentType } from '@/lib/resources/import/types';

export const dynamic = 'force-dynamic';

// POST /api/admin/resources/import/inspect -- the shared ingest convention's first step: check the file safely and, for
// a workbook, list its sheets so the person can CHOOSE the one to import (the server never picks one silently). Persists
// nothing and creates nothing. Same capability and same server-side file checks as the upload itself.
export async function POST(request: Request) {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > IMPORT_LIMITS.maxFileBytes + 256 * 1024) return bad('The file is larger than 10 MB.', 413, 'FILE_TOO_LARGE');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad('Expected a multipart upload with a file.', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('Choose a file to upload.', 400);
  if (file.size > IMPORT_LIMITS.maxFileBytes) return bad('The file is larger than 10 MB.', 413, 'FILE_TOO_LARGE');
  const type = form.get('contentType');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const listing = listUploadSheets({ fileName: file.name, declaredMime: file.type || null, bytes });
    if (!listing.ok) return Response.json({ error: listing.issues[0]?.message ?? 'This file could not be read.', code: listing.issues[0]?.code ?? 'INVALID_FILE_TYPE', issues: listing.issues }, { status: 422 });
    if (listing.kind === 'csv') return ok({ kind: 'csv', fileSha256: sha256Hex(bytes) });
    const preferred = isImportContentType(type) ? getImportAdapter(type).schema.uploadSheetName.toLowerCase() : null;
    const preselect = listing.sheets.find((s) => s.name.trim().toLowerCase() === preferred)?.name ?? null;
    return ok({ kind: 'xlsx', fileSha256: sha256Hex(bytes), sheets: listing.sheets.map((s) => ({ name: s.name, state: s.state, rowCount: s.rowCount })), preselect });
  } catch (err) {
    console.error('Resources import inspect error:', err);
    return bad('The file could not be inspected.', 500);
  }
}
