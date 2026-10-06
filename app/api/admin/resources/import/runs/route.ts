import { bad, ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { guardBulkImport } from '@/lib/resources/import/access';
import { listRuns, processUpload } from '@/lib/resources/import/staging';
import { IMPORT_LIMITS, isImportContentType } from '@/lib/resources/import/types';

export const dynamic = 'force-dynamic';

// GET /api/admin/resources/import/runs -- "Recent Imports" history (RLS: your own runs; Resource Admin and
// Super Admin see all). Compact: no row payloads.
export async function GET() {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  try {
    const runs = await listRuns(g.supabase, 25);
    return ok({ runs });
  } catch (err) {
    console.error('Resources import history error:', err);
    return bad('Could not load the import history.', 500);
  }
}

// POST /api/admin/resources/import/runs -- multipart: file + contentType (article | money_update).
// Upload -> detect selected type -> parse -> validate schema -> normalise -> resolve references (batched) ->
// stage -> preview. NOTHING is created here; Apply is a separate request.
//
// The screen's `contentType` decides the type. The browser's file name, MIME type, size and extension are never
// trusted: file-security.ts re-checks all of them on the bytes.
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
  const contentType = form.get('contentType');
  if (!isImportContentType(contentType)) return bad('Choose what you are uploading: Articles or Money Updates.', 400);
  const file = form.get('file');
  if (!(file instanceof File)) return bad('Choose a file to upload.', 400);
  if (file.size > IMPORT_LIMITS.maxFileBytes) return bad('The file is larger than 10 MB.', 413, 'FILE_TOO_LARGE');

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await processUpload({
      user: g.supabase,
      admin: createAdminClient(),
      userId: g.user.id,
      contentType,
      fileName: file.name,
      declaredMime: file.type || null,
      sheetName: typeof form.get('sheetName') === 'string' ? (form.get('sheetName') as string).slice(0, 120) : null,
      bytes,
    });
    if (result.status === 'rejected') {
      return Response.json({ error: result.fileIssues[0]?.message ?? 'This file could not be read.', code: result.fileIssues[0]?.code ?? 'FILE_PARSE_ERROR', data: result }, { status: 422 });
    }
    return ok(result);
  } catch (err) {
    console.error('Resources import upload error:', err);
    return bad('The upload could not be processed. Nothing was created.', 500);
  }
}
