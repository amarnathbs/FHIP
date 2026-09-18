'use client';

import { useEffect, useState } from 'react';
import { fmtDate } from './dateDisplay';
import { TransactionDetailModal } from './TransactionDetailModal';

// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// The "Holdings" table, matching the Product Owner's own reference
// workbook's Holdings tab column-for-column: Folio No., ISIN, Scheme Code,
// Scheme Name, Cost Value, Unit Balance, NAV Date, NAV, Market Value,
// Registrar, Gain/(Loss), Return %, XIRR. Additive to the existing
// "Scheme performance" table (SchemeTable in PerformanceClient.tsx, kept
// unchanged) — that table answers "how did this scheme perform against its
// benchmark", this one answers "what do I actually hold, at what cost, and
// what is it worth today", the same two questions the PO's workbook itself
// keeps as separate tabs.
//
// A row's Cost Value/Units/Market Value/Gain-Loss/XIRR are replaced by an
// honest "data quality" badge instead of a number whenever the underlying
// scheme failed the existing PC4 unit-reconciliation check and no
// AI-fallback correction is available — never a silently-wrong figure.

interface DataQuality {
  status: 'ok' | 'ai_corrected' | 'unresolved';
  detail: string | null;
}

interface XirrOutcomeView {
  status: string;
  value?: { rate: number };
  detail?: string;
}

interface HoldingRowView {
  accountId: string;
  instrumentId: string;
  folioNumber: string | null;
  isin: string | null;
  schemeCode: string | null;
  schemeName: string;
  registrar: string | null;
  costValue: number | null;
  unitBalance: number | null;
  navDate: string | null;
  nav: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  returnPct: number | null;
  xirr: XirrOutcomeView;
  currencyCode: string;
  dataQuality: DataQuality;
}

interface HoldingsApiPayload {
  holdings: HoldingRowView[];
  warnings: Array<{ scope: string; detail: string }>;
  empty: boolean;
}

// Full scheme names routinely run 60-100+ characters and were wrapping
// across 5-6 lines per row, making the table unreadable. Truncated for
// this summary row only — the full name is still shown, untruncated, in
// the transaction-detail popup's own heading (aria-label below is also
// left untruncated for the same reason).
const SCHEME_NAME_MAX_CHARS = 28;
function truncateSchemeName(name: string): string {
  return name.length > SCHEME_NAME_MAX_CHARS ? `${name.slice(0, SCHEME_NAME_MAX_CHARS).trimEnd()}…` : name;
}

function money(v: number | null, currency: string): string {
  if (v === null || !Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

function num(v: number | null, digits = 3): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

const QUALITY_BADGE: Record<DataQuality['status'], { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-green-50 text-green-700 border-green-200' },
  ai_corrected: { label: 'AI-corrected', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  unresolved: { label: 'Data quality issue', className: 'bg-amber-50 text-amber-800 border-amber-200' },
};

export function HoldingsTable() {
  const [payload, setPayload] = useState<HoldingsApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ accountId: string; instrumentId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/holdings');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Holdings could not be loaded.');
        else setPayload(json.data as HoldingsApiPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Holdings could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted">Loading holdings…</p>;
  if (error) return <p className="rounded-card border border-risk bg-white p-4 text-sm text-risk">{error}</p>;
  if (!payload) return null;
  if (payload.empty || payload.holdings.length === 0) {
    return (
      <p className="rounded-card border border-line bg-white p-4 text-sm text-muted">
        No holdings could be matched to a resolved position yet. If you have just processed a statement, this can take a moment to catch up —
        try reloading. If it persists, this is worth reporting.
      </p>
    );
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink">Holdings</h2>
      <p className="mb-4 text-sm text-muted">
        What you actually hold, at cost and at today&apos;s market value, for each scheme. Select a row to see its full transaction history and how its
        XIRR was derived.
      </p>
      {/* Bounded height with its own vertical scroll, not just horizontal —
          without this, the horizontal scrollbar sits at the very bottom of
          the FULL row list (17+ rows tall), forcing a user to scroll all the
          way down before they can even reach it to see the right-hand
          columns. Bounding the box keeps both scrollbars reachable together.
          The header is sticky within this same box so column labels stay
          visible while scrolling through rows. */}
      <div className="max-h-[520px] overflow-auto rounded-card border border-line">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-4 font-medium">Scheme</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">Folio</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">ISIN</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">Registrar</th>
              <th className="py-2 pr-4 font-medium text-right whitespace-nowrap">Cost value</th>
              <th className="py-2 pr-4 font-medium text-right whitespace-nowrap">Units</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">NAV date</th>
              <th className="py-2 pr-4 font-medium text-right">NAV</th>
              <th className="py-2 pr-4 font-medium text-right">Market value</th>
              <th className="py-2 pr-4 font-medium text-right">Gain/(Loss)</th>
              <th className="py-2 pr-4 font-medium text-right">Return %</th>
              <th className="py-2 pr-4 font-medium text-right">XIRR</th>
              <th className="py-2 pr-4 font-medium">Data quality</th>
            </tr>
          </thead>
          <tbody>
            {payload.holdings.map((h) => {
              const badge = QUALITY_BADGE[h.dataQuality.status];
              return (
                <tr
                  key={`${h.accountId}:${h.instrumentId}`}
                  className="cursor-pointer border-b border-line align-top hover:bg-gray-50"
                  onClick={() => setSelected({ accountId: h.accountId, instrumentId: h.instrumentId })}
                  role="button"
                  tabIndex={0}
                  aria-label={`View transaction detail for ${h.schemeName}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected({ accountId: h.accountId, instrumentId: h.instrumentId });
                    }
                  }}
                >
                  <td className="py-3 pr-4 font-medium text-ink">{h.schemeName}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.folioNumber ?? '—'}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.isin ?? '—'}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.registrar ?? '—'}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.costValue, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{num(h.unitBalance)}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.navDate ? fmtDate(h.navDate) : '—'}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{num(h.nav, 4)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.marketValue, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.gainLoss, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{pct(h.returnPct)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">
                    {h.xirr.status === 'CALCULATED' && h.xirr.value ? pct(h.xirr.value.rate) : '—'}
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${badge.className}`} title={h.dataQuality.detail ?? undefined}>
                      {badge.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TransactionDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        accountId={selected?.accountId ?? null}
        instrumentId={selected?.instrumentId ?? null}
      />
    </section>
  );
}
