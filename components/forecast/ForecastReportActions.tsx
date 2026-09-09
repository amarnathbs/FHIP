'use client';

import { useState } from 'react';

export function ForecastReportActions({ scenario }: { scenario?: string }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportPdf() {
    setExporting(true);
    setError(null);
    try {
      const url = scenario ? `/api/forecast/report/export?scenario=${encodeURIComponent(scenario)}` : '/api/forecast/report/export';
      const res = await fetch(url);
      if (!res.ok) {
        // LR-8 WP-09 — the export route now enforces canExportReports() and
        // returns a specific 403 reason; surface it instead of a generic
        // failure message so a Free user understands why (matches the
        // Monthly report's own PremiumPreview messaging pattern).
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      // LR-8 WP-07 — matches the server's own labelled filename
      // (app/api/forecast/report/export/route.ts) rather than a static
      // literal every scenario/period previously shared.
      const dateLabel = new Date().toISOString().slice(0, 10);
      const scenarioLabel = (scenario ?? 'base').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
      link.download = `consolidated-forecast-report-${scenarioLabel}-${dateLabel}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate the PDF. Try again, or use Print / Save as PDF instead.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <button onClick={exportPdf} disabled={exporting} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust disabled:opacity-50">
        {exporting ? 'Generating PDF…' : 'Export PDF'}
      </button>
      <button onClick={() => window.print()} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust">
        Print / Save as PDF
      </button>
      {error && <span className="text-xs text-risk">{error}</span>}
    </div>
  );
}
