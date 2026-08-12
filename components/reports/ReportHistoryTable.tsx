import Link from 'next/link';
import type { ReportRow } from '@/lib/services/reportsData';
import { formatDateShort } from '@/lib/engines/date';

const STATUS_COLOR: Record<string, string> = {
  ready: '#198754',
  published: '#2563EB',
  revised: '#B7791F',
  superseded: '#9CA3AF',
  failed: '#C7362F',
  archived: '#9CA3AF',
  draft: '#9CA3AF',
  generating: '#B7791F',
};

const TYPE_LABELS: Record<string, string> = {
  monthly_financial_health: 'Monthly Financial Health',
  financial_health_score: 'Financial Health Score',
  goal_progress: 'Goal Progress',
  net_worth: 'Net Worth',
};

export function ReportHistoryTable({ reports, currency }: { reports: ReportRow[]; currency: 'AUD' | 'INR' }) {
  if (reports.length === 0) {
    return <p className="text-sm text-gray-500">No reports generated yet.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-gray-500">
        <tr>
          <th className="py-1">Report Period</th>
          <th className="py-1">Type</th>
          <th className="py-1">Generated</th>
          <th className="py-1">Status</th>
          <th className="py-1">Version</th>
          <th className="py-1"></th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r) => (
          <tr key={r.id} className="border-t">
            <td className="py-2">{new Date(r.report_month).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</td>
            <td className="py-2">{TYPE_LABELS[r.report_type_code] ?? r.report_type_code}</td>
            <td className="py-2">{r.generated_at ? formatDateShort(r.generated_at, currency) : '—'}</td>
            <td className="py-2">
              <span
                className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                style={{ background: STATUS_COLOR[r.status] ?? '#9CA3AF' }}
              >
                {r.status}
              </span>
            </td>
            <td className="py-2">{r.version_number}</td>
            <td className="py-2">
              <Link href={`/reports/${r.id}`} className="text-xs font-medium text-trust hover:underline">
                View
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
