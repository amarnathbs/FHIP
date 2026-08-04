export type ExportFormat = 'pdf' | 'print' | 'csv';

// Print and PDF are both real (PDF via lib/services/reportPdfRenderer.ts,
// a headless-Chromium render of the report's own print view). CSV has no
// renderer yet and stays feature-gated (spec section 5.2/15.2). Kept as a
// pure decision so export requests can be tested without a live renderer
// (Persona I).
export function isExportFormatImplemented(format: ExportFormat): boolean {
  return format === 'print' || format === 'pdf';
}

export function requiresPremiumEntitlement(format: ExportFormat): boolean {
  return format !== 'print';
}
