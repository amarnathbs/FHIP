'use client';

// LR-9 WP-06 — the user-facing entry point into account closure. Submitting
// this form never deletes anything itself: it only creates a queued
// request an authorised Admin must separately review and execute. WP-06's
// own lock: "Do not immediately hard-delete on accidental click" — this
// panel requires an explicit inline confirmation step before the request
// is even submitted, on top of the request/review/execute split itself.

import { useEffect, useState } from 'react';

interface DeletionRequest {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  requested_at: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

const STATUS_LABEL: Record<DeletionRequest['status'], string> = {
  pending: 'Pending review',
  processing: 'Being processed',
  completed: 'Completed',
  failed: 'Could not be completed',
  cancelled: 'Cancelled',
};

export function CloseAccountPanel() {
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<DeletionRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const requests = await fetchJson<DeletionRequest[]>('/api/account/close');
        if (cancelled) return;
        setActive(requests.find((r) => r.status === 'pending' || r.status === 'processing') ?? requests[0] ?? null);
      } catch {
        // fail quiet on initial load — the panel just shows the "no request" state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitRequest() {
    setBusy(true);
    setError(null);
    try {
      const created = await fetchJson<DeletionRequest>('/api/account/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      setActive(created);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your request.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const cancelled = await fetchJson<DeletionRequest>(`/api/account/close/${active.id}`, { method: 'DELETE' });
      setActive(cancelled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel your request.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  if (active && (active.status === 'pending' || active.status === 'processing')) {
    return (
      <div>
        <p className="text-sm text-ink">
          {`Account closure requested ${new Date(active.requested_at).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })} — ${STATUS_LABEL[active.status]}.`}
        </p>
        <p className="mt-1 text-xs text-muted">
          Your account and data have not been deleted yet. An authorised reviewer processes closure requests; you can
          cancel this request at any time before that happens.
        </p>
        {active.status === 'pending' && (
          <button
            type="button"
            onClick={() => void cancelRequest()}
            disabled={busy}
            className="mt-3 rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {busy ? 'Cancelling…' : 'Cancel this request'}
          </button>
        )}
        {error && <p className="mt-2 text-sm text-risk">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-muted">
        Closing your account requests permanent deletion of your FHIP data. This is reviewed by an authorised person
        before anything is deleted — closing your account does not delete anything instantly.
      </p>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 rounded border border-risk px-3 py-1.5 text-sm font-medium text-risk hover:bg-risk/5"
        >
          Close my account
        </button>
      ) : (
        <div className="mt-3 space-y-3 rounded border border-risk/40 bg-risk/5 p-4">
          <p className="text-sm font-medium text-ink">
            Are you sure? Once processed, this permanently deletes your FHIP account and all of your data. This
            cannot be undone.
          </p>
          <div>
            <label htmlFor="close-account-reason" className="block text-xs font-medium text-muted">
              Reason (optional)
            </label>
            <textarea
              id="close-account-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submitRequest()}
              disabled={busy}
              className="rounded bg-risk px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Submitting…' : 'Yes, request account closure'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="text-sm text-gray-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </div>
  );
}
