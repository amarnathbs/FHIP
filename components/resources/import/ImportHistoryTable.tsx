// Resources Bulk Upload -- compact "Recent Imports" history, shared by both types
// (Date, File, Type, Actor, Rows, Result, Status). Presentational; the page supplies the rows.

import Link from 'next/link';
import { DataTable, DataTd, DataTh } from '@/components/ui/DataTable';
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
    <DataTable label="Recent imports (scrollable)" wrapperClassName="rounded-card border border-line bg-white" className="w-full text-left">
      <caption className="sr-only">Recent imports</caption>
      <thead className="bg-gray-50 text-xs uppercase tracking-wide text-muted">
        <tr>
          <DataTh kind="date" className="px-3 py-2">Date</DataTh>
          <DataTh className="px-3 py-2">File</DataTh>
          <DataTh className="px-3 py-2">Type</DataTh>
          <DataTh className="px-3 py-2">Actor</DataTh>
          <DataTh kind="num" className="px-3 py-2">Rows</DataTh>
          <DataTh className="px-3 py-2">Result</DataTh>
          <DataTh kind="status" className="px-3 py-2">Status</DataTh>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-line align-top">
            <DataTd kind="date" className="px-3 py-2">{formatAdminDateTime(r.created_at)}</DataTd>
            <DataTd className="px-3 py-2 break-all">
              <Link href={`/admin/resources/import/runs/${r.id}`} className="font-semibold text-trust hover:underline">
                {r.file_name}
              </Link>
            </DataTd>
            <DataTd className="px-3 py-2">{CONTENT_TYPE_LABELS[r.content_type].singular}</DataTd>
            <DataTd kind="clamp" className="px-3 py-2">{r.actor_label}</DataTd>
            <DataTd kind="num" className="px-3 py-2">{r.row_count}</DataTd>
            <DataTd kind="clamp" className="px-3 py-2">{resultText(r)}</DataTd>
            <DataTd kind="status" className="px-3 py-2">
              <span className="rounded border border-line px-2 py-0.5 text-xs font-semibold text-ink">{STATUS_LABEL[r.status] ?? r.status}</span>
            </DataTd>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
