import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { canExportReports } from '@/lib/services/entitlements';
import { isExportFormatImplemented, requiresPremiumEntitlement, type ExportFormat } from '@/lib/engines/reportExport';
import { renderReportToPdf } from '@/lib/services/reportPdfRenderer';
import { newCorrelationId, typedError } from '@/lib/services/reportApiResponses';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('report_exports').select('*').eq('report_id', id).eq('requested_by_user_id', user.id).order('requested_at', { ascending: false });
  if (error) {
    const correlationId = newCorrelationId();
    console.error('[reports] export list failed', { correlationId, reportId: id, message: error.message });
    return typedError(500, 'EXPORT_LIST_FAILED', 'The list of exports could not be read just now. Please try again.', correlationId, true);
  }
  return ok(data);
}

// PDF is a real, server-rendered export (see lib/services/reportPdfRenderer.ts,
// which drives a headless Chromium against this report's own print view).
// CSV has no renderer yet — recorded honestly as failed rather than faking a
// working pipeline. The in-app report and browser print stylesheet remain
// fully functional regardless (Persona I).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = newCorrelationId();
  try {
    return await handleExportPost(req, params, correlationId);
  } catch (e) {
    // Nothing may escape as an empty body: an unexpected throw is a typed JSON answer with a reference.
    console.error('[reports] export failed unexpectedly', { correlationId, message: e instanceof Error ? e.message : String(e) });
    return typedError(500, 'EXPORT_FAILED', 'The export could not be prepared just now. You can still view and print this report. Please try again later.', correlationId, true, e instanceof Error ? e.message : undefined);
  }
}

async function handleExportPost(req: Request, params: Promise<{ id: string }>, correlationId: string): Promise<Response> {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  const format = body?.format as ExportFormat | undefined;
  if (!format || !['pdf', 'print', 'csv'].includes(format)) return bad('Invalid export format', 422);

  const supabase = await createClient();

  if (requiresPremiumEntitlement(format) && !(await canExportReports(user.id, supabase))) {
    return bad('Exporting reports requires a premium plan. You can still view and print this report.', 403);
  }

  // Ownership check before any write — report_exports grants SELECT-own
  // only as of migration 0070, so the insert below must go through the
  // admin client; this explicit check replaces what the RLS WITH CHECK used
  // to enforce.
  const { data: ownedReport } = await supabase.from('reports').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!ownedReport) return bad('Report not found', 404);

  const isImplemented = isExportFormatImplemented(format);

  // Admin client for every write from here on: the render+upload step
  // already needed it (the headless renderer authorizes itself via
  // render_token, no user session), and migration 0070 now requires it for
  // the initial insert too.
  const admin = createAdminClient();
  const { data: exportRow, error: insertError } = await admin
    .from('report_exports')
    .insert({
      report_id: id,
      requested_by_user_id: user.id,
      export_format: format,
      status: isImplemented ? 'generating' : 'failed',
      error_code: isImplemented ? null : 'not_implemented',
      ...(isImplemented ? {} : { completed_at: new Date().toISOString() }),
    })
    .select('*')
    .single();
  if (insertError) return bad(insertError.message);
  if (!isImplemented) return ok(exportRow);

  try {
    const { buffer, checksum } = await renderReportToPdf(id, exportRow.id);
    const fileName = `${id}.pdf`;
    const storagePath = `${user.id}/${id}/${exportRow.id}.pdf`;
    const { error: uploadError } = await admin.storage
      .from('report-exports')
      .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    const { data: updated, error: updateError } = await admin
      .from('report_exports')
      .update({
        status: 'ready',
        storage_path: storagePath,
        file_name: fileName,
        file_size_bytes: buffer.byteLength,
        checksum,
        renderer_version: 'playwright-chromium-1.62.0',
        completed_at: new Date().toISOString(),
      })
      .eq('id', exportRow.id)
      .select('*')
      .single();
    if (updateError) throw new Error(updateError.message);
    return ok(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PDF rendering failed';
    await admin
      .from('report_exports')
      .update({ status: 'failed', error_code: 'render_failed', completed_at: new Date().toISOString() })
      .eq('id', exportRow.id);
    console.error('[reports] pdf render failed', { correlationId, reportId: id, exportId: exportRow.id, message: message.slice(0, 300) });
    return typedError(500, 'EXPORT_RENDER_FAILED', 'The PDF could not be produced just now. You can still view and print this report in your browser.', correlationId, true, message);
  }
}
