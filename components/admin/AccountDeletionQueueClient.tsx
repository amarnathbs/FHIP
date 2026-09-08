'use client';

// LR-9 WP-08/WP-09 — Admin account-deletion queue. Shows only minimal
// identity (email, looked up live, never persisted — see migration 0132's
// header) and request status/timestamps; no financial data of any kind is
// fetched or displayed here (WP-08's own lock).

import { useEffect, useState } from 'react';

type QueueName = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

interface DeletionRequestRow {
  id: string;
  user_id: string | null;
  email: string | null;
  status: QueueName;
  reason: string | null;
  requested_at: string;
  processing_started_at: string | null;
  processed_at: string | null;
  failure_reason: string | null;
}

const QUEUES: { value: QueueName; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export function AccountDeletionQueueClient() {
  const [queue, setQueue] = useState<QueueName>('pending');
  const [rows, setRows] = useState<DeletionRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRows(null);
      setError(null);
      try {
        const data = await fetchJson<DeletionRequestRow[]>(`/api/admin/account-deletions?queue=${queue}`);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the queue');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queue]);

  async function execute(id: string) {
    setExecutingId(id);
    setError(null);
    try {
      await fetchJson(`/api/admin/account-deletions/${id}/execute`, { method: 'POST' });
      setConfirmingId(null);
      // Move the executed row off the pending queue view.
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not execute this deletion.');
    } finally {
      setExecutingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Account Deletion Queue</h1>
        <p className="mt-1 text-muted">User-initiated account-closure requests, reviewed and executed here.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Queue">
        {QUEUES.map((q) => (
          <button
            key={q.value}
            type="button"
            role="tab"
            aria-selected={queue === q.value}
            onClick={() => setQueue(q.value)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${
              queue === q.value ? 'bg-trust text-white' : 'border text-gray-700 hover:bg-gray-50'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-risk">{error}</p>}
      {rows === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {rows !== null && rows.length === 0 && <p className="text-sm text-muted">No requests in this queue.</p>}

      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto rounded-card border">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Requested</th>
                <th className="px-3 py-2">Reason</th>
                {queue === 'failed' && <th className="px-3 py-2">Failure reason</th>}
                {queue === 'pending' && <th className="px-3 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2">{row.email ?? '(account no longer exists)'}</td>
                  <td className="px-3 py-2">{new Date(row.requested_at).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td className="px-3 py-2 text-muted">{row.reason ?? '—'}</td>
                  {queue === 'failed' && <td className="px-3 py-2 text-risk">{row.failure_reason ?? '—'}</td>}
                  {queue === 'pending' && (
                    <td className="px-3 py-2">
                      {confirmingId === row.id ? (
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-risk">Permanently delete this account?</span>
                          <button
                            type="button"
                            disabled={executingId === row.id}
                            onClick={() => void execute(row.id)}
                            className="rounded bg-risk px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                          >
                            {executingId === row.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button type="button" onClick={() => setConfirmingId(null)} className="text-xs text-gray-500 hover:underline">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(row.id)}
                          className="rounded border border-risk px-2 py-1 text-xs font-medium text-risk hover:bg-risk/5"
                        >
                          Execute deletion
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
