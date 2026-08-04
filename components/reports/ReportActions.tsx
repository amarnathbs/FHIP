'use client';

import { useState } from 'react';

export function ReportActions({ reportId }: { reportId: string }) {
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readyExportId, setReadyExportId] = useState<string | null>(null);

  function print() {
    window.print();
  }

  async function requestExport(format: 'pdf' | 'csv') {
    setExporting(format);
    setMessage(null);
    setReadyExportId(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? 'Export request failed');
        return;
      }
      if (json.data?.status === 'ready') {
        setMessage('Your PDF is ready.');
        setReadyExportId(json.data.id);
      } else if (json.data?.status === 'failed') {
        setMessage('This export format is not available yet in this release. You can still view and print this report.');
      } else {
        setMessage('Export requested.');
      }
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <button onClick={print} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust">
        Print
      </button>
      <button
        onClick={() => requestExport('pdf')}
        disabled={exporting !== null}
        className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust disabled:opacity-60"
      >
        {exporting === 'pdf' ? 'Generating PDF...' : 'Export PDF (premium)'}
      </button>
      {readyExportId && (
        <a
          href={`/api/report-exports/${readyExportId}/download`}
          className="rounded border border-trust px-3 py-1.5 text-sm font-medium text-trust hover:bg-trust hover:text-white"
        >
          Download PDF
        </a>
      )}
      {message && <p className="text-xs text-gray-500">{message}</p>}
    </div>
  );
}
