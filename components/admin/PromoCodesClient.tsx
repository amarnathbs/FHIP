'use client';

// Promo codes — admin console to create, list and disable promo codes.
//
// A convenience layer only (Admin Architecture Standard §4): every limit shown
// here (duration <= 365, an explicit choice for unlimited redemptions / no expiry,
// the unambiguous alphabet) is enforced independently by the route and the
// database function, and a refused request is simply displayed.

import { useEffect, useState } from 'react';
import { accessEndDate, addDaysIso, utcToday } from '@/lib/services/entitlementWindow';
import { AdminActionStatus, type AdminActionOutcome } from '@/components/admin/AdminActionStatus';
import { PromoSetupCheck } from '@/components/admin/PromoSetupCheck';
import { PROMO_EMAIL_PURPOSE_MAX, PROMO_EMAIL_PURPOSE_MIN } from '@/lib/services/promoEmailAbuse';
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
  /** Hash only storage (hardening 0264): the list carries a masked hint, never a code. */
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
  bound?: boolean;
  ends_if_redeemed_today?: string | null;
}

type RecipientStatus = 'sent' | 'failed' | 'not_sent' | 'unknown';

interface DispatchedCode {
  id: string;
  code_hint: string;
  duration_days: number;
  ends_if_redeemed_today: string | null;
  bound: boolean;
  /** Present only when an e-mail was not (fully) sent: the show-once fallback. */
  code?: string;
  recipients: { index: number; status: RecipientStatus }[];
}

interface DispatchResponse {
  codes: DispatchedCode[];
  email: { enabled: boolean; message: string | null };
  partialError?: { message: string };
}

const newRequestKey = () => globalThis.crypto.randomUUID();
const STATUS_TEXT: Record<RecipientStatus, string> = {
  sent: 'e-mail sent',
  failed: 'e-mail could not be sent',
  not_sent: 'e-mail not sent',
  unknown: 'outcome not recorded (do not assume it was delivered)',
};
const LAST_KEY_STORAGE = 'fhip.promo.lastRequestKey';

/** The request key survives a refresh in this tab only (never the addresses and never a code). Storage may be blocked. */
function rememberRequestKey(key: string) {
  try {
    window.sessionStorage.setItem(LAST_KEY_STORAGE, key);
  } catch {
    /* storage unavailable: the admin can still type the key from the notice */
  }
}
function recalledRequestKey(): string {
  try {
    return window.sessionStorage.getItem(LAST_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly payload: { recipients?: { index: number; status: RecipientStatus }[] } | null
  ) {
    super(message);
  }
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
  if (!res.ok) throw new ApiError(json.message ?? json.error ?? 'Request failed', json);
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
  const outcome: AdminActionOutcome = error ? { kind: 'failure', message: error } : notice ? { kind: 'success', message: notice } : null;
  const [busy, setBusy] = useState(false);

  const [code, setCode] = useState('');
  const [durationDays, setDurationDays] = useState(PROMO_DEFAULT_DURATION_DAYS);
  const [maxRedemptions, setMaxRedemptions] = useState(PROMO_DEFAULT_MAX_REDEMPTIONS);
  const [unlimited, setUnlimited] = useState(false);
  // Typed day-first (DD-MM-YYYY); converted to ISO for the API.
  const [expiresOn, setExpiresOn] = useState(formatDateInput(addDaysIso(today, 90)));
  const [noExpiry, setNoExpiry] = useState(false);
  const [note, setNote] = useState('');
  // E-mailing a new code (all optional). One request key per submit attempt: a double-click or retry reuses it.
  const [emailTo, setEmailTo] = useState('');
  const [bindToRecipient, setBindToRecipient] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [statusReport, setStatusReport] = useState<{ index: number; status: RecipientStatus }[] | null>(null);
  const [statusKey, setStatusKey] = useState('');
  const [statusTo, setStatusTo] = useState('');
  const [dispatchResult, setDispatchResult] = useState<DispatchResponse | null>(null);
  // Replacing an existing code and e-mailing the NEW one.
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [replaceTo, setReplaceTo] = useState('');
  const [replaceBind, setReplaceBind] = useState(false);
  const [replaceKey, setReplaceKey] = useState(newRequestKey);
  const [replacePurpose, setReplacePurpose] = useState('');

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
    setDispatchResult(null);
    try {
      const wantsEmail = emailTo.trim() !== '';
      const created = await fetchJson<{ code: string; duration_days?: number; ends_if_redeemed_today?: string } & Partial<DispatchResponse>>('/api/admin/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim() === '' ? undefined : code,
          durationDays,
          ...(unlimited ? { unlimited: true } : { maxRedemptions }),
          ...(noExpiry ? { noExpiry: true } : { expiresOn: expiresIso }),
          note: note.trim() === '' ? undefined : note,
          ...(wantsEmail ? { emailTo, bindToRecipient, idempotencyKey: requestKey, purpose } : {}),
        }),
      });
      if (wantsEmail) rememberRequestKey(requestKey);
      if (created.codes) {
        // E-mail dispatch response: the plaintext is present only for codes whose e-mail was not fully sent.
        setDispatchResult(created as DispatchResponse);
        setEmailTo('');
        setBindToRecipient(false);
        setPurpose('');
        setRequestKey(newRequestKey());
        setCode('');
        setNote('');
        setReload((k) => k + 1);
        return;
      }
      const days = created.duration_days ?? durationDays;
      const endsIfToday = created.ends_if_redeemed_today ?? accessEndDate(today, days);
      setNotice(
        `Promo code created: ${formatPromoCode(created.code)}. Copy it now. It is shown only this once and cannot be shown again (the list below keeps only a masked hint). Each redemption gives ${days} day(s) of Premium counting the day of redemption; a user redeeming it today would have access until ${formatDateShort(endsIfToday, 'AUD')}.`
      );
      setCode('');
      setNote('');
      setReload((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && e.payload?.recipients) setStatusReport(e.payload.recipients);
      setActionError(e instanceof Error ? e.message : 'The code could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function replaceAndEmail(id: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setDispatchResult(null);
    try {
      const out = await fetchJson<DispatchResponse>(`/api/admin/promo-codes/${id}/replace-and-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailTo: replaceTo, bindToRecipient: replaceBind, idempotencyKey: replaceKey, purpose: replacePurpose }),
      });
      rememberRequestKey(replaceKey);
      setDispatchResult(out);
      setReplacingId(null);
      setReplaceTo('');
      setReplaceBind(false);
      setReplacePurpose('');
      setReplaceKey(newRequestKey());
      setReload((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && e.payload?.recipients) setStatusReport(e.payload.recipients);
      setActionError(e instanceof Error ? e.message : 'The replacement code could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const out = await fetchJson<{ requestExists: boolean; recipients: { index: number; status: RecipientStatus }[] }>('/api/admin/promo-codes/email-requests/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestKey: statusKey.trim(), emailTo: statusTo }),
      });
      setStatusReport(out.recipients);
      if (!out.requestExists) setNotice('No request with that key was found for your account. Nothing was sent for it.');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The status could not be read.');
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
          A user who enters a valid code on their Profile page gets free Premium for the code&apos;s duration (never more than {PROMO_MAX_DURATION_DAYS} days,
          counting the day they redeem it). A code is shown to you once, when it is created. It cannot be retrieved afterwards: the list keeps only a masked hint. A code cannot be applied on top of a paid subscription. Creating and disabling codes is audited.
        </p>
      </div>

      <PromoSetupCheck />

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
              Access length in days, counting the day of redemption (1 to {PROMO_MAX_DURATION_DAYS}; default {PROMO_DEFAULT_DURATION_DAYS} = one month)
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
            <label htmlFor="promo-email-to" className="block text-xs font-medium text-muted">
              Email this code to (optional; up to 20 addresses, separated by commas or new lines)
            </label>
            <textarea
              id="promo-email-to"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              rows={2}
              autoComplete="off"
              aria-describedby="promo-email-hint"
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
            <p id="promo-email-hint" className="mt-1 text-xs text-muted">
              The code is e-mailed once from this request and shown to you only if an e-mail could not be sent. Leave blank to just create the code.
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={bindToRecipient} disabled={emailTo.trim() === ''} onChange={(e) => setBindToRecipient(e.target.checked)} />
              Only this email address can redeem (one single-use code per address)
            </label>
            <p className="mt-1 text-xs text-muted">
              A bound code works only for an account that has that address, verified. If the person later changes their address the code stops working
              for them, and you must issue a new one (nothing is re-bound silently).
            </p>
          </div>
          {emailTo.trim() !== '' && (
            <div>
              <label htmlFor="promo-purpose" className="block text-xs font-medium text-muted">
                Why are you sending this code? ({PROMO_EMAIL_PURPOSE_MIN} to {PROMO_EMAIL_PURPOSE_MAX} characters, recorded in the audit trail)
              </label>
              <input
                id="promo-purpose"
                value={purpose}
                maxLength={PROMO_EMAIL_PURPOSE_MAX}
                onChange={(e) => setPurpose(e.target.value)}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </div>
          )}
          <div>
            <button type="submit" disabled={busy || (emailTo.trim() !== '' && purpose.trim().length < PROMO_EMAIL_PURPOSE_MIN)} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Working…' : emailTo.trim() === '' ? 'Create code' : 'Create code and email it'}
            </button>
          </div>
        </form>
        <AdminActionStatus outcome={outcome} />
        {dispatchResult && (
          <div role="status" className="space-y-3 rounded border border-trust/30 bg-trust/5 p-3 text-sm">
            {dispatchResult.email.message && <p className="font-medium text-ink">{dispatchResult.email.message}</p>}
            {dispatchResult.partialError && <p role="alert" className="text-risk">{dispatchResult.partialError.message}</p>}
            {dispatchResult.codes.map((c) => (
              <div key={c.id}>
                <p>
                  Code {c.code_hint}: {c.duration_days} day(s) of Premium counting the day of redemption
                  {c.bound ? ', only redeemable by the address it was sent to' : ''}.{' '}
                  {c.ends_if_redeemed_today ? `Redeemed today it would end on ${formatDateShort(c.ends_if_redeemed_today, 'AUD')}.` : ''}
                </p>
                {c.recipients.length > 0 && (
                  <ul className="list-disc pl-5 text-muted">
                    {c.recipients.map((r) => (
                      <li key={r.index}>
                        Recipient {r.index + 1}: {STATUS_TEXT[r.status]}
                      </li>
                    ))}
                  </ul>
                )}
                {c.code ? (
                  <p className="mt-1">
                    Copy this code now, it is shown only this once: <span className="font-mono font-medium">{formatPromoCode(c.code)}</span>
                  </p>
                ) : (
                  <p className="mt-1 text-muted">The code was e-mailed and is not shown here.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="status-heading" className="space-y-3 rounded-card border p-4">
        <h2 id="status-heading" className="text-lg font-medium text-ink">
          Check the delivery status of an earlier e-mail request
        </h2>
        <p className="text-xs text-muted">
          Use this after a refresh, a lost connection or a partly failed send. Enter the request key and the same addresses again. You will see, for each address,
          whether the e-mail was sent. A code is never shown here: for anyone who did not get it, use &quot;Generate a replacement code and email it&quot; below.
        </p>
        <form
          className="grid max-w-2xl gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void checkStatus();
          }}
        >
          <div>
            <label htmlFor="status-key" className="block text-xs font-medium text-muted">
              Request key (kept in this tab after a send; 8 to 100 letters, digits, hyphen or underscore)
            </label>
            <input
              id="status-key"
              value={statusKey}
              onChange={(e) => setStatusKey(e.target.value)}
              onFocus={() => {
                if (statusKey === '') setStatusKey(recalledRequestKey());
              }}
              autoComplete="off"
              className="mt-1 w-full rounded border px-3 py-2 font-mono text-sm"
            />
          </div>
          <div>
            <label htmlFor="status-to" className="block text-xs font-medium text-muted">
              The addresses you sent to, in the same order
            </label>
            <textarea id="status-to" value={statusTo} onChange={(e) => setStatusTo(e.target.value)} rows={2} autoComplete="off" className="mt-1 w-full rounded border px-3 py-2 text-sm" />
          </div>
          <div>
            <button type="submit" disabled={busy || statusKey.trim() === '' || statusTo.trim() === ''} className="rounded-full border border-trust px-4 py-2 text-sm font-medium text-trust disabled:opacity-50">
              {busy ? 'Working…' : 'Check status'}
            </button>
          </div>
        </form>
        {statusReport && (
          <ul className="list-disc pl-5 text-sm" aria-label="Delivery status per recipient">
            {statusReport.map((r) => (
              <li key={r.index}>
                Recipient {r.index + 1}: {STATUS_TEXT[r.status]}
              </li>
            ))}
          </ul>
        )}
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
                  <th className="px-3 py-2">Code (masked)</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2">Redeemed</th>
                  <th className="px-3 py-2">Redeemable until</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2">Address-bound</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2 font-mono">{r.code_hint}</td>
                    <td className="px-3 py-2 capitalize">{r.state}</td>
                    <td className="px-3 py-2">{r.duration_days}</td>
                    <td className="px-3 py-2">
                      {r.redemption_count} / {r.max_redemptions ?? 'unlimited'}
                    </td>
                    <td className="px-3 py-2">{r.expires_on ? formatDateShort(r.expires_on, 'AUD') : 'no expiry'}</td>
                    <td className="px-3 py-2 text-muted">{r.note ?? '—'}</td>
                    <td className="px-3 py-2 text-muted">{r.bound ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2">
                      {r.state === 'active' && replacingId !== r.id && disablingId !== r.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setReplacingId(r.id);
                            setReplaceTo('');
                            setReplaceBind(false);
                            setReplaceKey(newRequestKey());
                          }}
                          className="mb-2 block rounded border border-trust px-2 py-1 text-xs font-medium text-trust hover:bg-trust/5"
                        >
                          Generate a replacement code and email it
                        </button>
                      )}
                      {replacingId === r.id ? (
                        <div className="space-y-2">
                          <label htmlFor={`replace-to-${r.id}`} className="block text-xs text-muted">
                            Email the NEW code to (up to 20 addresses)
                          </label>
                          <textarea
                            id={`replace-to-${r.id}`}
                            value={replaceTo}
                            onChange={(e) => setReplaceTo(e.target.value)}
                            rows={2}
                            className="w-64 rounded border px-2 py-1 text-sm"
                          />
                          <label className="flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={replaceBind} onChange={(e) => setReplaceBind(e.target.checked)} />
                            Only this email address can redeem
                          </label>
                          <label htmlFor={`replace-purpose-${r.id}`} className="block text-xs text-muted">
                            Why? ({PROMO_EMAIL_PURPOSE_MIN} to {PROMO_EMAIL_PURPOSE_MAX} characters, audited)
                          </label>
                          <input
                            id={`replace-purpose-${r.id}`}
                            value={replacePurpose}
                            maxLength={PROMO_EMAIL_PURPOSE_MAX}
                            onChange={(e) => setReplacePurpose(e.target.value)}
                            className="w-64 rounded border px-2 py-1 text-sm"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busy || replaceTo.trim() === '' || replacePurpose.trim().length < PROMO_EMAIL_PURPOSE_MIN}
                              onClick={() => void replaceAndEmail(r.id)}
                              className="rounded bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                            >
                              {busy ? 'Working…' : 'Generate and email'}
                            </button>
                            <button type="button" onClick={() => setReplacingId(null)} className="text-xs text-gray-500 hover:underline">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
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
