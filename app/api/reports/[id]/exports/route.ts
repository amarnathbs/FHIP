import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { canExportReports } from '@/lib/services/entitlements';
import { isExportFormatImplemented, requiresPremiumEntitlement, type ExportFormat } from '@/lib/engines/reportExport';
import { newCorrelationId, typedError } from '@/lib/services/reportApiResponses';
import { loadReportPdfRenderer } from '@/lib/services/reportPdfRendererLoader';
import {
  EXPORT_DEADLINE_MS,
  REPORT_EXPORT_FAILURES,
  ReportExportError,
  classifyRenderFailure,
  isReportExportError,
  withExportDeadline,
  type ReportExportStep,
} from '@/lib/services/reportExportFailure';

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
//
// 17-10-2026 (production): this route answered a bare 21-byte "Internal Server Error". The renderer, and with it the
// `playwright` package, used to be imported at the top of this file, so a server that could not load it failed while
// LOADING the route -- before any handler or try/catch could run. The renderer is now imported on demand
// (reportPdfRendererLoader.ts) inside the handler. EVERY failure below is typed JSON with a stable `code`, a
// correlation id and a short safe reason code in `detail` (renderer_unavailable, token_failed, render_timeout,
// render_failed, storage_failed, record_failed, entitlement); the underlying message goes to the server log only.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = newCorrelationId();
  try {
    return await handleExportPost(req, params, correlationId);
  } catch (e) {
    // Nothing may escape as an empty or plain-text body: an unexpected throw is a typed JSON answer with a reference.
    const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    if (isReportExportError(e)) {
      console.error('[reports] export failed', { correlationId, step: e.step, message });
      return exportFailureResponse(e.step, correlationId);
    }
    console.error('[reports] export failed unexpectedly', { correlationId, message });
    return typedError(500, 'EXPORT_FAILED', 'The export could not be prepared just now. You can still view this report and use Print, then choose Save as PDF.', correlationId, true, 'unexpected');
  }
}

function exportFailureResponse(step: ReportExportStep, correlationId: string, detailOverride?: string): Response {
  const spec = REPORT_EXPORT_FAILURES[step];
  return typedError(spec.status, spec.code, spec.message, correlationId, spec.retryable, detailOverride ?? step);
}

async function handleExportPost(req: Request, params: Promise<{ id: string }>, correlationId: string): Promise<Response> {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  const format = body?.format as ExportFormat | undefined;
  if (!format || !['pdf', 'print', 'csv'].includes(format)) return typedError(422, 'EXPORT_FORMAT_INVALID', 'Invalid export format.', correlationId, false, 'format');

  const supabase = await createClient();

  if (requiresPremiumEntitlement(format) && !(await canExportReports(user.id, supabase))) {
    return typedError(403, 'EXPORT_PREMIUM_REQUIRED', 'Exporting reports requires a premium plan. You can still view and print this report.', correlationId, false, 'entitlement');
  }

  // Ownership check before any write — report_exports grants SELECT-own
  // only as of migration 0070, so the insert below must go through the
  // admin client; this explicit check replaces what the RLS WITH CHECK used
  // to enforce.
  const { data: ownedReport } = await supabase.from('reports').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!ownedReport) return typedError(404, 'REPORT_NOT_FOUND', 'That report could not be found.', correlationId, false, 'not_found');

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
  if (insertError || !exportRow) {
    console.error('[reports] export record could not be written', { correlationId, reportId: id, message: (insertError?.message ?? 'no row returned').slice(0, 300) });
    return exportFailureResponse('record_failed', correlationId);
  }
  if (!isImplemented) return ok(exportRow);

  let step: ReportExportStep = 'render_failed';
  try {
    const deadlineAt = Date.now() + EXPORT_DEADLINE_MS;
    const { buffer, checksum } = await withExportDeadline(
      (async () => {
        const { renderReportToPdf } = await loadReportPdfRenderer();
        return renderReportToPdf(id, exportRow.id, deadlineAt);
      })()
    );
    const fileName = `${id}.pdf`;
    const storagePath = `${user.id}/${id}/${exportRow.id}.pdf`;
    step = 'storage_failed';
    const { error: uploadError } = await admin.storage
      .from('report-exports')
      .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) throw new ReportExportError('storage_failed', uploadError.message);

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
    if (updateError) throw new ReportExportError('storage_failed', updateError.message);
    return ok(updated);
  } catch (err) {
    const failedStep = isReportExportError(err) ? err.step : step === 'storage_failed' ? 'storage_failed' : classifyRenderFailure(err);
    const message = err instanceof Error ? err.message : 'PDF rendering failed';
    // Best effort: a failure to record the failure must not replace the typed answer.
    try {
      await admin
        .from('report_exports')
        .update({ status: 'failed', error_code: failedStep, completed_at: new Date().toISOString() })
        .eq('id', exportRow.id);
    } catch {
      /* logged below with the original cause */
    }
    console.error('[reports] pdf render failed', { correlationId, reportId: id, exportId: exportRow.id, step: failedStep, message: message.slice(0, 300) });
    return exportFailureResponse(failedStep, correlationId);
  }
}
