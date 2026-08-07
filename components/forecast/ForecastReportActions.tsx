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
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'consolidated-forecasting-report.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setError('Could not generate the PDF. Try again, or use Print / Save as PDF instead.');
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
