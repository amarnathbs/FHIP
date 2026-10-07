'use client';

// Admin Premium grant (migration 0231) — the console for allocating Premium to a
// user who has not paid, extending it, and revoking it.
//
// This component is a CONVENIENCE layer only (Admin Architecture Standard §4):
// the date picker's max, the reason minimum and the button states mirror rules
// that the API routes and the database function enforce independently. Nothing
// here is trusted — a request that breaks a rule is refused server-side with an
// explicit error, which this component simply displays.

import { useEffect, useState } from 'react';
import { ENTITLEMENT_GRANT_MAX_DAYS, maxGrantEndDate, utcToday } from '@/lib/services/entitlementWindow';
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';
import { DATE_INPUT_HINT, DATE_INPUT_PLACEHOLDER, formatDateInput, parseDateInput } from '@/lib/engines/dateInput';
import { OVERRIDE_REASON_MIN_LENGTH, PREMIUM_GRANT_LIFETIME_CEILING, REASON_MIN_LENGTH } from '@/lib/services/premiumGrantAdmin';
import { AdminActionStatus, type AdminActionOutcome } from '@/components/admin/AdminActionStatus';
import { parseAdminCapabilities } from '@/lib/admin/adminNav';

interface UserRow {
  user_id: string;
  email: string | null;
  plan_tier: 'free' | 'premium';
  entitlement_source: 'payment' | 'admin_grant' | 'promo_code';
  effective_from: string | null;
  effective_to: string | null;
  admin_grant_ends_on: string | null;
  subscription_status: string | null;
  provider: string | null;
  entitlement_active: boolean;
  extension_count: number;
  extensions_remaining: number;
}

interface SummaryRow {
  user_id: string;
  email: string | null;
  entitlement_source: 'admin_grant' | 'promo_code';
  effective_to: string;
  days_remaining: number;
  bucket: 'expired_this_month' | 'expiring_this_month';
  extension_count: number;
  extensions_remaining: number;
}

interface Summary {
  as_of: string;
  month: string;
  counts: {
    expired_this_month: number;
    expiring_this_month: number;
    by_source: Record<'admin_grant' | 'promo_code', { expired: number; expiring: number }>;
  };
  rows: SummaryRow[];
}

const SOURCE_LABEL: Record<string, string> = { admin_grant: 'Admin grant', promo_code: 'Promo code', payment: 'Paid / other' };

interface GrantRow {
  user_id: string;
  email: string | null;
  entitlement_source: 'admin_grant' | 'promo_code';
  extension_count: number;
  extensions_remaining: number;
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

/** Carries the stable error code so the screen can tell a limit refusal from any other refusal. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.message ?? json.error ?? 'Request failed', typeof json.error === 'string' ? json.error : null);
  return json.data as T;
}

const LIMIT_CODES = ['ENTITLEMENT_LIFETIME_LIMIT_REACHED', 'ENTITLEMENT_EXTENSION_LIMIT_REACHED'];

// Day-first through the canonical formatter (PO rule, Document2 findings #8/#19):
// this admin page has no single country, so it uses the AU shape dd/mm/yyyy.
function fmt(isoDate: string | null): string {
  if (!isoDate) return '—';
  return formatDateShort(isoDate, 'AUD');
}

function describeState(u: UserRow): string {
  if (u.entitlement_source === 'admin_grant' || u.entitlement_source === 'promo_code') {
    const what = u.entitlement_source === 'promo_code' ? 'promo code' : 'admin grant';
    const ext = u.extensions_remaining > 0 ? `${u.extensions_remaining} extension(s) left` : 'extension limit reached';
    return u.entitlement_active
      ? `Premium — ${what}, ends ${fmt(u.effective_to)} (${ext})`
      : `Free — ${what} lapsed ${fmt(u.effective_to)} (${ext})`;
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
  const [grantsReload, setGrantsReload] = useState(0);
  // The list is stored WITH the key it was loaded for; a different current key means "loading".
  const [loadedGrants, setLoadedGrants] = useState<{ key: string; rows: GrantRow[] } | null>(null);
  const [grantsFailure, setGrantsFailure] = useState<{ key: string; message: string } | null>(null);
  const grantsKey = `${filter}:${grantsReload}`;
  const grants = loadedGrants && loadedGrants.key === grantsKey ? loadedGrants.rows : null;
  const grantsError = grantsFailure && grantsFailure.key === grantsKey ? grantsFailure.message : null;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserRow[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [summarySource, setSummarySource] = useState<'' | 'admin_grant' | 'promo_code'>('');
  const [summaryReload, setSummaryReload] = useState(0);
  const [loadedSummary, setLoadedSummary] = useState<{ key: string; data: Summary } | null>(null);
  const [summaryFailure, setSummaryFailure] = useState<{ key: string; message: string } | null>(null);
  const summaryKey = `${summarySource}:${summaryReload}`;
  const summary = loadedSummary && loadedSummary.key === summaryKey ? loadedSummary.data : null;
  const summaryError = summaryFailure && summaryFailure.key === summaryKey ? summaryFailure.message : null;

  const [selected, setSelected] = useState<UserRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  // The end date is typed day-first (DD-MM-YYYY); the API gets the ISO value.
  const [endsOn, setEndsOn] = useState(formatDateInput(maxEnd));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  // The separate override capability (read from /api/admin/me, never assumed) and the override form.
  const [canOverride, setCanOverride] = useState(false);
  const [limitHit, setLimitHit] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const outcome: AdminActionOutcome = actionError ? { kind: 'failure', message: actionError } : notice ? { kind: 'success', message: notice } : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/me');
        const json = await res.json().catch(() => null);
        if (!cancelled) setCanOverride(res.ok && parseAdminCapabilities(json).entitlementOverride);
      } catch {
        if (!cancelled) setCanOverride(false); // fail closed: no override control
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<{ grants: GrantRow[] }>(`/api/admin/entitlements/grants?filter=${filter}&withinDays=30`);
        if (!cancelled) setLoadedGrants({ key: `${filter}:${grantsReload}`, rows: data.grants });
      } catch (e) {
        if (!cancelled) setGrantsFailure({ key: `${filter}:${grantsReload}`, message: e instanceof Error ? e.message : 'Could not load grants' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, grantsReload]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<Summary>(`/api/admin/entitlements/summary${summarySource ? `?source=${summarySource}` : ''}`);
        if (!cancelled) setLoadedSummary({ key: `${summarySource}:${summaryReload}`, data });
      } catch (e) {
        if (!cancelled) setSummaryFailure({ key: `${summarySource}:${summaryReload}`, message: e instanceof Error ? e.message : 'Could not load the monthly summary' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summarySource, summaryReload]);

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
    setEndsOn(formatDateInput(maxEnd));
    try {
      const rows = await fetchJson<UserRow[]>(`/api/admin/entitlements/users?q=${encodeURIComponent(userId)}`);
      const row = rows.find((r) => r.user_id === userId) ?? null;
      setSelected(row);
      setHistory(row ? await fetchJson<HistoryRow[]>(`/api/admin/entitlements/users/${userId}/history`) : null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not load this user');
    }
  }

  async function submit(action: 'grant' | 'extend' | 'revoke', override = false) {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setLimitHit(null);
    try {
      await fetchJson('/api/admin/entitlements/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          userId: selected.user_id,
          endsOn: action === 'revoke' ? undefined : (endsIso ?? endsOn),
          reason: override ? overrideReason : reason,
          ...(override ? { override: true } : {}),
        }),
      });
      setNotice(action === 'grant' ? 'Premium granted.' : action === 'extend' ? 'Grant extended.' : 'Grant revoked.');
      setReason('');
      setOverrideReason('');
      setConfirmRevoke(false);
      await selectUser(selected.user_id);
      setNotice(action === 'grant' ? 'Premium granted.' : action === 'extend' ? 'Grant extended.' : 'Grant revoked.');
      setGrantsReload((k) => k + 1);
      setSummaryReload((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && e.code && LIMIT_CODES.includes(e.code)) setLimitHit(e.code);
      setActionError(e instanceof Error ? e.message : 'The change was refused.');
    } finally {
      setBusy(false);
    }
  }

  const reasonOk = reason.trim().length >= REASON_MIN_LENGTH;
  const overrideReasonOk = overrideReason.trim().length >= OVERRIDE_REASON_MIN_LENGTH;
  const endsIso = parseDateInput(endsOn);
  const dateOk = endsIso !== null && endsIso >= today && endsIso <= maxEnd;
  // "Managed" = an admin grant OR a promo-code entitlement (both are time-limited and admin-extendable).
  const isAdminGrant = !!selected && selected.entitlement_source !== 'payment';
  const extensionsExhausted = isAdminGrant && !!selected && selected.extensions_remaining <= 0;
  const protectedPaid = !!selected && selected.entitlement_active && !isAdminGrant;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Premium Access (admin grants)</h1>
        <p className="mt-1 text-muted">
          Allocate Premium to a user who has not paid online. A grant lasts at most {ENTITLEMENT_GRANT_MAX_DAYS} days counting the day you
          allocate it, and can be extended later (each extension is again capped at {ENTITLEMENT_GRANT_MAX_DAYS} days counting the day of the
          extension). One user can receive at most {PREMIUM_GRANT_LIFETIME_CEILING} admin grants and extensions in their lifetime; revoking and granting again does not
          reset that. Every change needs a reason and is recorded in an audit trail.
        </p>
      </div>

      <section aria-labelledby="summary-heading" className="space-y-3">
        <h2 id="summary-heading" className="text-lg font-medium text-ink">
          This month{summary ? ` (${summary.month})` : ''}: expired and expiring
        </h2>
        <p className="text-xs text-muted">
          Admin grants and promo-code entitlements whose last day falls in the current month (UTC). Revoked entitlements and paying customers are
          not listed. On-screen only: there is no export of this list.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="summary-source" className="text-xs font-medium text-muted">
            Source
          </label>
          <select
            id="summary-source"
            value={summarySource}
            onChange={(e) => setSummarySource(e.target.value as '' | 'admin_grant' | 'promo_code')}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="">All sources</option>
            <option value="admin_grant">Admin grant</option>
            <option value="promo_code">Promo code</option>
          </select>
          {summary && (
            <p className="text-sm text-ink">
              <span className="font-medium">{summary.counts.expired_this_month}</span> expired this month ·{' '}
              <span className="font-medium">{summary.counts.expiring_this_month}</span> expiring in the rest of this month
            </p>
          )}
        </div>
        {summaryError && <p role="alert" className="text-sm text-risk">{summaryError}</p>}
        {summary === null && !summaryError && <p className="text-sm text-muted">Loading…</p>}
        {summary !== null && summary.rows.length === 0 && <p className="text-sm text-muted">Nothing expired or expiring this month for this source.</p>}
        {summary !== null && summary.rows.length > 0 && (
          <div className="overflow-x-auto rounded-card border" tabIndex={0} role="region" aria-label="Expiry summary table">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Last day</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Extensions left</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.user_id} className="border-t">
                    <td className="px-3 py-2">{r.email ?? '(account no longer exists)'}</td>
                    <td className="px-3 py-2">{SOURCE_LABEL[r.entitlement_source]}</td>
                    <td className="px-3 py-2">{fmt(r.effective_to)}</td>
                    <td className="px-3 py-2">{r.bucket === 'expired_this_month' ? 'Expired' : `Expires in ${r.days_remaining} day(s)`}</td>
                    <td className="px-3 py-2">{r.extensions_remaining}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void selectUser(r.user_id)} className="text-xs font-medium text-trust hover:underline">
                        History / Extend
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
          <div className="overflow-x-auto rounded-card border" tabIndex={0} role="region" aria-label="Grants table">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Ends</th>
                  <th className="px-3 py-2">Days left</th>
                  <th className="px-3 py-2">Extensions left</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.user_id} className="border-t">
                    <td className="px-3 py-2">{g.email ?? '(account no longer exists)'}</td>
                    <td className="px-3 py-2">{SOURCE_LABEL[g.entitlement_source]}</td>
                    <td className="px-3 py-2">{fmt(g.effective_to)}</td>
                    <td className="px-3 py-2">{g.state === 'lapsed' ? 'Lapsed' : g.days_remaining}</td>
                    <td className="px-3 py-2">{g.extensions_remaining}</td>
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
          <div className="overflow-x-auto rounded-card border" tabIndex={0} role="region" aria-label="User search results table">
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
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={DATE_INPUT_PLACEHOLDER}
                  maxLength={10}
                  value={endsOn}
                  aria-describedby="ent-ends-hint"
                  aria-invalid={endsOn.trim() !== '' && endsIso === null ? true : undefined}
                  onChange={(e) => setEndsOn(e.target.value)}
                  className="mt-1 rounded border px-3 py-2 text-sm"
                />
                <p id="ent-ends-hint" className="mt-1 text-xs text-muted">
                  {DATE_INPUT_HINT} Latest allowed: {fmt(maxEnd)} ({ENTITLEMENT_GRANT_MAX_DAYS} days counting today). Enforced by the server.
                </p>
                {endsOn.trim() !== '' && endsIso === null ? (
                  <p role="alert" className="mt-1 text-xs text-risk">
                    That is not a valid date. Use DD-MM-YYYY, like 01-10-2026.
                  </p>
                ) : null}
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
              {extensionsExhausted && (
                <p className="text-sm text-risk">
                  This grant has reached the extension limit. Revoking and granting again does not reset the lifetime limit of {PREMIUM_GRANT_LIFETIME_CEILING} grants and extensions per user, and going further needs an operator with the override capability.
                </p>
              )}
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
                      disabled={busy || !reasonOk || !dateOk || extensionsExhausted}
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

          <AdminActionStatus outcome={outcome} />

          {(limitHit || extensionsExhausted) && canOverride && selected && !protectedPaid && (
            <div className="space-y-2 rounded border border-risk/40 p-3" role="group" aria-labelledby="override-heading">
              <h3 id="override-heading" className="text-sm font-medium text-risk">
                Exceptional override of the grant limits
              </h3>
              <p className="text-xs text-muted">
                A limit was reached. You hold the separate override capability, so you may go past it once, with a reason of at least {OVERRIDE_REASON_MIN_LENGTH} characters.
                Every override raises an alert and leaves its own audit row.
              </p>
              <label htmlFor="ent-override-reason" className="block text-xs font-medium text-muted">
                Override reason (at least {OVERRIDE_REASON_MIN_LENGTH} characters)
              </label>
              <textarea
                id="ent-override-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={3}
                className="w-full max-w-xl rounded border px-3 py-2 text-sm"
              />
              <button
                type="button"
                disabled={busy || !overrideReasonOk || !dateOk}
                onClick={() => void submit(isAdminGrant ? 'extend' : 'grant', true)}
                className="rounded bg-risk px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {busy ? 'Working…' : isAdminGrant ? 'Override the limit and extend' : 'Override the limit and grant'}
              </button>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium text-ink">History</h3>
            {history === null && <p className="mt-1 text-sm text-muted">Loading…</p>}
            {history !== null && history.length === 0 && <p className="mt-1 text-sm text-muted">No admin changes recorded for this user.</p>}
            {history !== null && history.length > 0 && (
              <div className="mt-2 overflow-x-auto rounded-card border" tabIndex={0} role="region" aria-label="History table">
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
                        <td className="px-3 py-2">{formatDateTimeShort(h.created_at, 'AUD')}</td>
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
