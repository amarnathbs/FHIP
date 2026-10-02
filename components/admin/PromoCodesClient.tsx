'use client';

// Promo codes — admin console to create, list and disable promo codes.
//
// A convenience layer only (Admin Architecture Standard §4): every limit shown
// here (duration <= 365, an explicit choice for unlimited redemptions / no expiry,
// the unambiguous alphabet) is enforced independently by the route and the
// database function, and a refused request is simply displayed.

import { useEffect, useState } from 'react';
import { addDaysIso, utcToday } from '@/lib/services/entitlementWindow';
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';
import { DATE_INPUT_HINT, DATE_INPUT_PLACEHOLDER, formatDateInput, parseDateInput } from '@/lib/engines/dateInput';
import {
  PROMO_ALPHABET,
  PROMO_DEFAULT_DURATION_DAYS,
  PROMO_DEFAULT_MAX_REDEMPTIONS,
  PROMO_DISABLE_REASON_MIN_LENGTH,
  PROMO_MAX_DURATION_DAYS,
  formatPromoCode,
} from '@/lib/services/promoCodes';

interface PromoRow {
  id: string;
  code: string;
  code_hint: string;
  duration_days: number;
  max_redemptions: number | null;
  redemption_count: number;
  expires_on: string | null;
  note: string | null;
  status: 'active' | 'disabled';
  state: 'active' | 'disabled' | 'expired' | 'exhausted';
  created_at: string;
  created_by_email: string | null;
}

interface EventRow {
  id: string;
  created_at: string;
  event_type: 'create' | 'disable' | 'redeem';
  actor_email: string | null;
  code_hint: string;
  reason: string | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? 'Request failed');
  return json.data as T;
}

export function PromoCodesClient() {
  const today = utcToday();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: number; rows: PromoRow[]; events: EventRow[] } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ key: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const rows = loaded && loaded.key === reload ? loaded.rows : null;
  const events = loaded && loaded.key === reload ? loaded.events : null;
  const error = actionError ?? (loadFailure && loadFailure.key === reload ? loadFailure.message : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [code, setCode] = useState('');
  const [durationDays, setDurationDays] = useState(PROMO_DEFAULT_DURATION_DAYS);
  const [maxRedemptions, setMaxRedemptions] = useState(PROMO_DEFAULT_MAX_REDEMPTIONS);
  const [unlimited, setUnlimited] = useState(false);
  // Typed day-first (DD-MM-YYYY); converted to ISO for the API.
  const [expiresOn, setExpiresOn] = useState(formatDateInput(addDaysIso(today, 90)));
  const [noExpiry, setNoExpiry] = useState(false);
  const [note, setNote] = useState('');

  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchJson<PromoRow[]>('/api/admin/promo-codes');
        const ev = await fetchJson<EventRow[]>('/api/admin/promo-codes/events');
        if (!cancelled) setLoaded({ key: reload, rows: r, events: ev });
      } catch (e) {
        if (!cancelled) setLoadFailure({ key: reload, message: e instanceof Error ? e.message : 'Could not load promo codes' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function create() {
    const expiresIso = parseDateInput(expiresOn);
    if (!noExpiry && (expiresIso === null || expiresIso < today)) {
      setActionError('Enter the last day the code can be redeemed as DD-MM-YYYY, like 01-10-2026, and not before today. Or tick "No expiry".');
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const created = await fetchJson<{ code: string; duration_days?: number; ends_if_redeemed_today?: string }>('/api/admin/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim() === '' ? undefined : code,
          durationDays,
          ...(unlimited ? { unlimited: true } : { maxRedemptions }),
          ...(noExpiry ? { noExpiry: true } : { expiresOn: expiresIso }),
          note: note.trim() === '' ? undefined : note,
        }),
      });
      const days = created.duration_days ?? durationDays;
      const endsIfToday = created.ends_if_redeemed_today ?? addDaysIso(today, days);
      setNotice(
        `Promo code created: ${formatPromoCode(created.code)}. Each redemption gives ${days} day(s) of Premium; a user redeeming it today would have access until ${formatDateShort(endsIfToday, 'AUD')}. Copy the code now; it is also shown in the list below to promo-code admins.`
      );
      setCode('');
      setNote('');
      setReload((k) => k + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The code could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(id: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fetchJson(`/api/admin/promo-codes/${id}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      setNotice('Promo code disabled. Premium already granted by it is unchanged.');
      setDisablingId(null);
      setReason('');
      setReload((k) => k + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The code could not be disabled.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Promo Codes</h1>
        <p className="mt-1 text-muted">
          A user who enters a valid code on their Profile page gets free Premium for the code&apos;s duration (never more than {PROMO_MAX_DURATION_DAYS} days
          from the day they redeem it). A code cannot be applied on top of a paid subscription. Creating and disabling codes is audited.
        </p>
      </div>

      <section aria-labelledby="create-heading" className="space-y-3 rounded-card border p-4">
        <h2 id="create-heading" className="text-lg font-medium text-ink">
          Create a code
        </h2>
        <form
          className="grid max-w-2xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div>
            <label htmlFor="promo-code" className="block text-xs font-medium text-muted">
              Code (leave blank to generate one)
            </label>
            <input id="promo-code" value={code} onChange={(e) => setCode(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm uppercase" />
            <p className="mt-1 text-xs text-muted">
              6 to 24 characters from {PROMO_ALPHABET} (no 0, O, 1, I or L). Not case sensitive; spaces and hyphens are ignored.
            </p>
          </div>
          <div>
            <label htmlFor="promo-duration" className="block text-xs font-medium text-muted">
              Access length in days (1 to {PROMO_MAX_DURATION_DAYS}; default {PROMO_DEFAULT_DURATION_DAYS} = one month)
            </label>
            <input
              id="promo-duration"
              type="number"
              min={1}
              max={PROMO_MAX_DURATION_DAYS}
              value={durationDays}
              onChange={(e) => setDurationDays(Number(e.target.value))}
              className="mt-1 w-32 rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="promo-max" className="block text-xs font-medium text-muted">
              Maximum total redemptions
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <input
                id="promo-max"
                type="number"
                min={1}
                value={maxRedemptions}
                disabled={unlimited}
                onChange={(e) => setMaxRedemptions(Number(e.target.value))}
                className="w-32 rounded border px-3 py-2 text-sm disabled:opacity-50"
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
                Unlimited (explicit choice)
              </label>
            </div>
          </div>
          <div>
            <label htmlFor="promo-expiry" className="block text-xs font-medium text-muted">
              Code can be redeemed until (inclusive): the code&apos;s own redemption window, separate from the access length above
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <input
                id="promo-expiry"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder={DATE_INPUT_PLACEHOLDER}
                maxLength={10}
                aria-describedby="promo-expiry-hint"
                value={expiresOn}
                disabled={noExpiry}
                onChange={(e) => setExpiresOn(e.target.value)}
                className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
                No expiry (explicit choice)
              </label>
            </div>
            <p id="promo-expiry-hint" className="mt-1 text-xs text-muted">
              {DATE_INPUT_HINT}
            </p>
          </div>
          <div>
            <label htmlFor="promo-note" className="block text-xs font-medium text-muted">
              Note (optional, internal)
            </label>
            <input id="promo-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
          </div>
          <div>
            <button type="submit" disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Working…' : 'Create code'}
            </button>
          </div>
        </form>
        {notice && <p role="status" className="text-sm text-trust">{notice}</p>}
        {error && <p role="alert" className="text-sm text-risk">{error}</p>}
      </section>

      <section aria-labelledby="list-heading" className="space-y-3">
        <h2 id="list-heading" className="text-lg font-medium text-ink">
          Codes
        </h2>
        {rows === null && !error && <p className="text-sm text-muted">Loading…</p>}
        {rows !== null && rows.length === 0 && <p className="text-sm text-muted">No promo codes yet.</p>}
        {rows !== null && rows.length > 0 && (
          <div className="overflow-x-auto rounded-card border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2">Redeemed</th>
                  <th className="px-3 py-2">Redeemable until</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2 font-mono">{formatPromoCode(r.code)}</td>
                    <td className="px-3 py-2 capitalize">{r.state}</td>
                    <td className="px-3 py-2">{r.duration_days}</td>
                    <td className="px-3 py-2">
                      {r.redemption_count} / {r.max_redemptions ?? 'unlimited'}
                    </td>
                    <td className="px-3 py-2">{r.expires_on ? formatDateShort(r.expires_on, 'AUD') : 'no expiry'}</td>
                    <td className="px-3 py-2 text-muted">{r.note ?? '—'}</td>
                    <td className="px-3 py-2">
                      {r.status === 'disabled' ? (
                        <span className="text-xs text-muted">Disabled</span>
                      ) : disablingId === r.id ? (
                        <div className="space-y-2">
                          <label htmlFor={`disable-reason-${r.id}`} className="block text-xs text-muted">
                            Reason (at least {PROMO_DISABLE_REASON_MIN_LENGTH} characters)
                          </label>
                          <input
                            id={`disable-reason-${r.id}`}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            className="w-64 rounded border px-2 py-1 text-sm"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busy || reason.trim().length < PROMO_DISABLE_REASON_MIN_LENGTH}
                              onClick={() => void disable(r.id)}
                              className="rounded bg-risk px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                            >
                              Confirm disable
                            </button>
                            <button type="button" onClick={() => setDisablingId(null)} className="text-xs text-gray-500 hover:underline">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDisablingId(r.id);
                            setReason('');
                          }}
                          className="rounded border border-risk px-2 py-1 text-xs font-medium text-risk hover:bg-risk/5"
                        >
                          Disable
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="events-heading" className="space-y-3">
        <h2 id="events-heading" className="text-lg font-medium text-ink">
          Audit trail
        </h2>
        <p className="text-xs text-muted">Shows the code id hint only (never a code value). Redemptions are listed with the redeeming account&apos;s email.</p>
        {events !== null && events.length === 0 && <p className="text-sm text-muted">No events yet.</p>}
        {events !== null && events.length > 0 && (
          <div className="overflow-x-auto rounded-card border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-t">
                    <td className="px-3 py-2">{formatDateTimeShort(ev.created_at, 'AUD')}</td>
                    <td className="px-3 py-2 capitalize">{ev.event_type}</td>
                    <td className="px-3 py-2 font-mono">{ev.code_hint}</td>
                    <td className="px-3 py-2">{ev.actor_email ?? '(account no longer exists)'}</td>
                    <td className="px-3 py-2">{ev.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
