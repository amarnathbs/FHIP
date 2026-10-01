'use client';

// Admin Premium grant (migration 0231) — the console for allocating Premium to a
// user who has not paid, extending it, and revoking it.
//
// This component is a CONVENIENCE layer only (Admin Architecture Standard §4):
// the date picker's max, the reason minimum and the button states mirror rules
// that the API routes and the database function enforce independently. Nothing
// here is trusted — a request that breaks a rule is refused server-side with an
// explicit error, which this component simply displays.

import { useCallback, useEffect, useState } from 'react';
import { ENTITLEMENT_GRANT_MAX_DAYS, maxGrantEndDate, utcToday } from '@/lib/services/entitlementWindow';
import { REASON_MIN_LENGTH } from '@/lib/services/premiumGrantAdmin';

interface UserRow {
  user_id: string;
  email: string | null;
  plan_tier: 'free' | 'premium';
  entitlement_source: 'payment' | 'admin_grant';
  effective_from: string | null;
  effective_to: string | null;
  admin_grant_ends_on: string | null;
  subscription_status: string | null;
  provider: string | null;
  entitlement_active: boolean;
}

interface GrantRow {
  user_id: string;
  email: string | null;
  effective_from: string | null;
  effective_to: string | null;
  days_remaining: number;
  state: 'active' | 'lapsed';
}

interface HistoryRow {
  id: string;
  created_at: string;
  action: 'grant' | 'extend' | 'revoke';
  actor_email: string | null;
  actor_user_id: string;
  reason: string;
  requested_ends_on: string | null;
  before_plan_tier: string | null;
  before_entitlement_source: string | null;
  before_effective_to: string | null;
  after_plan_tier: string;
  after_entitlement_source: string;
  after_effective_to: string | null;
}

type GrantFilter = 'expiring' | 'active' | 'lapsed';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? 'Request failed');
  return json.data as T;
}

function fmt(isoDate: string | null): string {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function describeState(u: UserRow): string {
  if (u.entitlement_source === 'admin_grant') {
    return u.entitlement_active
      ? `Premium — admin grant, ends ${fmt(u.effective_to)}`
      : `Free — admin grant lapsed ${fmt(u.effective_to)} (can be extended)`;
  }
  if (u.entitlement_active) {
    return u.admin_grant_ends_on
      ? `Premium — paid/other (protected). An admin grant ending ${fmt(u.admin_grant_ends_on)} is held in reserve.`
      : 'Premium — paid or set manually (protected; cannot be granted over or revoked here)';
  }
  return 'Free';
}

export function PremiumEntitlementsClient() {
  const today = utcToday();
  const maxEnd = maxGrantEndDate(today);

  const [filter, setFilter] = useState<GrantFilter>('expiring');
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [grantsError, setGrantsError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserRow[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [selected, setSelected] = useState<UserRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  const [endsOn, setEndsOn] = useState(maxEnd);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const loadGrants = useCallback(async (f: GrantFilter) => {
    setGrants(null);
    setGrantsError(null);
    try {
      const data = await fetchJson<{ grants: GrantRow[] }>(`/api/admin/entitlements/grants?filter=${f}&withinDays=30`);
      setGrants(data.grants);
    } catch (e) {
      setGrantsError(e instanceof Error ? e.message : 'Could not load grants');
    }
  }, []);

  useEffect(() => {
    void loadGrants(filter);
  }, [filter, loadGrants]);

  async function search(q: string) {
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await fetchJson<UserRow[]>(`/api/admin/entitlements/users?q=${encodeURIComponent(q)}`));
    } catch (e) {
      setResults(null);
      setSearchError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  async function selectUser(userId: string) {
    setActionError(null);
    setNotice(null);
    setConfirmRevoke(false);
    setReason('');
    setEndsOn(maxEnd);
    try {
      const rows = await fetchJson<UserRow[]>(`/api/admin/entitlements/users?q=${encodeURIComponent(userId)}`);
      const row = rows.find((r) => r.user_id === userId) ?? null;
      setSelected(row);
      setHistory(row ? await fetchJson<HistoryRow[]>(`/api/admin/entitlements/users/${userId}/history`) : null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not load this user');
    }
  }

  async function submit(action: 'grant' | 'extend' | 'revoke') {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fetchJson('/api/admin/entitlements/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId: selected.user_id, endsOn: action === 'revoke' ? undefined : endsOn, reason }),
      });
      setNotice(action === 'grant' ? 'Premium granted.' : action === 'extend' ? 'Grant extended.' : 'Grant revoked.');
      setReason('');
      setConfirmRevoke(false);
      await selectUser(selected.user_id);
      setNotice(action === 'grant' ? 'Premium granted.' : action === 'extend' ? 'Grant extended.' : 'Grant revoked.');
      void loadGrants(filter);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The change was refused.');
    } finally {
      setBusy(false);
    }
  }

  const reasonOk = reason.trim().length >= REASON_MIN_LENGTH;
  const dateOk = endsOn >= today && endsOn <= maxEnd;
  const isAdminGrant = selected?.entitlement_source === 'admin_grant';
  const protectedPaid = !!selected && selected.entitlement_active && !isAdminGrant;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Premium Access (admin grants)</h1>
        <p className="mt-1 text-muted">
          Allocate Premium to a user who has not paid online. A grant lasts at most {ENTITLEMENT_GRANT_MAX_DAYS} days from the day you
          allocate it, and can be extended later (each extension is again capped at {ENTITLEMENT_GRANT_MAX_DAYS} days from the day of the
          extension). Every change needs a reason and is recorded in an audit trail.
        </p>
      </div>

      <section aria-labelledby="grants-heading" className="space-y-3">
        <h2 id="grants-heading" className="text-lg font-medium text-ink">
          Admin grants
        </h2>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Grant list">
          {(
            [
              ['expiring', 'Expiring within 30 days'],
              ['active', 'All active'],
              ['lapsed', 'Lapsed'],
            ] as [GrantFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === value ? 'bg-trust text-white' : 'border text-gray-700 hover:bg-gray-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {grantsError && <p role="alert" className="text-sm text-risk">{grantsError}</p>}
        {grants === null && !grantsError && <p className="text-sm text-muted">Loading…</p>}
        {grants !== null && grants.length === 0 && <p className="text-sm text-muted">No grants in this list.</p>}
        {grants !== null && grants.length > 0 && (
          <div className="overflow-x-auto rounded-card border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Ends</th>
                  <th className="px-3 py-2">Days left</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.user_id} className="border-t">
                    <td className="px-3 py-2">{g.email ?? '(account no longer exists)'}</td>
                    <td className="px-3 py-2">{fmt(g.effective_to)}</td>
                    <td className="px-3 py-2">{g.state === 'lapsed' ? 'Lapsed' : g.days_remaining}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void selectUser(g.user_id)} className="text-xs font-medium text-trust hover:underline">
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="search-heading" className="space-y-3">
        <h2 id="search-heading" className="text-lg font-medium text-ink">
          Find a user
        </h2>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search(query.trim());
          }}
        >
          <label htmlFor="ent-search" className="sr-only">
            Email or user id
          </label>
          <input
            id="ent-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Email (3+ characters) or full user id"
            className="min-w-[18rem] rounded border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={searching || query.trim().length < 3}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        {searchError && <p role="alert" className="text-sm text-risk">{searchError}</p>}
        {results !== null && results.length === 0 && <p className="text-sm text-muted">No matching users.</p>}
        {results !== null && results.length > 0 && (
          <div className="overflow-x-auto rounded-card border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {results.map((u) => (
                  <tr key={u.user_id} className="border-t">
                    <td className="px-3 py-2">{u.email ?? '(no email)'}</td>
                    <td className="px-3 py-2 text-muted">{describeState(u)}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void selectUser(u.user_id)} className="text-xs font-medium text-trust hover:underline">
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section aria-labelledby="manage-heading" className="space-y-4 rounded-card border p-4">
          <div>
            <h2 id="manage-heading" className="text-lg font-medium text-ink">
              {selected.email ?? selected.user_id}
            </h2>
            <p className="mt-1 text-sm text-muted">{describeState(selected)}</p>
          </div>

          {protectedPaid ? (
            <p className="text-sm text-ink">
              This user already has Premium that was not allocated by an admin. It is protected: no grant, extension or revocation is
              possible from this screen.
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="ent-ends" className="block text-xs font-medium text-muted">
                  {isAdminGrant ? 'New end date (inclusive)' : 'Premium ends on (inclusive)'}
                </label>
                <input
                  id="ent-ends"
                  type="date"
                  value={endsOn}
                  min={today}
                  max={maxEnd}
                  onChange={(e) => setEndsOn(e.target.value)}
                  className="mt-1 rounded border px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted">
                  Latest allowed: {fmt(maxEnd)} ({ENTITLEMENT_GRANT_MAX_DAYS} days from today). Enforced by the server.
                </p>
              </div>
              <div>
                <label htmlFor="ent-reason" className="block text-xs font-medium text-muted">
                  Reason (required, at least {REASON_MIN_LENGTH} characters; recorded in the audit trail)
                </label>
                <textarea
                  id="ent-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  className="mt-1 w-full max-w-xl rounded border px-3 py-2 text-sm"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!isAdminGrant && (
                  <button
                    type="button"
                    disabled={busy || !reasonOk || !dateOk}
                    onClick={() => void submit('grant')}
                    className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? 'Working…' : 'Grant Premium'}
                  </button>
                )}
                {isAdminGrant && (
                  <>
                    <button
                      type="button"
                      disabled={busy || !reasonOk || !dateOk}
                      onClick={() => void submit('extend')}
                      className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? 'Working…' : selected.entitlement_active ? 'Extend grant' : 'Re-activate (extend) from today'}
                    </button>
                    {confirmRevoke ? (
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-risk">Return this user to Free now?</span>
                        <button
                          type="button"
                          disabled={busy || !reasonOk}
                          onClick={() => void submit('revoke')}
                          className="rounded bg-risk px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                        >
                          Confirm revoke
                        </button>
                        <button type="button" onClick={() => setConfirmRevoke(false)} className="text-xs text-gray-500 hover:underline">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRevoke(true)}
                        className="rounded border border-risk px-3 py-2 text-sm font-medium text-risk hover:bg-risk/5"
                      >
                        Revoke
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {notice && <p role="status" className="text-sm text-trust">{notice}</p>}
          {actionError && <p role="alert" className="text-sm text-risk">{actionError}</p>}

          <div>
            <h3 className="text-sm font-medium text-ink">History</h3>
            {history === null && <p className="mt-1 text-sm text-muted">Loading…</p>}
            {history !== null && history.length === 0 && <p className="mt-1 text-sm text-muted">No admin changes recorded for this user.</p>}
            {history !== null && history.length > 0 && (
              <div className="mt-2 overflow-x-auto rounded-card border">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                    <tr>
                      <th className="px-3 py-2">When</th>
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">By</th>
                      <th className="px-3 py-2">Change</th>
                      <th className="px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-t align-top">
                        <td className="px-3 py-2">{new Date(h.created_at).toLocaleString('en-AU')}</td>
                        <td className="px-3 py-2 capitalize">{h.action}</td>
                        <td className="px-3 py-2">{h.actor_email ?? h.actor_user_id}</td>
                        <td className="px-3 py-2 text-muted">
                          {h.before_plan_tier ?? '—'}
                          {h.before_entitlement_source === 'admin_grant' ? ' (grant)' : ''}
                          {h.before_effective_to ? ` to ${fmt(h.before_effective_to)}` : ''}
                          {' → '}
                          {h.after_plan_tier}
                          {h.after_entitlement_source === 'admin_grant' ? ' (grant)' : ''}
                          {h.after_effective_to && h.after_plan_tier === 'premium' ? ` to ${fmt(h.after_effective_to)}` : ''}
                        </td>
                        <td className="px-3 py-2">{h.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
