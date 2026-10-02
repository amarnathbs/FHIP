'use client';

/**
 * Investments tab -- how each published mutual fund in Net Worth was valued
 * (PO decision 2026-10-01: Net Worth uses the latest eligible NAV).
 *
 * For every Investment Intelligence mutual fund counted in Net Worth this shows
 * the value, the units, the NAV per unit, the NAV's OWN date and a tag from the
 * shared valuation rule: "Latest NAV", "Statement value" (no newer NAV on file --
 * never presented as a market NAV), "Stale NAV" (the NAV or statement is more than
 * a week old) or "Redeemed" (0 units, counted as 0). Nothing here is a second
 * calculation: the numbers are the canonical Investments read model's own.
 *
 * Talks to one API route; renders nothing for a user with no published funds.
 */

import { useEffect, useState } from 'react';
import { fmtDate } from '@/components/investment-intelligence/dateDisplay';

export interface Valuation {
  basis: 'market_nav' | 'statement' | 'redeemed';
  asOf: string | null;
  units: number | null;
  nav: number | null;
  tag: 'latest_nav' | 'statement_value' | 'stale_nav' | 'redeemed';
  label: string;
  stale: boolean;
  ageDays: number | null;
}
export interface Line {
  id: string;
  name: string;
  owner: string | null;
  currency: string;
  value: number;
  valuation: Valuation;
}

const money = (v: number, currency: string) =>
  new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

const TAG_CLASS: Record<Valuation['tag'], string> = {
  latest_nav: 'bg-green-50 text-green-800',
  statement_value: 'bg-gray-100 text-gray-800',
  stale_nav: 'bg-amber-50 text-amber-900',
  redeemed: 'bg-gray-100 text-gray-800',
};

const TAG_HINT: Record<Valuation['tag'], string> = {
  latest_nav: 'Units x the latest NAV on file.',
  statement_value: 'Your statement value: no newer NAV is on file. It is not a market NAV.',
  stale_nav: 'The NAV (or statement) is more than a week old and may be out of date.',
  redeemed: 'Fully redeemed (0 units); counted as 0.',
};

export function PublishedFundValuations({ refreshKey }: { refreshKey?: number }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/investments/published-valuations')
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? 'Fund valuations could not be loaded.');
          return;
        }
        setLines((json.data?.lines as Line[]) ?? []);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError('Fund valuations could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) return <p className="text-sm text-muted">{error}</p>;
  if (!lines || lines.length === 0) return null;
  return <PublishedFundValuationsTable lines={lines} />;
}

/** Presentational table (exported so it can be rendered and asserted without a network call). */
export function PublishedFundValuationsTable({ lines }: { lines: readonly Line[] }) {
  return (
    <section aria-labelledby="published-fund-valuations-heading" className="space-y-2 rounded border border-gray-200 p-4">
      <h2 id="published-fund-valuations-heading" className="text-base font-semibold text-trust">
        Mutual funds in your Net Worth
      </h2>
      <p className="text-sm text-muted">Each fund is valued at units x the latest NAV on file, with the NAV&apos;s own date. Where no newer NAV exists the statement value is shown and labelled.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Fund</th>
              <th className="py-1 pr-3 text-right font-medium">Units</th>
              <th className="py-1 pr-3 text-right font-medium">NAV</th>
              <th className="py-1 pr-3 font-medium">NAV date</th>
              <th className="py-1 pr-3 text-right font-medium">Value</th>
              <th className="py-1 font-medium">Basis</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-gray-100">
                <td className="py-1 pr-3">{l.name}</td>
                <td className="py-1 pr-3 text-right">{l.valuation.units === null ? '—' : l.valuation.units.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                <td className="py-1 pr-3 text-right">{l.valuation.nav === null ? '—' : money(l.valuation.nav, l.currency)}</td>
                <td className="py-1 pr-3">{l.valuation.asOf ? fmtDate(l.valuation.asOf, l.currency) : '—'}</td>
                <td className="py-1 pr-3 text-right font-medium">{money(l.value, l.currency)}</td>
                <td className="py-1">
                  <span className={`rounded px-2 py-0.5 text-xs ${TAG_CLASS[l.valuation.tag]}`} title={TAG_HINT[l.valuation.tag]}>
                    {l.valuation.label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
