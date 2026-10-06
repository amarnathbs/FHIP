// Resources Bulk Upload -- compact "Recent Imports" history, shared by both types
// (Date, File, Type, Actor, Rows, Result, Status). Presentational; the page supplies the rows.

import Link from 'next/link';
import { formatAdminDateTime } from '@/lib/resources/admin/labels';
import { CONTENT_TYPE_LABELS, type ImportContentType } from '@/lib/resources/import/types';

export interface HistoryRow {
  id: string;
  content_type: ImportContentType;
  file_name: string;
  status: string;
  row_count: number;
  valid_count: number;
  error_count: number;
  created_post_count: number;
  created_at: string;
  actor_label: string;
}

const STATUS_LABEL: Record<string, string> = {
  ready: 'Ready, not applied',
  has_errors: 'Has errors',
  applied: 'Applied',
  failed: 'Failed',
  stale: 'Out of date',
  rejected: 'File rejected',
  expired: 'Expired',
};

function resultText(r: HistoryRow): string {
  if (r.status === 'applied') return `${r.created_post_count} created`;
  if (r.status === 'rejected') return 'Nothing created (file rejected)';
  if (r.status === 'has_errors') return `${r.error_count} with errors, nothing created`;
  if (r.status === 'ready') return 'Nothing created yet';
  return 'Nothing created';
}

export function ImportHistoryTable({ rows, emptyText = 'No imports yet.' }: { rows: HistoryRow[]; emptyText?: string }) {
  if (rows.length === 0) {
    return <p className="rounded-card border border-dashed border-line bg-gray-50/50 px-4 py-6 text-center text-sm text-muted">{emptyText}</p>;
  }
  return (
    <div tabIndex={0} role="region" aria-label="Recent imports (scrollable)" className="overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">Recent imports</caption>
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-2">Date</th>
            <th scope="col" className="px-3 py-2">File</th>
            <th scope="col" className="px-3 py-2">Type</th>
            <th scope="col" className="px-3 py-2">Actor</th>
            <th scope="col" className="px-3 py-2">Rows</th>
            <th scope="col" className="px-3 py-2">Result</th>
            <th scope="col" className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line align-top">
              <td className="px-3 py-2 whitespace-nowrap">{formatAdminDateTime(r.created_at)}</td>
              <td className="px-3 py-2 break-all">
                <Link href={`/admin/resources/import/runs/${r.id}`} className="font-semibold text-trust hover:underline">
                  {r.file_name}
                </Link>
              </td>
              <td className="px-3 py-2">{CONTENT_TYPE_LABELS[r.content_type].singular}</td>
              <td className="px-3 py-2">{r.actor_label}</td>
              <td className="px-3 py-2 tabular-nums">{r.row_count}</td>
              <td className="px-3 py-2">{resultText(r)}</td>
              <td className="px-3 py-2">
                <span className="rounded border border-line px-2 py-0.5 text-xs font-semibold text-ink">{STATUS_LABEL[r.status] ?? r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
