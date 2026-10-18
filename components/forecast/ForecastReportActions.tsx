'use client';

import { OpenPrintTabLink } from '@/components/reports/OpenPrintTabLink';

/**
 * Consolidated Forecasting Report actions (PO decision 18-10-2026: "use the print flow"). One "Print / Save as PDF" button that opens
 * the print view in its own tab and closes it afterwards (lib/reports/printTab.ts); free on every plan. The server export route
 * (GET /api/forecast/report/export, Premium) stays in place for a hosted PDF renderer later, but Amplify has no Chromium at runtime,
 * so this page no longer calls it.
 */
export function ForecastReportActions({ scenario }: { scenario?: string }) {
  const query = scenario ? `&scenario=${encodeURIComponent(scenario)}` : '';
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <OpenPrintTabLink
        href={`/forecast/report/print?print=1${query}`}
        windowName="forecast-report"
        className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust"
      >
        Print / Save as PDF
      </OpenPrintTabLink>
      <p className="text-xs text-gray-600">Opens a print view in a new tab. Choose &ldquo;Save as PDF&rdquo; as the destination to keep a copy. Free on every plan.</p>
    </div>
  );
}
