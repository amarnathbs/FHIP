'use client';

// Promo codes: the Admin-visible setup check (hardening, deploy safety).
//
// Shows which server variables are missing, too short or reused (names and states, never a value), which actions are therefore
// switched off, how many existing codes still wait for the hash-only preparation (with the button that does it), and the
// network address probe. A convenience layer only (Admin Architecture Standard section 4): every refusal it explains is enforced
// by the route and the database, and it is the visible half of the fail-closed rule (section 13): a feature that refuses says
// why, where the person who can fix it will read it.

import { useCallback, useEffect, useState } from 'react';
import { AdminActionStatus, type AdminActionOutcome } from '@/components/admin/AdminActionStatus';

interface Health {
  minimumSecretLength: number;
  secrets: { name: string; purpose: string; status: 'ok' | 'missing' | 'too_short' | 'reused' }[];
  features: { feature: string; label: string; available: boolean; blockedBy: string[] }[];
  emailSwitchOn: boolean;
  trustedProxyHops: number | null;
  allAvailable: boolean;
  databaseReady: boolean;
  existingCodes: { total: number; stillStoredInPlainText: number; waitingForPreparation: number; withProtectedCopy: number } | null;
}

interface NetworkCheck {
  configuredHops: number | null;
  entries: string[];
  chosenFromRight: number | null;
  chosenAddress: string | null;
  reason: string | null;
}

const STATUS_TEXT: Record<Health['secrets'][number]['status'], string> = {
  ok: 'set',
  missing: 'NOT SET',
  too_short: 'TOO SHORT',
  reused: 'SAME VALUE AS ANOTHER SECRET',
};

const REASON_TEXT: Record<string, string> = {
  invalid_setting: 'The trusted hop setting is not a whole number from 1 to 5, so no address is used.',
  no_header: 'This request carried no X-Forwarded-For header, so no address is used (this is normal when you run the site on your own computer).',
  shorter_than_hops: 'The header has fewer entries than the trusted hop count, so no address is used.',
  not_an_address: 'The chosen entry is not an address, so no address is used.',
  not_public: 'The chosen entry is a private or internal address, so no address is used. The hop count is probably too high or too low.',
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? 'Request failed');
  return json.data as T;
}

export function PromoSetupCheck() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AdminActionOutcome>(null);
  const [network, setNetwork] = useState<NetworkCheck | null>(null);

  const load = useCallback(async () => {
    try {
      setHealth(await getJson<Health>('/api/admin/promo-codes/health'));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'The setup check could not be loaded.');
    }
  }, []);

  useEffect(() => {
    // Fetch on mount. The state update happens after the request settles, never synchronously in the effect.
    let cancelled = false;
    (async () => {
      try {
        const h = await getJson<Health>('/api/admin/promo-codes/health');
        if (!cancelled) {
          setHealth(h);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'The setup check could not be loaded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function prepare() {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await getJson<{ rowsSeen: number; rowsVerified: number; rowsNotVerified: number; stalled: boolean }>('/api/admin/promo-codes/digest-backfill', { method: 'POST' });
      setOutcome(
        r.rowsNotVerified > 0
          ? { kind: 'failure', message: `${r.rowsVerified} of ${r.rowsSeen} existing codes were prepared. ${r.rowsNotVerified} could not be verified and still work as before. Run it again, and if it repeats, stop and tell the developer.` }
          : { kind: 'success', message: r.rowsSeen === 0 ? 'Nothing to prepare: every existing code already has a verified protected copy.' : `${r.rowsVerified} existing codes now have a verified protected copy. They still work exactly as before. Nothing was removed.` }
      );
      await load();
    } catch (e) {
      setOutcome({ kind: 'failure', message: e instanceof Error ? e.message : 'The preparation could not run.' });
    } finally {
      setBusy(false);
    }
  }

  async function checkNetwork() {
    setBusy(true);
    setOutcome(null);
    try {
      setNetwork(await getJson<NetworkCheck>('/api/admin/promo-codes/network-check'));
    } catch (e) {
      setOutcome({ kind: 'failure', message: e instanceof Error ? e.message : 'The network check could not run.' });
    } finally {
      setBusy(false);
    }
  }

  const broken = health ? health.secrets.filter((s) => s.status !== 'ok') : [];

  return (
    <section aria-labelledby="setup-heading" className="space-y-3 rounded-card border p-4">
      <h2 id="setup-heading" className="text-lg font-medium text-ink">
        Setup check
      </h2>
      {loadError && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 px-3 py-2 text-sm font-medium text-risk">
          {loadError}
        </p>
      )}
      {!health && !loadError && <p className="text-sm text-muted">Checking the server setup…</p>}

      {health && (
        <>
          {health.allAvailable ? (
            <p role="status" className="text-sm text-ink">
              Every required server secret is set. Creating, e-mailing and redeeming codes are all available.
            </p>
          ) : (
            <div role="alert" className="space-y-2 rounded-compact border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
              <p className="font-medium">Some promo code actions are switched off until the server secrets are fixed. Nothing is broken or lost: the actions below simply refuse.</p>
              <ul className="list-disc pl-5">
                {health.features
                  .filter((f) => !f.available)
                  .map((f) => (
                    <li key={f.feature}>
                      {f.label}: switched off. Fix: {f.blockedBy.join(', ')}.
                    </li>
                  ))}
              </ul>
              <p>Set the variables in the hosting console (each at least {health.minimumSecretLength} characters, all different), then redeploy. The developer hand-over lists the exact names.</p>
            </div>
          )}

          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Server secrets and their state">
          <table className="min-w-full text-sm">
            <caption className="sr-only">The four dedicated server secrets and whether each is set</caption>
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th scope="col" className="px-2 py-1">Server variable</th>
                <th scope="col" className="px-2 py-1">State</th>
                <th scope="col" className="px-2 py-1">What it does</th>
              </tr>
            </thead>
            <tbody>
              {health.secrets.map((s) => (
                <tr key={s.name} className="border-t align-top">
                  <th scope="row" className="px-2 py-1 text-left font-mono font-normal">{s.name}</th>
                  <td className={`px-2 py-1 ${s.status === 'ok' ? 'text-ink' : 'font-medium text-risk'}`}>{STATUS_TEXT[s.status]}</td>
                  <td className="px-2 py-1 text-muted">{s.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {broken.length > 0 && <p className="text-xs text-muted">Values are never shown here, only whether they are set.</p>}
          <p className="text-sm text-muted">
            E-mailing codes is currently <strong>{health.emailSwitchOn ? 'switched on' : 'switched off'}</strong> (the PREMIUM_PROMO_EMAIL_ENABLED setting).
          </p>

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium text-ink">Codes created before hash-only storage</h3>
            {!health.databaseReady && (
              <p className="text-sm text-muted">The database update for this release has not been applied yet, so there is nothing to prepare. Existing codes keep working.</p>
            )}
            {health.databaseReady && health.existingCodes && (
              <>
                <p className="text-sm text-muted">
                  {health.existingCodes.total} codes in total. {health.existingCodes.stillStoredInPlainText} still hold their text in the database, of which{' '}
                  {health.existingCodes.waitingForPreparation} are waiting for a verified protected copy. Preparing them is safe to repeat and removes nothing: every existing code
                  keeps working at every step. The developer removes the stored text in a separate, deliberate step after you have checked a code still works.
                </p>
                <button
                  type="button"
                  disabled={busy || !health.features.find((f) => f.feature === 'create')?.available || health.existingCodes.waitingForPreparation === 0}
                  onClick={() => void prepare()}
                  className="rounded-full border border-trust px-4 py-2 text-sm font-medium text-trust disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Prepare existing codes'}
                </button>
              </>
            )}
          </div>

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium text-ink">Network address check</h3>
            <p className="text-xs text-muted">
              Redemption limits repeated attempts per network address. Which entry of the address list belongs to the visitor depends on how many trusted servers sit in front of this
              site (now {health.trustedProxyHops === null ? 'an invalid setting' : health.trustedProxyHops}). Press the button on the deployed site: if the address chosen is your own
              public address, the setting is right.
            </p>
            <button type="button" disabled={busy} onClick={() => void checkNetwork()} className="rounded-full border border-trust px-4 py-2 text-sm font-medium text-trust disabled:opacity-50">
              {busy ? 'Working…' : 'Check my network address'}
            </button>
            {network && (
              <div role="status" className="text-sm">
                <p>Address list received: {network.entries.length === 0 ? 'none' : network.entries.join(', ')}.</p>
                {network.chosenAddress ? (
                  <p>
                    The entry that would be used: <span className="font-mono">{network.chosenAddress}</span> (number {network.chosenFromRight} from the right). It is right if this is your own public address.
                  </p>
                ) : (
                  <p>No address would be used. {network.reason ? REASON_TEXT[network.reason] : ''} Only the per-user limit applies.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
      <AdminActionStatus outcome={outcome} />
    </section>
  );
}
