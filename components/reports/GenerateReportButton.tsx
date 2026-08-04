'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function GenerateReportButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType: 'monthly_financial_health', reportMonth: monthStart() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not generate report');
      if (json.data?.report?.id) {
        router.push(`/reports/${json.data.report.id}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? 'Generating...' : 'Generate report'}
      </button>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </div>
  );
}
