'use client';

import { useState } from 'react';
import { describeExportFailure, NETWORK_FAILURE, readApiResponse } from '@/lib/reports/apiClient';

export function ReportActions({ reportId }: { reportId: string }) {
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readyExportId, setReadyExportId] = useState<string | null>(null);
  const [offerPrint, setOfferPrint] = useState(false);

  function print() {
    window.print();
  }

  async function requestExport(format: 'pdf' | 'csv') {
    setExporting(format);
    setMessage(null);
    setReadyExportId(null);
    setOfferPrint(false);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/reports/${reportId}/exports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format }),
        });
      } catch {
        setMessage(NETWORK_FAILURE.message);
        setOfferPrint(true);
        return;
      }
      // Never res.json(): an empty or non-JSON body (a platform cut-off, a gateway page) is a plain message, not a parser error.
      const read = await readApiResponse(res);
      if (!read.ok) {
        // Typed answers carry their own sentence, code and reference; a bare platform 500 is explained as
        // "temporarily unavailable". Either way the browser print route stays offered.
        const failure = describeExportFailure(read);
        setMessage(failure.message);
        setOfferPrint(failure.offerPrint);
        return;
      }
      const data = (read.json?.data ?? null) as { status?: string; id?: string } | null;
      if (data?.status === 'ready' && data.id) {
        setMessage('Your PDF is ready.');
        setReadyExportId(data.id);
      } else if (data?.status === 'failed') {
        setMessage('This export format is not available yet in this release. You can still view and print this report.');
      } else {
        setMessage(data ? 'Export requested.' : 'The export answer could not be read. Please try again.');
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
      {offerPrint && (
        <button onClick={print} className="rounded border border-trust px-3 py-1.5 text-sm font-medium text-trust hover:bg-trust hover:text-white">
          Print / Save as PDF
        </button>
      )}
      {message && (
        <p role="status" aria-live="polite" className="text-xs text-gray-500">
          {message}
        </p>
      )}
    </div>
  );
}
