'use client';

import { OpenPrintTabLink } from '@/components/reports/OpenPrintTabLink';

/**
 * Monthly Report actions (PO decision 18-10-2026: "use the print flow").
 *
 * ONE button, "Print / Save as PDF", for everyone who can view the report: it opens the report's print view in its own tab from
 * the click handler and prints; the tab closes itself afterwards (lib/reports/printTab.ts). Browser printing is free on every plan.
 *
 * The server PDF export (POST /api/reports/[id]/exports, with its typed errors) is deliberately NOT used by this page: Amplify has no
 * Chromium at runtime, so a server-rendered PDF cannot work there yet. The route stays in place for a hosted renderer later.
 */
export function ReportActions({ reportId }: { reportId: string }) {
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <OpenPrintTabLink
        href={`/reports/${reportId}/print?print=1`}
        windowName={`report-${reportId}`}
        className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust"
      >
        Print / Save as PDF
      </OpenPrintTabLink>
      <p className="text-xs text-gray-600">Opens a print view in a new tab. Choose &ldquo;Save as PDF&rdquo; as the destination to keep a copy. Free on every plan.</p>
    </div>
  );
}
