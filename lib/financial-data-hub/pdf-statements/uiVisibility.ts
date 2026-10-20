/**
 * PDF statement routes: what the SCREEN says follows the per-class switch (presentation only).
 *
 * The switches in `./flags.ts` are server-side environment variables and must never reach the client bundle. The signed-in
 * `GET /api/financial-data-hub/upload-status` read returns one boolean per class (`data.pdf_routes`), and a panel feeds that
 * body through `parsePdfRouteVisible`. This module is pure and client-safe: it reads NO environment.
 *
 * Fail closed: anything other than the literal boolean `true` for that class (not asked yet, a failed request, a missing or
 * malformed field) is "not visible", so the screen says CSV only and the file chooser does not offer a PDF. Nothing here
 * authorises anything: the upload route refuses a PDF while its switch is off, whatever this said.
 */
import type { PdfStatementClass } from './flags';

export type PdfRouteVisibility = Record<PdfStatementClass, boolean>;

/** The server side of the contract: the body field name, so the route and the panels cannot drift apart. */
export const PDF_ROUTES_FIELD = 'pdf_routes' as const;

export function parsePdfRouteVisible(json: unknown, cls: PdfStatementClass): boolean {
  const routes = (json as { data?: { pdf_routes?: unknown } } | null | undefined)?.data?.pdf_routes;
  if (routes === null || typeof routes !== 'object') return false;
  return (routes as Record<string, unknown>)[cls] === true;
}

/** The file chooser's `accept` attribute: a PDF is offered only when that class's route is on. */
export function statementFileAccept(cls: PdfStatementClass, pdfRouteEnabled: boolean): string {
  if (cls === 'retirement') return pdfRouteEnabled ? 'application/pdf,.pdf,.csv,text/csv' : '.csv,text/csv';
  return pdfRouteEnabled ? 'application/pdf,.pdf,text/csv,.csv' : 'text/csv,.csv';
}

export function statementFileLabel(pdfRouteEnabled: boolean): string {
  return pdfRouteEnabled ? 'Statement file (PDF or CSV)' : 'Statement file (CSV)';
}
