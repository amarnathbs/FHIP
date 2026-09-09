'use client';

// LR-7 WP-05/06/07/08 — Goal lifecycle actions (archive/pause/resume/
// permanent delete). Every one of these APIs already existed and was fully
// tested before this phase (app/api/goals/[id]/{archive,pause,resume}/
// route.ts, and the DELETE handler on app/api/goals/[id]/route.ts) but had
// zero UI caller anywhere — this is the first control that reaches them.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type GoalStatus = string;

const PAUSABLE_STATUSES = new Set(['active']);
const RESUMABLE_STATUSES = new Set(['paused', 'on_hold']);
const ARCHIVABLE_STATUSES = new Set(['active', 'paused', 'on_hold', 'achieved', 'partially_achieved', 'missed']);

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: json.error ?? 'Request failed' };
}

export function GoalLifecycleControls({ goalId, status }: { goalId: string; status: GoalStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function runAction(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? 'Something went wrong');
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'Could not delete this goal');
        setConfirmingDelete(false);
        return;
      }
      router.push('/goals');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'archived') {
    return <p className="text-xs text-muted">This goal is archived. Its history is preserved but it no longer appears in active planning.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {PAUSABLE_STATUSES.has(status) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => postJson(`/api/goals/${goalId}/pause`))}
          className="rounded border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Pause
        </button>
      )}
      {RESUMABLE_STATUSES.has(status) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => postJson(`/api/goals/${goalId}/resume`))}
          className="rounded border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Resume
        </button>
      )}
      {ARCHIVABLE_STATUSES.has(status) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => postJson(`/api/goals/${goalId}/archive`))}
          className="rounded border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Archive
        </button>
      )}

      {confirmingDelete ? (
        <span className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">Delete permanently? This cannot be undone.</span>
          <button type="button" disabled={busy} onClick={handleDelete} className="rounded bg-risk px-3 py-1.5 font-medium text-white disabled:opacity-60">
            Yes, delete
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)} className="text-gray-500 hover:underline">
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
          className="rounded border border-risk px-3 py-1.5 text-xs font-medium text-risk hover:bg-risk/5 disabled:opacity-60"
        >
          Delete permanently
        </button>
      )}

      {error && <p className="w-full text-xs text-risk">{error}</p>}
    </div>
  );
}
