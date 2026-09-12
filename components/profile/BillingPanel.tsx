'use client';

// LR-10 — the billing-country confirmation + checkout/upgrade + receipts UI.
// This is the first UI caller of both POST /api/user/billing-country/confirm
// (which existed since G1/migration 0122 but had no caller until now) and
// POST /api/payments/checkout. Kept as one panel (not split across pages)
// since the billing country a user picks directly determines which plans
// they can even see — showing them separately would let a user reach an
// "Upgrade" button for a region they haven't confirmed yet.

import { useEffect, useState } from 'react';
import { REGISTRATION_COUNTRY_OPTIONS } from '@/lib/services/countryGate';
import type { CountryCode } from '@/lib/services/jurisdiction';

interface PaymentStatus {
  billingCountry: CountryCode | null;
  billingConfirmed: boolean;
  planTier: 'free' | 'premium';
  provider: 'stripe' | 'razorpay' | null;
  subscriptionStatus: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  availablePlans: {
    priceId: string;
    provider: 'stripe' | 'razorpay';
    interval: 'monthly' | 'annual';
    currencyCode: string;
    displayAmount: string;
    configured: boolean;
  }[];
}

interface Receipt {
  id: string;
  issuedAt: string | null;
  amountFormatted: string;
  status: string;
  url: string | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment past due — retrying',
  canceled: 'Cancelled',
  incomplete: 'Awaiting first payment',
  incomplete_expired: 'Expired before payment completed',
  unpaid: 'Unpaid',
};

export function BillingPanel() {
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [countrySelection, setCountrySelection] = useState<CountryCode>('AU');
  const [countryBusy, setCountryBusy] = useState(false);
  const [countryError, setCountryError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function loadStatus() {
    const data = await fetchJson<PaymentStatus>('/api/payments/status');
    setStatus(data);
    if (data.billingCountry) setCountrySelection(data.billingCountry);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadStatus();
        const r = await fetchJson<Receipt[]>('/api/payments/invoices').catch(() => []);
        if (!cancelled) setReceipts(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirmCountry() {
    setCountryBusy(true);
    setCountryError(null);
    try {
      await fetchJson('/api/user/billing-country/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billing_country: countrySelection }),
      });
      await loadStatus();
    } catch (e) {
      setCountryError(e instanceof Error ? e.message : 'Could not confirm billing country.');
    } finally {
      setCountryBusy(false);
    }
  }

  async function startCheckout(priceId: string) {
    setCheckoutBusy(priceId);
    setCheckoutError(null);
    try {
      const result = await fetchJson<{ provider: string; url: string | null }>('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId }),
      });
      if (result.url) {
        window.location.assign(result.url);
      } else {
        setCheckoutError('Could not start checkout — no redirect URL was returned.');
      }
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : 'Could not start checkout.');
    } finally {
      setCheckoutBusy(null);
    }
  }

  if (loading || !status) return <p className="text-sm text-muted">Loading…</p>;

  const hasLiveSubscription = status.subscriptionStatus && ['active', 'trialing', 'past_due'].includes(status.subscriptionStatus);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink">
          Plan: <span className="font-medium">{status.planTier === 'premium' ? 'Premium' : 'Free'}</span>
          {status.subscriptionStatus && (
            <span className="ml-2 text-muted">({SUBSCRIPTION_STATUS_LABEL[status.subscriptionStatus] ?? status.subscriptionStatus})</span>
          )}
        </p>
        {hasLiveSubscription && status.currentPeriodEnd && (
          <p className="mt-1 text-xs text-muted">
            {status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {new Date(status.currentPeriodEnd).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })}
            {' · '}via {status.provider === 'stripe' ? 'Stripe' : 'Razorpay'}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="billing-country-select" className="block text-xs font-medium text-muted">
          Billing country
        </label>
        <p id="billing-country-helper" className="mt-1 text-xs text-muted">
          Determines which currency and payment provider are used for any subscription. This is separate from your
          country of residence.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select
            id="billing-country-select"
            value={countrySelection}
            onChange={(e) => setCountrySelection(e.target.value as CountryCode)}
            disabled={countryBusy}
            aria-invalid={!!countryError}
            aria-describedby={countryError ? 'billing-country-error' : 'billing-country-helper'}
            className="rounded border px-3 py-2 text-sm"
          >
            {REGISTRATION_COUNTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void confirmCountry()}
            disabled={countryBusy || (status.billingConfirmed && status.billingCountry === countrySelection)}
            className="rounded-full border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5 disabled:opacity-50"
          >
            {countryBusy ? 'Saving…' : status.billingConfirmed && status.billingCountry === countrySelection ? 'Confirmed' : 'Confirm billing country'}
          </button>
        </div>
        {/* G8.053 fix: neither error paragraph previously had role="alert"
            (unlike ConfirmCountryForm.tsx's equivalent case), so a screen-
            reader user got no announcement when a billing-country change was
            rejected. Both now carry role="alert" plus an id the select's own
            aria-describedby links to when an error is showing. */}
        {countryError === 'ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE' && (
          <p id="billing-country-error" role="alert" className="mt-2 text-sm text-risk">
            You have an active subscription tied to your current billing country. Contact support to move your
            subscription to a new region before changing this.
          </p>
        )}
        {countryError && countryError !== 'ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE' && (
          <p id="billing-country-error" role="alert" className="mt-2 text-sm text-risk">
            {countryError}
          </p>
        )}
      </div>

      {status.billingConfirmed && (
        <div>
          <p className="text-xs font-medium text-muted">Plans</p>
          {status.availablePlans.length === 0 ? (
            <p className="mt-1 text-sm text-muted">Premium isn&apos;t available for your billing region yet.</p>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {status.availablePlans.map((plan) => (
                <div key={plan.priceId} className="rounded border p-3">
                  <p className="text-sm font-medium text-ink">
                    {plan.interval === 'monthly' ? 'Monthly' : 'Annual'} — {plan.displayAmount}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startCheckout(plan.priceId)}
                    disabled={!plan.configured || checkoutBusy !== null || status.priceId === plan.priceId}
                    className="mt-2 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {status.priceId === plan.priceId
                      ? 'Current plan'
                      : !plan.configured
                        ? 'Not yet available'
                        : checkoutBusy === plan.priceId
                          ? 'Starting…'
                          : 'Upgrade'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {checkoutError && <p className="mt-2 text-sm text-risk">{checkoutError}</p>}
        </div>
      )}

      {receipts.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted">Receipts</p>
          <ul className="mt-2 space-y-1">
            {receipts.map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm">
                <span className="text-ink">
                  {r.issuedAt ? new Date(r.issuedAt).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Pending'}
                  {' — '}
                  {r.amountFormatted}
                  {' ('}
                  {r.status}
                  {')'}
                </span>
                {r.url && (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-trust hover:underline">
                    View
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
