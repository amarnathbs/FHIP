import { ReportExportError } from '@/lib/services/reportExportFailure';

/**
 * Loads the headless-browser renderer on demand, never at route load.
 *
 * reportPdfRenderer.ts imports `playwright` at its top level. When the route imported that file statically, a server
 * where the package cannot be resolved (a bundled external whose symlink target does not exist at runtime) failed while
 * LOADING the route, before any handler code ran, so no try/catch could answer and the platform sent its bare
 * "Internal Server Error". Importing it here, inside a function, turns that into a catchable, typed failure.
 */
export type ReportPdfRendererModule = typeof import('@/lib/services/reportPdfRenderer');

export async function loadReportPdfRenderer(): Promise<ReportPdfRendererModule> {
  try {
    return await import('@/lib/services/reportPdfRenderer');
  } catch (e) {
    throw new ReportExportError('renderer_unavailable', `renderer module could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
}
