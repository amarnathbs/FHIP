'use client';

export function ForecastReportActions() {
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <button onClick={() => window.print()} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust">
        Print / Save as PDF
      </button>
    </div>
  );
}
